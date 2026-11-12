import { DomainError } from "./errors.js";
import { isTenantId } from "./tenant.js";
import { decimalPriceToMicro, isMicroQuantity, isOutcome, isYesPriceMicro } from "./units.js";
import type { Outcome } from "./units.js";

// The events market-data consumes from the MARKETS and TRADING streams (plan 6.3), read defensively. Unknown fields are
// ignored (a new optional field of a publisher never breaks this consumer). The tenant comes from
// the "tenantid" attribute, never from the data alone (plan section 9). A message has one of three outcomes (ADR-058):
// - a projection event: one of the four types below with every field valid; it is stored and applied;
// - "unprojected": the envelope is usable (CloudEvent 1.0, UUID id and tenantid, a type), but this version of the reader
//   does not project it, either because it is another type of the stream (cause "other_type") or because it belongs to
//   a projection family and this reader cannot read it (cause "unreadable": a later type version such as
//   TradeExecuted.v2, a value outside the publisher's contract, data.tenantId differing from tenantid). It is STILL
//   stored in consumed_events, so a later reader recovers it with a replay: the replay source holds every consumed
//   event, not only the ones this version accepts (DM-09, ADR-032);
// - "unattributable": no usable envelope (not a JSON object, not a CloudEvent 1.0, no UUID id or tenantid, no type). It
//   cannot be stored in a tenant's schema, so the consumer parks it in shared.parked_events at once (never lost).
// The same reader turns the stored copies back into events when the projections are rebuilt (DM-09, ADR-032), so live
// consumption and the replay apply exactly the same facts.
// markets: contracts/asyncapi.yaml of markets (MarketOpened, MarketClosed, MarketResolved, stream MARKETS).
// trading: contracts/asyncapi.yaml of trading (TradeExecuted, stream TRADING).

export const MARKET_OPENED_TYPE = "si.chance.markets.MarketOpened.v1";
export const MARKET_CLOSED_TYPE = "si.chance.markets.MarketClosed.v1";
export const MARKET_RESOLVED_TYPE = "si.chance.markets.MarketResolved.v1";
export const TRADE_EXECUTED_TYPE = "si.chance.trading.TradeExecuted.v1";

/** The event types this version projects. Every consumed event with a usable envelope is stored, these and others. */
export const PROJECTION_EVENT_TYPES = [MARKET_OPENED_TYPE, MARKET_CLOSED_TYPE, MARKET_RESOLVED_TYPE, TRADE_EXECUTED_TYPE] as const;
export type ProjectionEventType = (typeof PROJECTION_EVENT_TYPES)[number];

export const LIFECYCLE_EVENT_TYPES: readonly ProjectionEventType[] = [MARKET_OPENED_TYPE, MARKET_CLOSED_TYPE, MARKET_RESOLVED_TYPE];

/** Any version of a projected type: a version this reader does not know is "unreadable", never "other_type". */
const PROJECTION_FAMILY = /^si\.chance\.(markets\.Market(Opened|Closed|Resolved)|trading\.TradeExecuted)\.v[0-9]+$/;

/** The longest `type` stored (consumed_events.event_type CHECK); a longer one is unattributable. */
export const EVENT_TYPE_MAX_LENGTH = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** The longest question markets accepts (its contract: 10..200 characters); the read model's CHECK holds the same bound. */
export const QUESTION_MAX_LENGTH = 200;

/**
 * A question's length in characters as markets and PostgreSQL's char_length count them: code points, so an emoji is one
 * character, not the two UTF-16 units of String.length.
 */
export function questionLength(text: string): number {
  return [...text].length;
}

/** A market id is a UUID (markets issues UUIDv7). */
export function isMarketId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Returns the market id in lower case, or throws a DomainError that names the field. */
export function parseMarketId(value: unknown, field = "marketId"): string {
  if (!isMarketId(value)) throw new DomainError("invalid_market_id", `${field} must be a UUID`, field);
  return value.toLowerCase();
}

/** Whether `type` is a version of one of the four projected types (known to this reader or not). */
export function isProjectionFamily(type: string): boolean {
  return PROJECTION_FAMILY.test(type);
}

/** The envelope of every stored event: the inbox and consumed_events key, the type, the tenant and the ids for tracing. */
export interface StoredEnvelope {
  /** The CloudEvent id, lower case: the key of the inbox and of consumed_events. */
  eventId: string;
  /** The CloudEvent type as received (1..EVENT_TYPE_MAX_LENGTH characters). */
  eventType: string;
  /** From "tenantid", lower case. */
  tenantId: string;
  /** From "correlationid"; null when the event has none. */
  correlationId: string | null;
}

/** The envelope of a projection event: its type is one this version projects. */
export interface ConsumedEnvelope extends StoredEnvelope {
  eventType: ProjectionEventType;
}

/** MarketOpened: the market's static facts; the price series starts at the starting price (plan 6.3). */
export interface OpenedFacts {
  marketId: string;
  /** markets' version of the market (DM-04). */
  version: number;
  /** Trimmed, 1 to QUESTION_MAX_LENGTH code points. */
  question: string;
  closeTime: Date;
  /** markets' `startingPrice` (YES, two decimals) in microcredits per share. */
  startingPriceYesMicro: number;
  openedAt: Date;
}

export interface ClosedFacts {
  marketId: string;
  version: number;
  closedAt: Date;
}

export interface ResolvedFacts {
  marketId: string;
  version: number;
  outcome: Outcome;
  resolvedAt: Date;
}

/** TradeExecuted as the read model needs it (trading's contract names the other fields, which are ignored). */
export interface TradeFacts {
  marketId: string;
  /** The market's trade sequence after this trade: 1, 2, 3 ... per market, without gaps (trading's contract). */
  tradeSequence: number;
  /** `yesPriceMicro`: the trade's last price as the price of YES (10 000 .. 990 000, trading's contract). */
  priceYesMicro: number;
  /**
   * `costMicro`: the credits the trade moved, in microcredits (the volume of the price point). A sale (trading's
   * `kind: "sale"`, UC-08) is published as the buy of the other side it makes, so it counts what that buy cost.
   */
  volumeMicro: number;
  executedAt: Date;
}

export type ProjectionEvent =
  | (ConsumedEnvelope & { kind: "market_opened"; facts: OpenedFacts })
  | (ConsumedEnvelope & { kind: "market_closed"; facts: ClosedFacts })
  | (ConsumedEnvelope & { kind: "market_resolved"; facts: ResolvedFacts })
  | (ConsumedEnvelope & { kind: "trade_executed"; facts: TradeFacts });

/**
 * An event with a usable envelope that this version does not project: stored in consumed_events (a later reader can
 * replay it) and acknowledged. "other_type" is normal (MarketCreated and the other types of the MARKETS stream);
 * "unreadable" is logged as a warning and counted by the replay, whose switch it holds (ADR-058).
 */
export interface UnprojectedEvent extends StoredEnvelope {
  kind: "unprojected";
  cause: "other_type" | "unreadable";
  reason: string;
  /** data.marketId when it is a UUID (lower case), else null: stored for tracing and for the per-market index. */
  marketId: string | null;
}

/** No usable envelope: it cannot be stored in a tenant's schema; the consumer parks it at once. */
export interface UnattributableEvent {
  kind: "unattributable";
  reason: string;
  eventId: string | null;
}

/** What the consumer stores in consumed_events. */
export type ConsumedEvent = ProjectionEvent | UnprojectedEvent;

export type ReadResult = ConsumedEvent | UnattributableEvent;

export function isProjectionEvent(read: ReadResult): read is ProjectionEvent {
  return read.kind !== "unprojected" && read.kind !== "unattributable";
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

class Malformed extends Error {}

function fail(reason: string): never {
  throw new Malformed(reason);
}

function dateTime(data: Record<string, unknown>, name: string): Date {
  const value = data[name];
  if (typeof value !== "string" || !DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) fail(`data.${name} is not an RFC 3339 date-time`);
  return new Date(value);
}

function positiveInteger(data: Record<string, unknown>, name: string): number {
  const value = data[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`data.${name} must be a positive integer`);
  return value;
}

function marketId(data: Record<string, unknown>): string {
  const value = data["marketId"];
  if (!isMarketId(value)) fail("data.marketId is missing or not a UUID");
  return value.toLowerCase();
}

function unattributable(reason: string, eventId: string | null): UnattributableEvent {
  return { kind: "unattributable", reason, eventId };
}

/** Reads the CloudEvent envelope; returns it with the raw data, or the reason it cannot be attributed to a tenant. */
function envelopeOf(body: unknown): { envelope: StoredEnvelope; data: unknown } | UnattributableEvent {
  if (!isObject(body)) return unattributable("The message is not a JSON object", null);
  const eventId = typeof body["id"] === "string" && UUID_PATTERN.test(body["id"]) ? body["id"].toLowerCase() : null;
  if (body["specversion"] !== "1.0") return unattributable("The message is not a CloudEvent 1.0", eventId);
  if (eventId === null) return unattributable("The event id is missing or not a UUID", null);
  if (!isTenantId(body["tenantid"])) return unattributable("The tenantid attribute is missing or not a UUID", eventId);
  const type = body["type"];
  if (typeof type !== "string" || type.length < 1 || type.length > EVENT_TYPE_MAX_LENGTH) {
    return unattributable(`The type attribute is missing or longer than ${EVENT_TYPE_MAX_LENGTH} characters`, eventId);
  }
  const correlationId = typeof body["correlationid"] === "string" && body["correlationid"] !== "" ? body["correlationid"] : null;
  return { envelope: { eventId, eventType: type, tenantId: body["tenantid"].toLowerCase(), correlationId }, data: body["data"] };
}

function readFacts(envelope: ConsumedEnvelope, data: Record<string, unknown>): ProjectionEvent {
  switch (envelope.eventType) {
    case MARKET_OPENED_TYPE: {
      const raw = data["question"];
      if (typeof raw !== "string") fail(`data.question must be text of 1 to ${QUESTION_MAX_LENGTH} characters`);
      // markets trims the question and counts code points (its validateQuestion); so does this reader.
      const question = raw.trim();
      const length = questionLength(question);
      if (length < 1 || length > QUESTION_MAX_LENGTH) fail(`data.question must be text of 1 to ${QUESTION_MAX_LENGTH} characters`);
      const startingPrice = data["startingPrice"];
      if (typeof startingPrice !== "number") fail("data.startingPrice must be a number");
      return {
        ...envelope,
        kind: "market_opened",
        facts: {
          marketId: marketId(data),
          version: positiveInteger(data, "version"),
          question,
          closeTime: dateTime(data, "closeTime"),
          startingPriceYesMicro: decimalPriceToMicro(startingPrice, "data.startingPrice"),
          openedAt: dateTime(data, "openedAt"),
        },
      };
    }
    case MARKET_CLOSED_TYPE:
      return { ...envelope, kind: "market_closed", facts: { marketId: marketId(data), version: positiveInteger(data, "version"), closedAt: dateTime(data, "closedAt") } };
    case MARKET_RESOLVED_TYPE: {
      const outcome = data["outcome"];
      if (!isOutcome(outcome)) fail("data.outcome must be YES, NO or INVALID");
      return {
        ...envelope,
        kind: "market_resolved",
        facts: { marketId: marketId(data), version: positiveInteger(data, "version"), outcome, resolvedAt: dateTime(data, "resolvedAt") },
      };
    }
    case TRADE_EXECUTED_TYPE: {
      const price = data["yesPriceMicro"];
      if (!isYesPriceMicro(price)) fail("data.yesPriceMicro must be an integer from 10000 to 990000");
      const cost = data["costMicro"];
      if (!isMicroQuantity(cost)) fail("data.costMicro must be a non-negative safe integer");
      return {
        ...envelope,
        kind: "trade_executed",
        facts: {
          marketId: marketId(data),
          tradeSequence: positiveInteger(data, "tradeSequence"),
          priceYesMicro: price,
          volumeMicro: cost,
          executedAt: dateTime(data, "executedAt"),
        },
      };
    }
  }
}

/**
 * A message of the MARKETS or TRADING stream (or a stored copy of one): the projection event, an unprojected event (with
 * the cause and the reason), or an unattributable one. Never throws for any input.
 */
export function readProjectionEvent(body: unknown): ReadResult {
  const read = envelopeOf(body);
  if ("kind" in read) return read;
  const { envelope, data } = read;
  const hint = isObject(data) && isMarketId(data["marketId"]) ? data["marketId"].toLowerCase() : null;
  const unprojected = (cause: UnprojectedEvent["cause"], reason: string): UnprojectedEvent => ({ ...envelope, kind: "unprojected", cause, reason, marketId: hint });
  const type = envelope.eventType;
  if (!(PROJECTION_EVENT_TYPES as readonly string[]).includes(type)) {
    return isProjectionFamily(type)
      ? unprojected("unreadable", `This version reads ${PROJECTION_EVENT_TYPES.join(", ")} only, not ${type}`)
      : unprojected("other_type", `market-data does not project ${type}`);
  }
  if (!isObject(data)) return unprojected("unreadable", "The event has no data object");
  const dataTenant = data["tenantId"];
  if (dataTenant !== undefined && (typeof dataTenant !== "string" || dataTenant.toLowerCase() !== envelope.tenantId)) {
    return unprojected("unreadable", "data.tenantId differs from the tenantid attribute");
  }
  try {
    return readFacts({ ...envelope, eventType: type as ProjectionEventType }, data);
  } catch (error) {
    if (error instanceof Malformed || error instanceof DomainError) return unprojected("unreadable", error.message);
    throw error;
  }
}

/** The market a projection event concerns (every projection event names exactly one). */
export function marketOf(event: ProjectionEvent): string {
  return event.facts.marketId;
}

/** consumed_events.market_id of a consumed event: the projection event's market, else the data's market id or null. */
export function storedMarketOf(event: ConsumedEvent): string | null {
  return event.kind === "unprojected" ? event.marketId : event.facts.marketId;
}

/** Whether the event comes from markets (the lifecycle) rather than from trading. */
export function isLifecycleEvent(event: ProjectionEvent): boolean {
  return event.kind !== "trade_executed";
}
