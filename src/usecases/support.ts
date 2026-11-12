import { isMarketId } from "../domain/consumed.js";
import type { StoredEnvelope } from "../domain/consumed.js";
import { DomainError } from "../domain/errors.js";
import { HISTORY_MAX_POINTS_LIMIT, bucketStart, bucketsBetween, checkDate, isBucketStart } from "../domain/history.js";
import type { HistoryRange, Interval } from "../domain/history.js";
import { currentPriceYesMicro, isListed } from "../domain/projection.js";
import type { MarketSummary } from "../domain/projection.js";
import { ValidationFailed, guardDomain } from "./errors.js";
import type { MarketView } from "./use-cases.js";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
/** The most ids of one batch call (DM-12: the portfolio page's positions). */
export const MAX_IDS = 100;
export const DEFAULT_HISTORY_PAGE_SIZE = 100;
export const MAX_HISTORY_PAGE_SIZE = 500;

// Inbox consumer names (shared.inbox.consumer): one per consumed stream (ADR-053).
export const TENANT_CREATED_CONSUMER = "tenant-created";
export const MARKET_EVENTS_CONSUMER = "market-events";
export const TRADE_EVENTS_CONSUMER = "trade-events";

/**
 * The inbox consumer of a consumed event (projected or not), by its type's publisher: trading's events (the TRADING
 * consumer) or markets' events (the MARKETS consumer).
 */
export function consumerOf(event: Pick<StoredEnvelope, "eventType">): string {
  return event.eventType.startsWith("si.chance.trading.") ? TRADE_EVENTS_CONSUMER : MARKET_EVENTS_CONSUMER;
}

/**
 * A consumed event that failed this many deliveries in a row is parked (shared.parked_events) and acked, so it cannot
 * hold back the rest of its stream (as trading: with a nak delay of 5 s about two minutes of retries).
 */
export const PARK_AFTER_DELIVERIES = 20;

/** Max ack pending of the three durable consumers: the projection rules commute, so events need no strict order. */
export const CONSUMER_MAX_ACK_PENDING = 10;

/**
 * consumed_events rows per replay batch transaction. A batch holds the tenant's projection lock exclusively, and each pod
 * handles the messages of a stream one at a time for all tenants, so a live event of the tenant being rebuilt holds back
 * every tenant's events for up to one batch. Batches are therefore bounded by rows AND by time: a batch ends at
 * `batchSize` rows or once REPLAY_BATCH_TIME_BUDGET_MS have passed since it took the lock (after the row in progress),
 * which keeps the delay within DM-13's 1-2 s and far below the 30 s ack wait.
 */
export const DEFAULT_REPLAY_BATCH_SIZE = 500;
export const MAX_REPLAY_BATCH_SIZE = 1_000;
export const REPLAY_BATCH_TIME_BUDGET_MS = 1_000;
/** Rows of a retired version deleted per statement after the switch. */
export const RETIRED_DELETE_BATCH_SIZE = 5_000;

/** A page size from the query: an integer from 1 to `max`, `fallback` when absent. */
export function pageSize(limit: number | undefined, fallback: number, max: number): number {
  const value = limit ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new ValidationFailed([{ field: "limit", message: `limit must be an integer from 1 to ${max}` }]);
  return value;
}

export interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}

/** DM-17's afterSequence: undefined, or a trade sequence (a safe integer of 1 or more). */
export function parseAfterSequence(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new ValidationFailed([{ field: "afterSequence", message: "afterSequence must be an integer of 1 or more" }]);
  return value;
}

/** The `ids` of a batch call: UUIDs (lower case, duplicates collapsed, first-seen order), 1 to MAX_IDS. */
export function parseIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids.map((id) => id.trim().toLowerCase()))];
  if (unique.length < 1 || unique.length > MAX_IDS) throw new ValidationFailed([{ field: "ids", message: `ids must name 1 to ${MAX_IDS} markets` }]);
  if (!unique.every((id) => isMarketId(id))) throw new ValidationFailed([{ field: "ids", message: "Every id must be a UUID" }]);
  return unique;
}

// Cursors are opaque to clients: base64url of a small JSON object. They are checked completely, so a crafted one is a
// 400, never a database error.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalidCursor(): ValidationFailed {
  return new ValidationFailed([{ field: "cursor", message: "The cursor is not valid" }]);
}

function decodeJson(cursor: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The market list: the next page starts below this market id (newest first). */
export function encodeMarketCursor(lastMarketId: string): string {
  return Buffer.from(JSON.stringify({ m: lastMarketId }), "utf8").toString("base64url");
}

export function decodeMarketCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  const parsed = decodeJson(cursor);
  if (parsed && typeof parsed["m"] === "string" && UUID_PATTERN.test(parsed["m"])) return parsed["m"];
  throw invalidCursor();
}

/**
 * The history: the next page starts at bucket start `b`; the interval `i` and page 1's resolved range `f`..`t` travel
 * along, so every later page continues exactly the range of page 1. Without them a `to` that defaults to now would be
 * recomputed on every page, the range would grow by a bucket per interval and a valid cursor could be refused with
 * maxPoints later on.
 */
export function encodeHistoryCursor(start: Date, range: HistoryRange): string {
  const value = { b: start.getTime(), i: range.interval, f: range.from.getTime(), t: range.to.getTime() };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** What a later page's query says about its range; it must agree with the cursor's. */
export interface HistoryQuery {
  interval: Interval;
  from?: Date;
  to?: Date;
}

/**
 * A later page of a history request: the range comes from the cursor (fixed on page 1, never checked against
 * HISTORY_MAX_POINTS again), the page start is its bucket start. A cursor of another interval, a `from` that does not
 * round to the cursor's from, a `to` that differs from its to, or anything crafted is a 400 on field "cursor"; an
 * invalid `from` or `to` is a 400 on that field. A crafted range is bounded too (HISTORY_MAX_POINTS_LIMIT + 1 buckets).
 */
export function decodeHistoryCursor(cursor: string, query: HistoryQuery): { range: HistoryRange; pageStart: Date } {
  guardDomain(() => {
    checkDate(query.from, "from");
    checkDate(query.to, "to");
  });
  const parsed = decodeJson(cursor);
  if (!parsed || parsed["i"] !== query.interval) throw invalidCursor();
  const [b, f, t] = [parsed["b"], parsed["f"], parsed["t"]];
  if (typeof b !== "number" || typeof f !== "number" || typeof t !== "number" || ![b, f, t].every((ms) => Number.isSafeInteger(ms))) throw invalidCursor();
  const interval = query.interval;
  const [start, from, to] = [new Date(b), new Date(f), new Date(t)];
  if (!isBucketStart(start, interval) || !isBucketStart(from, interval) || Number.isNaN(to.getTime()) || f >= t || b < f || b >= t) throw invalidCursor();
  const buckets = bucketsBetween(from, to, interval);
  if (buckets > HISTORY_MAX_POINTS_LIMIT + 1) throw invalidCursor();
  if (query.from !== undefined && bucketStart(query.from, interval).getTime() !== f) throw invalidCursor();
  if (query.to !== undefined && query.to.getTime() !== t) throw invalidCursor();
  return { range: { interval, from, to, buckets }, pageStart: start };
}

/** A listed summary as the API shows it. A summary that is not listed is a bug of the caller (filter with isListed). */
export function marketViewOf(summary: MarketSummary): MarketView {
  const current = currentPriceYesMicro(summary);
  if (!isListed(summary) || summary.status === null || summary.question === null || summary.closeTime === null || summary.openedAt === null || summary.startingPriceYesMicro === null || current === null) {
    throw new DomainError("invariant_violated", `The summary of market ${summary.marketId} is not listed yet`);
  }
  return {
    marketId: summary.marketId,
    question: summary.question,
    status: summary.status,
    closeTime: summary.closeTime,
    openedAt: summary.openedAt,
    closedAt: summary.closedAt,
    resolvedAt: summary.resolvedAt,
    outcome: summary.outcome,
    startingPriceYesMicro: summary.startingPriceYesMicro,
    lastPriceYesMicro: summary.lastPriceYesMicro,
    currentPriceYesMicro: current,
    volumeMicro: summary.volumeMicro,
    tradeCount: summary.tradeCount,
    lastTradeSequence: summary.lastTradeSequence,
    lastTradeAt: summary.lastTradeAt,
    version: summary.version,
    updatedAt: summary.updatedAt,
  };
}
