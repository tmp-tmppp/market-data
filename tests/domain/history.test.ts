import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { DEFAULT_INTERVAL, bucketStart, bucketize, checkDate, historyRange, isBucketStart, isInterval, parseInterval } from "../../src/domain/history.js";
import type { PricePoint } from "../../src/domain/projection.js";
import { decimalPriceToMicro, addMicro, isPriceMicro, parsePriceMicro } from "../../src/domain/units.js";
import { MARKET_1, T0, at } from "../support/fakes.js";

const point = (sequence: number, minutes: number, price: number, volume = 1_000_000): PricePoint => ({
  marketId: MARKET_1,
  tradeSequence: sequence,
  time: at(minutes),
  priceYesMicro: price,
  volumeMicro: sequence === 0 ? 0 : volume,
});

describe("buckets", () => {
  it("align to the Unix epoch in UTC", () => {
    expect(bucketStart(new Date("2026-11-01T10:59:59.999Z"), "1h")).toEqual(new Date("2026-11-01T10:00:00.000Z"));
    expect(bucketStart(new Date("2026-11-01T10:07:00.000Z"), "5m")).toEqual(new Date("2026-11-01T10:05:00.000Z"));
    expect(bucketStart(new Date("2026-11-01T23:30:00.000Z"), "1d")).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(bucketStart(new Date("2026-11-01T03:00:00.000Z"), "4h")).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(isBucketStart(T0, "1h")).toBe(true);
    expect(isBucketStart(at(1), "1h")).toBe(false);
  });

  it("carry OHLC by trade sequence, the volume and the trades, sparse and ascending", () => {
    // Points out of order; minute 0 is the opening point; 61 falls in the second hour; nothing in hour 3.
    const points = [point(3, 30, 480_000, 2_000_000), point(0, 0, 400_000), point(2, 20, 520_000), point(1, 10, 450_000), point(4, 61, 500_000), point(5, 185, 510_000)];
    expect(bucketize(points, "1h")).toEqual([
      { start: at(0), openYesMicro: 400_000, highYesMicro: 520_000, lowYesMicro: 400_000, closeYesMicro: 480_000, volumeMicro: 4_000_000, trades: 3 },
      { start: at(60), openYesMicro: 500_000, highYesMicro: 500_000, lowYesMicro: 500_000, closeYesMicro: 500_000, volumeMicro: 1_000_000, trades: 1 },
      { start: at(180), openYesMicro: 510_000, highYesMicro: 510_000, lowYesMicro: 510_000, closeYesMicro: 510_000, volumeMicro: 1_000_000, trades: 1 },
    ]);
    expect(bucketize([], "1m")).toEqual([]);
  });

  it("parse the interval", () => {
    expect(parseInterval("15m")).toBe("15m");
    expect(isInterval("2h")).toBe(false);
    expect(isInterval("toString")).toBe(false);
    expect(() => parseInterval("2h")).toThrow(DomainError);
  });
});

describe("historyRange", () => {
  const openedAt = at(0);

  it("defaults to the newest buckets, never before the market opened", () => {
    const now = at(60 * 5 + 30);
    expect(historyRange({ openedAt, now, maxPoints: 1000 })).toEqual({ interval: DEFAULT_INTERVAL, from: at(0), to: now, buckets: 6 });
    // Only 3 buckets allowed: the newest 3, the one holding `now` included.
    expect(historyRange({ openedAt, now, maxPoints: 3 })).toEqual({ interval: "1h", from: at(180), to: now, buckets: 3 });
    // A `to` before the market opened still gives one bucket.
    expect(historyRange({ openedAt, now, to: at(-120), maxPoints: 10, interval: "1h" })).toEqual({ interval: "1h", from: at(-180), to: at(-120), buckets: 1 });
  });

  it("rounds an explicit from down to its bucket and refuses a range that is too large or empty", () => {
    expect(historyRange({ openedAt, now: at(100), from: at(7), interval: "5m", maxPoints: 100 })).toMatchObject({ from: at(5), buckets: 19 });
    expect(() => historyRange({ openedAt, now: at(100), from: at(100), interval: "5m", maxPoints: 100 })).toThrow(DomainError);
    try {
      historyRange({ openedAt, now: at(60 * 24 * 30), from: at(0), interval: "1m", maxPoints: 1000 });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_range", field: "from", details: { maxPoints: 1000 } });
    }
    // A from after to is refused even when its bucket start lies before to.
    expect(() => historyRange({ openedAt, now: at(100), from: at(102), interval: "5m", maxPoints: 100 })).toThrow(DomainError);
  });

  it("accepts the last maxPoints intervals at any time, with the partial first bucket", () => {
    const now = new Date(at(2_000).getTime() + 30_000);
    const last = (minutes: number): Date => new Date(now.getTime() - minutes * 60_000);
    expect(historyRange({ openedAt, now, from: last(1_000), interval: "1m", maxPoints: 1_000 })).toEqual({ interval: "1m", from: at(1_000), to: now, buckets: 1_001 });
    expect(() => historyRange({ openedAt, now, from: last(1_000.5), interval: "1m", maxPoints: 1_000 })).toThrow(DomainError);
    expect(() => historyRange({ openedAt, now, from: last(1_001), interval: "1m", maxPoints: 1_000 })).toThrow(DomainError);
  });

  it("refuses an invalid date, such as a leap second, with its field", () => {
    const leap = new Date("2016-12-31T23:59:60Z");
    expect(Number.isNaN(leap.getTime())).toBe(true);
    expect(() => historyRange({ openedAt, now: at(100), from: leap, maxPoints: 100 })).toThrow(expect.objectContaining({ code: "invalid_range", field: "from" }));
    expect(() => historyRange({ openedAt, now: at(100), to: leap, maxPoints: 100 })).toThrow(expect.objectContaining({ code: "invalid_range", field: "to" }));
    expect(() => checkDate(at(1), "from")).not.toThrow();
    expect(() => checkDate(undefined, "to")).not.toThrow();
  });
});

describe("units", () => {
  it("convert markets' starting price exactly and check the grid", () => {
    expect(decimalPriceToMicro(0.29)).toBe(290_000);
    expect(() => decimalPriceToMicro(Number.NaN)).toThrow(DomainError);
    expect(() => decimalPriceToMicro(1)).toThrow(DomainError);
    expect(isPriceMicro(10_000)).toBe(true);
    expect(isPriceMicro(995_000)).toBe(false);
    expect(() => parsePriceMicro(5)).toThrow(DomainError);
  });

  it("add volumes exactly and refuse sums past 2^53", () => {
    expect(addMicro(1, 2)).toBe(3);
    expect(() => addMicro(Number.MAX_SAFE_INTEGER, 1)).toThrow(DomainError);
    expect(() => addMicro(-1, 1)).toThrow(DomainError);
  });
});
