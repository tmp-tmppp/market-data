import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { connect, nanos } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/transport-node";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JetStreamConsumer, MARKETS_CONSUMER, TENANTS_CONSUMER, TRADING_CONSUMER } from "../../src/adapters/nats/jetstream-consumer.js";
import type { ConsumerSpec } from "../../src/adapters/nats/jetstream-consumer.js";
import { handleProjectionMessage, handleTenantCreatedMessage } from "../../src/adapters/nats/message-handlers.js";
import type { HandleResult } from "../../src/adapters/nats/message-handlers.js";
import type { TenantCreatedNotice } from "../../src/domain/tenant.js";
import type { ParkedEvent } from "../../src/usecases/ports.js";
import type { ProvisionResult, RecordProjectionEventInput, RecordResult } from "../../src/usecases/use-cases.js";
import { MARKET_1, RecordingLogger, TENANT_A, TENANT_B, marketClosedBody, marketOpenedBody, tenantCreatedBody, tradeExecutedBody } from "../support/fakes.js";

// These tests need a running Docker daemon: "npm run test:integration". They run against a real NATS server with
// JetStream, because the stream and consumer calls of the broker are what the consumer adapter consists of.

let container: StartedTestContainer;
let url: string;
let nc: NatsConnection;
let jsm: JetStreamManager;
let js: JetStreamClient;

beforeAll(async () => {
  container = await new GenericContainer("nats:2.15.2-alpine")
    .withCommand(["-js"])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  url = `nats://${container.getHost()}:${String(container.getMappedPort(4222))}`;
  nc = await connect({ servers: url });
  jsm = await jetstreamManager(nc);
  js = jetstream(nc);
}, 180_000);

afterAll(async () => {
  await nc?.drain().catch(() => undefined);
  await container?.stop();
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor: the condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const isStreamMissing = (error: unknown): boolean => error instanceof JetStreamApiError && error.apiError().err_code === JetStreamApiCodes.StreamNotFound;

async function deleteStream(name: string): Promise<void> {
  try {
    await jsm.streams.delete(name);
  } catch (error) {
    if (!isStreamMissing(error)) throw error;
  }
}

const publish = (subject: string, body: unknown): Promise<unknown> => js.publish(subject, new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)));

const SPECS = [TENANTS_CONSUMER, MARKETS_CONSUMER, TRADING_CONSUMER];

/** What the consumer hands to its handler; the first `failures` calls answer nak, like a use case that cannot commit. */
class RecordingHandler {
  readonly bodies: string[] = [];
  failures = 0;
  /** Only bodies that start with this text count against `failures` (the messages are not handled in a fixed order once one of them is nak'd). */
  failPrefix = "";
  /** A body that starts with this text is parked at once. */
  parkPrefix: string | null = null;
  readonly handle = (data: Uint8Array): Promise<HandleResult> => {
    const body = new TextDecoder().decode(data);
    this.bodies.push(body);
    if (this.parkPrefix !== null && body.startsWith(this.parkPrefix)) return Promise.resolve({ kind: "park", reason: "cannot be stored" });
    if (this.failures > 0 && body.startsWith(this.failPrefix)) {
      this.failures -= 1;
      return Promise.resolve({ kind: "nak", reason: "database is down" });
    }
    return Promise.resolve({ kind: "ack" });
  };
}

describe("JetStreamConsumer", () => {
  let handler: RecordingHandler;
  let logger: RecordingLogger;
  let parked: ParkedEvent[];
  let parkFailures: number;
  let consumers: JetStreamConsumer[];

  const startConsumer = (spec: ConsumerSpec, options: Partial<ConstructorParameters<typeof JetStreamConsumer>[0]> = {}): JetStreamConsumer => {
    const consumer = new JetStreamConsumer({
      url,
      spec,
      handle: handler.handle,
      park: (event) => {
        if (parkFailures > 0) {
          parkFailures -= 1;
          return Promise.reject(new Error("database is down"));
        }
        parked.push(event);
        return Promise.resolve();
      },
      logger,
      nakDelayMs: 50,
      reconnectDelayMs: 50,
      ...options,
    });
    consumers.push(consumer);
    consumer.start();
    return consumer;
  };
  const createStream = (spec: ConsumerSpec, subjects: string[]) => jsm.streams.add({ name: spec.stream, subjects });
  const info = (spec: ConsumerSpec) => jsm.consumers.info(spec.stream, spec.durable);
  const settled = (spec: ConsumerSpec) => async (): Promise<boolean> => {
    const current = await info(spec);
    return current.num_ack_pending === 0 && current.num_pending === 0;
  };

  beforeEach(async () => {
    for (const spec of SPECS) await deleteStream(spec.stream);
    handler = new RecordingHandler();
    logger = new RecordingLogger();
    parked = [];
    parkFailures = 0;
    consumers = [];
  });
  afterEach(async () => {
    await Promise.all(consumers.map((consumer) => consumer.stop()));
  });

  it("uses the names of the convention: three streams, one durable called market-data, and the filters of the spec", () => {
    expect(SPECS.map((s) => [s.stream, s.durable, s.consumer, s.maxAckPending])).toEqual([
      ["TENANTS", "market-data", "tenant-created", 10],
      ["MARKETS", "market-data", "market-events", 10],
      ["TRADING", "market-data", "trade-events", 10],
    ]);
    expect(TENANTS_CONSUMER.filterSubjects).toEqual(["chance.tenants.TenantCreated.*"]);
    expect(MARKETS_CONSUMER.filterSubjects).toEqual(["chance.markets.>"]);
    expect(TRADING_CONSUMER.filterSubjects).toEqual(["chance.trading.TradeExecuted.*"]);
  });

  it.each([
    [TENANTS_CONSUMER, "chance.tenants.>"],
    [MARKETS_CONSUMER, "chance.markets.>"],
    [TRADING_CONSUMER, "chance.trading.>"],
  ])("creates the durable pull consumer on %#: explicit acks, deliver all, the filter, ack wait 30 s, max ack pending 10, unlimited deliveries", async (spec, subjects) => {
    await createStream(spec, [subjects]);

    startConsumer(spec);
    await waitFor(async () => (await jsm.consumers.info(spec.stream, spec.durable).catch(() => null)) !== null);

    const { config } = await info(spec);
    expect(config).toMatchObject({ durable_name: "market-data", ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, ack_wait: nanos(30_000), max_ack_pending: 10, max_deliver: -1 });
    expect([...(config.filter_subjects ?? [config.filter_subject])].sort()).toEqual([...spec.filterSubjects].sort());
  });

  it("brings a consumer that exists with another configuration to the spec", async () => {
    await createStream(TRADING_CONSUMER, ["chance.trading.>"]);
    await jsm.consumers.add(TRADING_CONSUMER.stream, {
      durable_name: TRADING_CONSUMER.durable,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: "chance.trading.>",
      ack_wait: nanos(5000),
      max_ack_pending: 100,
    });

    startConsumer(TRADING_CONSUMER, { ackWaitMs: 20_000 });
    await waitFor(async () => (await info(TRADING_CONSUMER)).config.max_ack_pending === 10);

    const { config } = await info(TRADING_CONSUMER);
    expect(config).toMatchObject({ ack_wait: nanos(20_000), max_ack_pending: 10, max_deliver: -1 });
    expect(config.filter_subject).toBe("chance.trading.TradeExecuted.*");
  });

  it("delivers only the filtered subjects of the TRADING stream, in order, from the first message", async () => {
    await createStream(TRADING_CONSUMER, ["chance.trading.>"]);
    await publish(`chance.trading.TradeExecuted.${TENANT_A}`, "first");
    await publish(`chance.trading.MarketSettled.${TENANT_A}`, "not ours");
    await publish(`chance.trading.TradeExecuted.${TENANT_B}`, "second");

    startConsumer(TRADING_CONSUMER);
    await waitFor(() => handler.bodies.length === 2);
    await waitFor(settled(TRADING_CONSUMER));

    expect(handler.bodies).toEqual(["first", "second"]);
    expect((await info(TRADING_CONSUMER)).ack_floor.stream_seq).toBe(3);
  });

  it("asks the broker to deliver again after a nak, and acknowledges when the handler works", async () => {
    await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
    handler.failures = 2;
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, "event");

    startConsumer(MARKETS_CONSUMER);
    await waitFor(() => handler.bodies.length === 3);
    await waitFor(settled(MARKETS_CONSUMER));

    expect(handler.bodies).toEqual(["event", "event", "event"]);
    expect(parked).toEqual([]);
  });

  it("parks a message after parkAfter failed deliveries, acknowledges it, and the next message still arrives", async () => {
    await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
    handler.failures = 3;
    handler.failPrefix = '{"stuck';
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, '{"stuck":true}');
    await publish(`chance.markets.MarketClosed.${TENANT_B}`, "next");

    startConsumer(MARKETS_CONSUMER, { parkAfter: 3 });
    await waitFor(() => parked.length === 1);
    await waitFor(() => handler.bodies.includes("next"));
    await waitFor(settled(MARKETS_CONSUMER));

    // The next message is handled while the stuck one waits for its redelivery: another market's event is not held back.
    expect(handler.bodies.filter((body) => body !== "next")).toEqual(['{"stuck":true}', '{"stuck":true}', '{"stuck":true}']);
    expect(handler.bodies.indexOf("next")).toBeLessThan(handler.bodies.lastIndexOf('{"stuck":true}'));
    expect(parked).toEqual([
      {
        consumer: "market-events",
        streamSequence: 1,
        subject: `chance.markets.MarketClosed.${TENANT_A}`,
        payload: '{"stuck":true}',
        reason: "database is down",
        deliveries: 3,
        parkedAt: expect.any(Date) as Date,
      },
    ]);
    expect((await info(MARKETS_CONSUMER)).ack_floor.stream_seq).toBe(2);
  });

  it("parks a message at once on a park result, at its first delivery, and acknowledges it", async () => {
    await createStream(TRADING_CONSUMER, ["chance.trading.>"]);
    handler.parkPrefix = "{broken";
    await publish(`chance.trading.TradeExecuted.${TENANT_A}`, "{broken json");
    await publish(`chance.trading.TradeExecuted.${TENANT_A}`, "fine");

    startConsumer(TRADING_CONSUMER);
    await waitFor(() => parked.length === 1);
    await waitFor(settled(TRADING_CONSUMER));

    expect(handler.bodies).toEqual(["{broken json", "fine"]);
    expect(parked[0]).toMatchObject({ consumer: "trade-events", streamSequence: 1, payload: "{broken json", reason: "cannot be stored", deliveries: 1 });
    expect((await info(TRADING_CONSUMER)).ack_floor.stream_seq).toBe(2);
  });

  it("keeps a message on the broker while parking fails, and parks it when the database is back", async () => {
    await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
    handler.failures = 100;
    parkFailures = 2;
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, "stuck");

    startConsumer(MARKETS_CONSUMER, { parkAfter: 2 });
    await waitFor(() => parked.length === 1);
    await waitFor(settled(MARKETS_CONSUMER));

    expect(parked[0]?.deliveries).toBeGreaterThanOrEqual(4);
    expect(logger.lines.filter((line) => line.message === "An event could not be parked; it will be delivered again")).toHaveLength(2);
  });

  it("remembers its position across a restart: acknowledged events are not handled again", async () => {
    await createStream(TENANTS_CONSUMER, ["chance.tenants.>"]);
    await publish(`chance.tenants.TenantCreated.${TENANT_A}`, "one");
    const first = startConsumer(TENANTS_CONSUMER);
    await waitFor(() => handler.bodies.length === 1);
    await waitFor(settled(TENANTS_CONSUMER));
    await first.stop();

    await publish(`chance.tenants.TenantCreated.${TENANT_B}`, "two");
    startConsumer(TENANTS_CONSUMER);
    await waitFor(() => handler.bodies.length === 2);
    await waitFor(settled(TENANTS_CONSUMER));

    expect(handler.bodies).toEqual(["one", "two"]);
  });

  it("starts without the stream, says so, and picks the events up when the stream appears", async () => {
    startConsumer(TRADING_CONSUMER);
    await waitFor(() => logger.messages("warn").includes("The TRADING stream does not exist yet; trying again"));
    expect(handler.bodies).toEqual([]);

    await createStream(TRADING_CONSUMER, ["chance.trading.>"]);
    await publish(`chance.trading.TradeExecuted.${TENANT_A}`, "late");
    await waitFor(() => handler.bodies.length === 1);

    expect(handler.bodies).toEqual(["late"]);
  });

  it("goes on consuming after the stream was deleted and created again while the service runs (abort_on_missing_resource)", async () => {
    await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, "before");
    startConsumer(MARKETS_CONSUMER);
    await waitFor(() => handler.bodies.length === 1);
    await waitFor(settled(MARKETS_CONSUMER));

    await jsm.streams.delete(MARKETS_CONSUMER.stream);
    await createStream(MARKETS_CONSUMER, ["chance.markets.>"]);
    await publish(`chance.markets.MarketClosed.${TENANT_B}`, "after");
    await waitFor(() => handler.bodies.length === 2);

    expect(handler.bodies).toEqual(["before", "after"]);
  });

  it("creates the durable consumer again when it was deleted while the service runs", async () => {
    await createStream(TRADING_CONSUMER, ["chance.trading.>"]);
    startConsumer(TRADING_CONSUMER);
    await waitFor(async () => (await jsm.consumers.info(TRADING_CONSUMER.stream, TRADING_CONSUMER.durable).catch(() => null)) !== null);

    await jsm.consumers.delete(TRADING_CONSUMER.stream, TRADING_CONSUMER.durable);
    await publish(`chance.trading.TradeExecuted.${TENANT_A}`, "after the delete");
    await waitFor(() => handler.bodies.length === 1, 40_000);

    expect(handler.bodies).toEqual(["after the delete"]);
  });

  it("stop() ends the loop and leaves the consumer on the broker", async () => {
    await createStream(TRADING_CONSUMER, ["chance.trading.>"]);
    const consumer = startConsumer(TRADING_CONSUMER);
    await waitFor(async () => (await jsm.consumers.info(TRADING_CONSUMER.stream, TRADING_CONSUMER.durable).catch(() => null)) !== null);

    await consumer.stop();
    await publish(`chance.trading.TradeExecuted.${TENANT_A}`, "nobody listens");

    expect((await info(TRADING_CONSUMER)).num_pending).toBe(1);
    expect(handler.bodies).toEqual([]);
  });
});

/** The real handlers on the real consumers: what the service wires in main. */
describe("the handlers on the consumers", () => {
  let logger: RecordingLogger;
  let consumers: JetStreamConsumer[];
  let parked: ParkedEvent[];

  beforeEach(async () => {
    for (const spec of SPECS) await deleteStream(spec.stream);
    logger = new RecordingLogger();
    consumers = [];
    parked = [];
  });
  afterEach(async () => {
    await Promise.all(consumers.map((consumer) => consumer.stop()));
  });

  const start = (spec: ConsumerSpec, handle: (data: Uint8Array) => Promise<HandleResult>): void => {
    const consumer = new JetStreamConsumer({
      url,
      spec,
      handle,
      park: (event) => {
        parked.push(event);
        return Promise.resolve();
      },
      logger,
      nakDelayMs: 50,
      reconnectDelayMs: 50,
    });
    consumers.push(consumer);
    consumer.start();
  };
  const recordingUseCase = (inputs: RecordProjectionEventInput[]) => ({
    execute: (input: RecordProjectionEventInput): Promise<RecordResult> => {
      inputs.push(input);
      return Promise.resolve(input.event.kind === "unprojected" ? "unprojected" : "applied");
    },
  });
  const ackFloor = async (stream: string): Promise<number> => (await jsm.consumers.info(stream, "market-data")).ack_floor.stream_seq;
  const pending = async (stream: string): Promise<number> => (await jsm.consumers.info(stream, "market-data")).num_ack_pending;

  it("TenantCreated reaches the provisioning use case", async () => {
    await jsm.streams.add({ name: "TENANTS", subjects: ["chance.tenants.>"] });
    const notices: TenantCreatedNotice[] = [];
    const provision = {
      execute: (notice: TenantCreatedNotice): Promise<ProvisionResult> => {
        notices.push(notice);
        return Promise.resolve("provisioned");
      },
    };
    start(TENANTS_CONSUMER, (data) => handleTenantCreatedMessage(data, provision, logger));
    const body = tenantCreatedBody(TENANT_A, "00000000-0000-7000-8000-00000000c001");
    await publish(`chance.tenants.TenantCreated.${TENANT_A}`, body);

    await waitFor(() => notices.length === 1);
    expect(notices[0]).toMatchObject({ eventId: "00000000-0000-7000-8000-00000000c001", tenantId: TENANT_A });
  });

  it("MARKETS: every message with an envelope reaches the use case, an event of another type too (it is stored, unprojected); one with no tenant is parked at once", async () => {
    await jsm.streams.add({ name: "MARKETS", subjects: ["chance.markets.>"] });
    const inputs: RecordProjectionEventInput[] = [];
    start(MARKETS_CONSUMER, (data) => handleProjectionMessage(data, recordingUseCase(inputs), logger));
    await publish(`chance.markets.MarketCreated.${TENANT_A}`, { ...marketOpenedBody(), type: "si.chance.markets.MarketCreated.v1" });
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, marketClosedBody({ version: 3 }));
    await publish(`chance.markets.MarketClosed.${TENANT_A}`, { ...marketClosedBody(), tenantid: undefined });

    await waitFor(() => inputs.length === 2 && parked.length === 1);
    await waitFor(async () => (await pending("MARKETS")) === 0);
    expect(inputs.map((input) => input.event.kind)).toEqual(["unprojected", "market_closed"]);
    expect(inputs[1]?.event).toMatchObject({ tenantId: TENANT_A, facts: { marketId: MARKET_1, version: 3 } });
    expect(parked[0]).toMatchObject({ consumer: "market-events", streamSequence: 3, deliveries: 1 });
    expect(await ackFloor("MARKETS")).toBe(3);
  });

  it("TRADING: a trade reaches the use case, a later type version is stored as unprojected, a body that is not JSON is parked at once", async () => {
    await jsm.streams.add({ name: "TRADING", subjects: ["chance.trading.>"] });
    const inputs: RecordProjectionEventInput[] = [];
    start(TRADING_CONSUMER, (data) => handleProjectionMessage(data, recordingUseCase(inputs), logger));
    await publish(`chance.trading.TradeExecuted.${TENANT_A}`, tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 450_000 }));
    await publish(`chance.trading.TradeExecuted.${TENANT_A}`, { ...tradeExecutedBody({ tradeSequence: 2, yesPriceMicro: 460_000 }), type: "si.chance.trading.TradeExecuted.v2" });
    await publish(`chance.trading.TradeExecuted.${TENANT_A}`, "not json");

    await waitFor(() => inputs.length === 2 && parked.length === 1);
    await waitFor(async () => (await pending("TRADING")) === 0);
    expect(inputs.map((input) => input.event.kind)).toEqual(["trade_executed", "unprojected"]);
    expect(inputs[1]?.event).toMatchObject({ cause: "unreadable" });
    expect(parked[0]).toMatchObject({ consumer: "trade-events", streamSequence: 3, payload: "not json", reason: "The message is not JSON" });
    expect(await ackFloor("TRADING")).toBe(3);
  });
});
