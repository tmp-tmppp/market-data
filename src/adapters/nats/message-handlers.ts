import { readProjectionEvent, storedMarketOf } from "../../domain/consumed.js";
import { readTenantCreated } from "../../domain/tenant.js";
import type { Logger, ParkedEvent } from "../../usecases/ports.js";
import type { ProvisionTenantUseCase, RecordProjectionEventUseCase } from "../../usecases/use-cases.js";

// What a consumer does with one message, without any NATS type, so that the rules are unit-tested (ADR-053 inbox).
// The consumer acknowledges a message only after the handler returned "ack", which is after the transaction of the use
// case committed; an error is a "nak" with its reason, and after PARK_AFTER_DELIVERIES of them the message is parked.
// On the MARKETS and TRADING subjects nothing is acknowledged without being stored in consumed_events or parked in
// shared.parked_events (ADR-058): the replay source must never lose an event silently.

/**
 * What the consumer does with the message: acknowledge it, ask the broker to deliver it again later, or park it at once
 * (a message that no number of deliveries can store: `npm run parked --retry` runs it again after a fix).
 */
export type HandleResult = { kind: "ack" } | { kind: "nak"; reason: string } | { kind: "park"; reason: string };

const ACK: HandleResult = { kind: "ack" };

const MAX_REASON_LENGTH = 500;

/** The error code and message of a failure, for the log, the parked row and the next delivery: never a token or a body. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, MAX_REASON_LENGTH);
  // UseCaseError and DomainError carry a stable `code`; a database error carries its SQLSTATE; the rest has its name.
  const { code } = error as Error & { code?: unknown };
  const label = typeof code === "string" && code !== "" ? code : error.name;
  return `${label}: ${error.message}`.slice(0, MAX_REASON_LENGTH);
}

/** The message body as text; a NUL character is replaced because a PostgreSQL text column cannot hold it. */
export const payloadText = (data: Uint8Array): string => new TextDecoder().decode(data).replaceAll("\u0000", "�");

function parseBody(data: Uint8Array): { ok: true; body: unknown } | { ok: false } {
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(data)) as unknown };
  } catch {
    return { ok: false };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a key or a string value of the parsed JSON holds a NUL character (the escape \u0000). The CloudEvent is
 * stored in a jsonb column, which refuses that character, so such a message would fail every delivery; it is parked at
 * once instead. Iterative, so a deeply nested body cannot exhaust the stack.
 */
export function containsNul(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes("\u0000")) return true;
    } else if (Array.isArray(current)) {
      pending.push(...(current as unknown[]));
    } else if (isRecord(current)) {
      for (const [key, inner] of Object.entries(current)) {
        if (key.includes("\u0000")) return true;
        pending.push(inner);
      }
    }
  }
  return false;
}

/** A well-formed event of a type market-data does not act on is normal on a wide filter; anything else wrong with a message is a warning. */
function logIgnored(logger: Logger, stream: string, event: { reason: string; eventId: string | null }): void {
  const fields = { eventId: event.eventId, reason: event.reason };
  if (event.reason.startsWith("Unknown event type")) logger.info(fields, `A message of the ${stream} stream is not an event market-data acts on; it is acknowledged and skipped`);
  else logger.warn(fields, `A message of the ${stream} stream is not a usable event; it is acknowledged and skipped`);
}

/**
 * One message of the TENANTS stream.
 *  - A message that is not JSON, not a CloudEvent 1.0, of another type or malformed: a warning and "ack". A poison
 *    message must never block the consumer, and redelivering it would change nothing. (TenantCreated is not a replay
 *    input: ensureTenant covers a tenant whose event was missed.)
 *  - TenantCreated: the use case records the event id in the inbox, creates and migrates the tenant's schema and
 *    registers it, in one transaction. "provisioned" and "duplicate" (a redelivery) both end in "ack".
 *  - Any error of the use case (database down, a migration failing): an error log and "nak" with the reason, so the
 *    broker delivers it again after a delay. The transaction was rolled back, so nothing is half done.
 */
export async function handleTenantCreatedMessage(data: Uint8Array, provision: ProvisionTenantUseCase, logger: Logger): Promise<HandleResult> {
  const parsed = parseBody(data);
  if (!parsed.ok) {
    logger.warn({ bytes: data.byteLength }, "A message of the TENANTS stream is not JSON; it is acknowledged and skipped");
    return ACK;
  }
  const event = readTenantCreated(parsed.body);
  if (event.kind === "ignored") {
    logIgnored(logger, "TENANTS", event);
    return ACK;
  }
  const { notice } = event;
  try {
    const result = await provision.execute(notice);
    logger.info({ tenantId: notice.tenantId, eventId: notice.eventId, correlationId: notice.correlationId, result }, "TenantCreated handled");
    return ACK;
  } catch (error) {
    logger.error(
      { tenantId: notice.tenantId, eventId: notice.eventId, correlationId: notice.correlationId, err: error },
      "TenantCreated could not be processed; it will be delivered again",
    );
    return { kind: "nak", reason: describeError(error) };
  }
}

/**
 * One message of the MARKETS stream (filter chance.markets.>) or of the TRADING stream (TradeExecuted): the same rules,
 * because both feed the replay source.
 *  - Not JSON, not a JSON object, a body with a NUL character, or an envelope that cannot be attributed to a tenant (not
 *    a CloudEvent 1.0, no UUID id or tenantid, no type): "park" at once with the reason. Nothing can store it in a tenant
 *    schema, and `npm run parked --retry` runs it again after a fix.
 *  - A projection event, or an unprojected one (another type of the stream, a later type version, a value this reader
 *    rejects): the use case stores it in consumed_events in one transaction with the inbox entry and, for a projection
 *    event, the projections; the message is acknowledged after the commit. An unreadable event is a warning with its
 *    reason, since a later reader recovers it with a replay; another type is the normal case.
 *  - Any error of the use case: "nak" with the reason; the delivery number PARK_AFTER_DELIVERIES parks it.
 */
export async function handleProjectionMessage(data: Uint8Array, record: RecordProjectionEventUseCase, logger: Logger): Promise<HandleResult> {
  const parsed = parseBody(data);
  if (!parsed.ok) {
    logger.warn({ bytes: data.byteLength }, "A message is not JSON; it is parked");
    return { kind: "park", reason: "The message is not JSON" };
  }
  const { body } = parsed;
  if (!isRecord(body)) {
    logger.warn({ bytes: data.byteLength }, "A message is not a JSON object; it is parked");
    return { kind: "park", reason: "The message is not a JSON object" };
  }
  const event = readProjectionEvent(body);
  if (event.kind === "unattributable") {
    logger.warn({ eventId: event.eventId, reason: event.reason }, "A message cannot be attributed to a tenant; it is parked");
    return { kind: "park", reason: event.reason };
  }
  if (containsNul(body)) {
    const reason = "The event holds a NUL character, which the jsonb copy in consumed_events cannot store";
    logger.warn({ eventId: event.eventId, tenantId: event.tenantId, reason }, "An event cannot be stored; it is parked");
    return { kind: "park", reason };
  }
  const fields = { tenantId: event.tenantId, eventId: event.eventId, marketId: storedMarketOf(event), eventType: event.eventType, correlationId: event.correlationId };
  try {
    const result = await record.execute({ event, raw: body });
    if (event.kind === "unprojected" && event.cause === "unreadable") {
      logger.warn({ ...fields, result, reason: event.reason }, "An event this version cannot read was stored for a later replay");
    } else {
      logger.info({ ...fields, result }, "A market event was handled");
    }
    return ACK;
  } catch (error) {
    logger.error({ ...fields, err: error }, "A market event could not be processed; it will be delivered again");
    return { kind: "nak", reason: describeError(error) };
  }
}

/** The part of a JetStream message the settle step needs (a `JsMsg` fits). */
export interface SettleableMessage {
  /** The stream sequence: unique per stream, known even for a body that is not JSON. */
  seq: number;
  subject: string;
  data: Uint8Array;
  info: { deliveryCount: number };
  ack(): void;
  nak(millis?: number): void;
}

export interface SettleOptions {
  /** The inbox name of the consumer ("tenant-created", "market-events", "trade-events"). */
  consumer: string;
  /** Deliveries after which a failing message is parked (PARK_AFTER_DELIVERIES). */
  parkAfter: number;
  nakDelayMs: number;
  park: (event: ParkedEvent) => Promise<void>;
  logger: Logger;
  now: () => Date;
}

/**
 * Applies a handler's result to the message. "ack" acknowledges it. "park" writes it to the parked events and
 * acknowledges it at once. A "nak" asks for a new delivery after `nakDelayMs`, unless this was already delivery number
 * `parkAfter` or later: then the message is parked and acknowledged, so one failing event never holds back the other
 * markets or tenants of its stream. When parking fails too (the database is down) the message is nak'd and stays on the
 * broker, which never drops it (max_deliver unlimited).
 */
export async function settleMessage(message: SettleableMessage, result: HandleResult, options: SettleOptions): Promise<"acked" | "naked" | "parked"> {
  if (result.kind === "ack") {
    message.ack();
    return "acked";
  }
  const deliveries = message.info.deliveryCount;
  if (result.kind === "park" || deliveries >= options.parkAfter) {
    const fields = { consumer: options.consumer, streamSequence: message.seq, subject: message.subject, deliveries };
    try {
      await options.park({
        consumer: options.consumer,
        streamSequence: message.seq,
        subject: message.subject,
        payload: payloadText(message.data),
        reason: result.reason,
        deliveries,
        parkedAt: options.now(),
      });
      const text =
        result.kind === "park"
          ? "A message cannot be stored; it was parked and acknowledged (npm run parked lists it)"
          : "An event failed too many deliveries; it was parked and acknowledged (npm run parked lists it)";
      options.logger.error({ ...fields, reason: result.reason }, text);
      message.ack();
      return "parked";
    } catch (error) {
      options.logger.error({ ...fields, err: error }, "An event could not be parked; it will be delivered again");
    }
  }
  message.nak(options.nakDelayMs);
  return "naked";
}
