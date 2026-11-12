import { DomainError } from "./errors.js";
import type { PricePoint } from "./projection.js";
import { addMicro } from "./units.js";

// Price history for charts (plan 6.3: GET .../history?from=&interval=): the price points of one market grouped into
// buckets of a fixed interval, each with an OHLC-like YES price and the volume. Buckets are aligned to the Unix epoch in
// UTC (a 1h bucket starts on the hour, a 1d bucket at 00:00 UTC), which is what PostgreSQL's
// date_bin(<interval>, time, '1970-01-01 00:00:00+00') computes, so the PostgreSQL adapter can group in SQL and give the
// same buckets as bucketize. Only buckets with at least one point are returned (a sparse series); the chart carries the
// last close forward, starting from the history's previousCloseYesMicro.

export const INTERVALS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
} as const;

export type Interval = keyof typeof INTERVALS;

export const DEFAULT_INTERVAL: Interval = "1h";

/** The bounds of the runtime key HISTORY_MAX_POINTS: the most buckets one history range may span. */
export const HISTORY_MAX_POINTS_MIN = 10;
export const HISTORY_MAX_POINTS_LIMIT = 10_000;

export function isInterval(value: unknown): value is Interval {
  return typeof value === "string" && Object.hasOwn(INTERVALS, value);
}

export function parseInterval(value: unknown, field = "interval"): Interval {
  if (!isInterval(value)) throw new DomainError("invalid_interval", `${field} must be one of: ${Object.keys(INTERVALS).join(", ")}`, field);
  return value;
}

export function intervalMs(interval: Interval): number {
  return INTERVALS[interval];
}

/** The start of the bucket that holds `time`. */
export function bucketStart(time: Date, interval: Interval): Date {
  const size = intervalMs(interval);
  return new Date(Math.floor(time.getTime() / size) * size);
}

/** Whether `time` is the start of a bucket of `interval`. */
export function isBucketStart(time: Date, interval: Interval): boolean {
  return time.getTime() % intervalMs(interval) === 0;
}

/** One bucket of the history: the points whose time falls in [start, start + interval). */
export interface Bucket {
  start: Date;
  /** The YES price of the bucket's point with the lowest trade sequence. */
  openYesMicro: number;
  highYesMicro: number;
  lowYesMicro: number;
  /** The YES price of the bucket's point with the highest trade sequence. */
  closeYesMicro: number;
  /** Sum of the points' volumes (microcredits). */
  volumeMicro: number;
  /** Trades in the bucket (the opening point is not a trade). */
  trades: number;
}

/**
 * Groups the points of one market into sparse buckets, ascending by start. Within a bucket the trade sequence orders the
 * points (trading stamps the time under the market's lock, so time and sequence agree; the sequence is the authority).
 */
export function bucketize(points: readonly PricePoint[], interval: Interval): Bucket[] {
  const sorted = [...points].sort((a, b) => bucketStart(a.time, interval).getTime() - bucketStart(b.time, interval).getTime() || a.tradeSequence - b.tradeSequence);
  const buckets: Bucket[] = [];
  let current: Bucket | null = null;
  for (const point of sorted) {
    const start = bucketStart(point.time, interval);
    if (current === null || current.start.getTime() !== start.getTime()) {
      current = {
        start,
        openYesMicro: point.priceYesMicro,
        highYesMicro: point.priceYesMicro,
        lowYesMicro: point.priceYesMicro,
        closeYesMicro: point.priceYesMicro,
        volumeMicro: point.volumeMicro,
        trades: point.tradeSequence >= 1 ? 1 : 0,
      };
      buckets.push(current);
      continue;
    }
    current.highYesMicro = Math.max(current.highYesMicro, point.priceYesMicro);
    current.lowYesMicro = Math.min(current.lowYesMicro, point.priceYesMicro);
    current.closeYesMicro = point.priceYesMicro;
    current.volumeMicro = addMicro(current.volumeMicro, point.volumeMicro);
    if (point.tradeSequence >= 1) current.trades += 1;
  }
  return buckets;
}

/** A checked history range: buckets whose start lies in [from, to); points whose time lies in [from, to). */
export interface HistoryRange {
  interval: Interval;
  /** A bucket start. */
  from: Date;
  to: Date;
  /**
   * How many buckets the range spans: at most maxPoints, or maxPoints + 1 when an explicit `from` was rounded down to
   * its bucket start (the partial first bucket of "the last maxPoints intervals").
   */
  buckets: number;
}

/**
 * Refuses a Date that is not a time (getTime() NaN), field "from" or "to". The web layer's date-time format accepts a
 * leap second such as 2016-12-31T23:59:60Z, which `new Date` turns into an Invalid Date: a 400, never a 500.
 */
export function checkDate(value: Date | undefined, field: "from" | "to"): void {
  if (value !== undefined && Number.isNaN(value.getTime())) {
    throw new DomainError("invalid_range", `${field} must be a valid date-time (a leap second such as 23:59:60 is not one)`, field);
  }
}

/** The number of buckets of `interval` whose start lies in [from, to), for a bucket-aligned `from`. */
export function bucketsBetween(from: Date, to: Date, interval: Interval): number {
  return Math.ceil((to.getTime() - from.getTime()) / intervalMs(interval));
}

export interface HistoryRangeInput {
  interval?: Interval;
  /** Rounded down to its bucket start. Default: as far back as maxPoints allows, but not before openedAt's bucket. */
  from?: Date;
  /** Default: now. */
  to?: Date;
  openedAt: Date;
  now: Date;
  /** The runtime key HISTORY_MAX_POINTS. */
  maxPoints: number;
}

/**
 * The range of page 1 of a history request (later pages take the range from their cursor and never call this, so a
 * range accepted once is never refused on a later page). An invalid date, an explicit `from` that is not before
 * `to`, or a requested span `to - from` of more than `maxPoints` intervals, is refused (invalid_range, field "from" or
 * "to", details.maxPoints for the span). The span is measured from the `from` the caller sent, so "the last maxPoints
 * intervals" is accepted at any time; rounding `from` down to its bucket adds at most one partial bucket. Without `from`
 * the range is the newest `maxPoints` buckets at most, and never starts before the market opened (at least one bucket).
 */
export function historyRange(input: HistoryRangeInput): HistoryRange {
  checkDate(input.from, "from");
  checkDate(input.to, "to");
  const interval = input.interval ?? DEFAULT_INTERVAL;
  const size = intervalMs(interval);
  const to = input.to ?? input.now;
  const count = (from: Date): number => bucketsBetween(from, to, interval);
  let from: Date;
  if (input.from !== undefined) {
    if (input.from.getTime() >= to.getTime()) throw new DomainError("invalid_range", "from must be before to", "from");
    from = bucketStart(input.from, interval);
    if (Math.ceil((to.getTime() - input.from.getTime()) / size) > input.maxPoints) {
      throw new DomainError("invalid_range", `The range spans more than ${input.maxPoints} buckets of ${interval}; choose a later from or a larger interval`, "from", { maxPoints: input.maxPoints });
    }
  } else {
    const earliest = Math.max(input.openedAt.getTime(), to.getTime() - size * input.maxPoints);
    from = bucketStart(new Date(earliest), interval);
    if (count(from) > input.maxPoints) from = new Date(from.getTime() + size);
    if (from.getTime() >= to.getTime()) from = bucketStart(new Date(to.getTime() - 1), interval);
  }
  return { interval, from, to, buckets: count(from) };
}
