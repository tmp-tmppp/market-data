import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { ConsumerMessages, JetStreamManager } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import type { Logger, ParkedEvent } from "../../usecases/ports.js";
import { CONSUMER_MAX_ACK_PENDING, MARKET_EVENTS_CONSUMER, PARK_AFTER_DELIVERIES, TENANT_CREATED_CONSUMER, TRADE_EVENTS_CONSUMER } from "../../usecases/support.js";
import { settleMessage } from "./message-handlers.js";
import type { HandleResult } from "./message-handlers.js";

/** One durable consumer of another service's stream. */
export interface ConsumerSpec {
  /** The stream it reads: TENANTS, MARKETS or TRADING. */
  stream: string;
  /** The durable name: the broker remembers the position of this consumer under it, across restarts. */
  durable: string;
  filterSubjects: string[];
  maxAckPending: number;
  /** The name of its entries in shared.inbox and of its parked events. */
  consumer: string;
}

// The consumers' settings are fixed by the spec, as trading's after its review: durable pull consumers, deliver all (an
// event from before market-data existed is not missed as long as the stream keeps it: 30 days by default), explicit acks, ack wait
// 30 s, a small max ack pending (the projection rules commute, so events need no strict order), max_deliver unlimited
// (the broker never drops an event; PARK_AFTER_DELIVERIES parks the stuck one). Several replicas share each durable
// consumer as a work queue.
export const TENANTS_CONSUMER: ConsumerSpec = {
  stream: "TENANTS",
  durable: "market-data",
  filterSubjects: ["chance.tenants.TenantCreated.*"],
  maxAckPending: CONSUMER_MAX_ACK_PENDING,
  consumer: TENANT_CREATED_CONSUMER,
};

/** The whole MARKETS stream: every message with a usable envelope goes to consumed_events, projected or not (ADR-058). */
export const MARKETS_CONSUMER: ConsumerSpec = {
  stream: "MARKETS",
  durable: "market-data",
  filterSubjects: ["chance.markets.>"],
  maxAckPending: CONSUMER_MAX_ACK_PENDING,
  consumer: MARKET_EVENTS_CONSUMER,
};

/** TradeExecuted of every tenant, any version of the type (a later one is stored as unprojected). */
export const TRADING_CONSUMER: ConsumerSpec = {
  stream: "TRADING",
  durable: "market-data",
  filterSubjects: ["chance.trading.TradeExecuted.*"],
  maxAckPending: CONSUMER_MAX_ACK_PENDING,
  consumer: TRADE_EVENTS_CONSUMER,
};

export interface JetStreamConsumerOptions {
  url: string;
  spec: ConsumerSpec;
  /** The rules for one message body (message-handlers.ts); it returns "ack" only after the use case committed. */
  handle: (data: Uint8Array) => Promise<HandleResult>;
  /** Writes a message that failed `parkAfter` deliveries, or that a handler parks at once, to shared.parked_events (ParkedEventRepository.park). */
  park: (event: ParkedEvent) => Promise<void>;
  logger: Logger;
  /** Deliveries after which a failing message is parked. Default PARK_AFTER_DELIVERIES (20). */
  parkAfter?: number;
  /** How long the broker waits for an acknowledgement before it delivers a message again. Default 30 s. */
  ackWaitMs?: number;
  /** Delay of the next delivery after an error. Default 5 s. */
  nakDelayMs?: number;
  /** Wait before the consumer connects again after a failure, or while the stream does not exist yet. Default 5 s. */
  reconnectDelayMs?: number;
}

const isConsumerMissing = (error: unknown): boolean =>
  error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.ConsumerNotFound;

const isStreamMissing = (error: unknown): boolean =>
  error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.StreamNotFound;

/**
 * A durable pull consumer of a stream of another service (ADR-053): the consumer is created, or brought to the spec's
 * configuration, on every connect, as the publisher does for its stream.
 *
 * The service starts and serves without it: a missing stream (the other service may start later), a refused connection
 * or a failed consumer is logged and tried again after `reconnectDelayMs`. Messages are handled one at a time, in
 * order; a message is acknowledged only after the handler returned "ack", which is after the commit. "nak" asks for a
 * new delivery after `nakDelayMs`; the delivery number `parkAfter` parks the message instead, and a "park" result parks
 * it at once (settleMessage), so one failing event never holds back the others. stop() finishes the message in hand.
 */
export class JetStreamConsumer {
  private nc: NatsConnection | null = null;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private active: ConsumerMessages | null = null;
  private wake: (() => void) | null = null;
  private readonly parkAfter: number;
  private readonly ackWaitMs: number;
  private readonly nakDelayMs: number;
  private readonly reconnectDelayMs: number;

  constructor(private readonly options: JetStreamConsumerOptions) {
    this.parkAfter = options.parkAfter ?? PARK_AFTER_DELIVERIES;
    this.ackWaitMs = options.ackWaitMs ?? 30_000;
    this.nakDelayMs = options.nakDelayMs ?? 5000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5000;
  }

  /** Starts the loop; returns at once and never throws. */
  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /** Stops the loop, waits for the message in progress and closes the connection. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    this.active?.stop();
    await this.loop;
    this.loop = null;
    const nc = this.nc;
    this.nc = null;
    if (nc && !nc.isClosed()) await nc.drain().catch(() => undefined);
  }

  private async ensureConsumer(manager: JetStreamManager): Promise<void> {
    const { stream, durable, filterSubjects, maxAckPending } = this.options.spec;
    // One filter goes in "filter_subject", several in "filter_subjects": the broker refuses both at once, and an update
    // merges into the stored configuration, so the key that is not used is set to undefined explicitly.
    const [onlyFilter] = filterSubjects;
    const filters =
      filterSubjects.length === 1 && onlyFilter !== undefined
        ? { filter_subject: onlyFilter, filter_subjects: undefined }
        : { filter_subject: undefined, filter_subjects: filterSubjects };
    const settings = { ack_wait: nanos(this.ackWaitMs), max_ack_pending: maxAckPending, max_deliver: -1, ...filters };
    try {
      await manager.consumers.info(stream, durable);
    } catch (error) {
      // A missing stream also throws here and is left to the loop, which logs it and tries again.
      if (!isConsumerMissing(error)) throw error;
      await manager.consumers.add(stream, { durable_name: durable, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, ...settings });
      return;
    }
    await manager.consumers.update(stream, durable, settings);
  }

  private async run(): Promise<void> {
    const { url, spec, handle, park, logger } = this.options;
    const { stream, durable, filterSubjects, maxAckPending, consumer: inbox } = spec;
    let failures = 0;
    while (!this.stopping) {
      try {
        const nc = this.nc && !this.nc.isClosed() ? this.nc : await connect({ servers: url, name: `market-data-consumer-${inbox}`, maxReconnectAttempts: -1 });
        this.nc = nc;
        await this.ensureConsumer(await jetstreamManager(nc));
        const consumer = await jetstream(nc).consumers.get(stream, durable);
        // By default consume() waits silently for a deleted consumer or stream to come back, and nothing here would bring it
        // back: with the abort option the loop ends, logs, and ensureConsumer() creates the consumer again.
        const messages = await consumer.consume({ max_messages: maxAckPending, abort_on_missing_resource: true });
        this.active = messages;
        // stop() may have been called while the consumer was being set up: it saw no active messages then.
        if (this.stopping) messages.stop();
        failures = 0;
        logger.info({ stream, durable, filters: filterSubjects }, "Consuming events");
        try {
          for await (const message of messages) {
            const result = await handle(message.data);
            await settleMessage(message, result, { consumer: inbox, parkAfter: this.parkAfter, nakDelayMs: this.nakDelayMs, park, logger, now: () => new Date() });
          }
        } finally {
          this.active = null;
        }
      } catch (error) {
        failures += 1;
        const text = isStreamMissing(error) ? `The ${stream} stream does not exist yet; trying again` : `The ${stream} consumer failed; trying again`;
        logger.warn({ stream, durable, attempt: failures, err: error }, text);
      }
      if (!this.stopping) await this.sleep(this.reconnectDelayMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wake = finish;
    });
  }
}
