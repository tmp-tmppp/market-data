import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { historyRange } from "../../src/domain/history.js";
import { emptySummary, foldEvents } from "../../src/domain/projection.js";
import { HistoryPaused, NotFound, TenantNotReady, Updating, ValidationFailed, fromDomainError, guardDomain } from "../../src/usecases/errors.js";
import {
  MARKET_EVENTS_CONSUMER,
  MAX_IDS,
  TRADE_EVENTS_CONSUMER,
  consumerOf,
  decodeHistoryCursor,
  decodeMarketCursor,
  encodeHistoryCursor,
  encodeMarketCursor,
  marketViewOf,
  pageSize,
  parseAfterSequence,
  parseIds,
} from "../../src/usecases/support.js";
import { MARKET_1, MARKET_2, T0, at, marketOpenedBody, projectionEvent, tradeExecutedBody } from "../support/fakes.js";

describe("paging and query values", () => {
  it("checks page sizes, afterSequence and ids", () => {
    expect(pageSize(undefined, 20, 100)).toBe(20);
    expect(() => pageSize(0, 20, 100)).toThrow(ValidationFailed);
    expect(() => pageSize(101, 20, 100)).toThrow(ValidationFailed);
    expect(parseAfterSequence(undefined)).toBeUndefined();
    expect(parseAfterSequence(3)).toBe(3);
    expect(() => parseAfterSequence(0)).toThrow(ValidationFailed);
    expect(parseIds([MARKET_1.toUpperCase(), MARKET_2, MARKET_1])).toEqual([MARKET_1, MARKET_2]);
    expect(() => parseIds([])).toThrow(ValidationFailed);
    expect(() => parseIds(["x"])).toThrow(ValidationFailed);
    expect(() => parseIds(Array.from({ length: MAX_IDS + 1 }, (_, i) => `018f3c1e-7a00-7000-8000-${String(i).padStart(12, "0")}`))).toThrow(ValidationFailed);
  });

  it("round-trips the market cursor and refuses a crafted one", () => {
    expect(decodeMarketCursor(encodeMarketCursor(MARKET_1))).toBe(MARKET_1);
    expect(decodeMarketCursor(undefined)).toBeNull();
    expect(() => decodeMarketCursor("not-base64-json")).toThrow(ValidationFailed);
    expect(() => decodeMarketCursor(Buffer.from(JSON.stringify({ m: "x" })).toString("base64url"))).toThrow(ValidationFailed);
  });

  it("round-trips the history cursor with page 1's range, only for the same query and inside the range", () => {
    const range = historyRange({ openedAt: T0, now: at(600), interval: "1h", maxPoints: 100 });
    const cursor = encodeHistoryCursor(at(120), range);
    expect(decodeHistoryCursor(cursor, { interval: "1h" })).toEqual({ range, pageStart: at(120) });
    expect(decodeHistoryCursor(cursor, { interval: "1h", from: at(30), to: range.to })).toEqual({ range, pageStart: at(120) });
    expect(() => decodeHistoryCursor(cursor, { interval: "5m" })).toThrow(ValidationFailed);
    expect(() => decodeHistoryCursor(cursor, { interval: "1h", from: at(60) })).toThrow(ValidationFailed);
    expect(() => decodeHistoryCursor(cursor, { interval: "1h", to: at(660) })).toThrow(ValidationFailed);
    expect(() => decodeHistoryCursor(encodeHistoryCursor(at(125), range), { interval: "1h" })).toThrow(ValidationFailed);
    expect(() => decodeHistoryCursor(encodeHistoryCursor(at(600), range), { interval: "1h" })).toThrow(ValidationFailed);
    expect(() => decodeHistoryCursor("%%%", { interval: "1h" })).toThrow(ValidationFailed);
    const crafted = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(() => decodeHistoryCursor(crafted({ b: 0, i: "1h", f: 0, t: 3_600_000 * 20_000 }), { interval: "1h" })).toThrow(ValidationFailed);
    expect(() => decodeHistoryCursor(crafted({ b: 3_600_000, i: "1h", f: 3_600_000, t: 3_600_000 }), { interval: "1h" })).toThrow(ValidationFailed);
    expect(() => decodeHistoryCursor(crafted({ b: 0, i: "1h", f: 0, t: "x" }), { interval: "1h" })).toThrow(ValidationFailed);
    expect(() => decodeHistoryCursor(crafted({ b: 0, i: "1h", f: 0, t: 9_000_000_000_000_000 }), { interval: "1h" })).toThrow(ValidationFailed);
  });

  it("continues page 1's range on a later page although now moved on and to was omitted", () => {
    const now = new Date(at(2_000).getTime() + 30_000);
    const page1 = historyRange({ openedAt: T0, now, from: at(1_001), interval: "1m", maxPoints: 1_000 });
    const later = new Date(now.getTime() + 2 * 60_000);
    expect(() => historyRange({ openedAt: T0, now: later, from: at(1_001), interval: "1m", maxPoints: 1_000 })).toThrow(DomainError);
    const { range } = decodeHistoryCursor(encodeHistoryCursor(at(1_101), page1), { interval: "1m", from: at(1_001) });
    expect(range).toEqual(page1);
  });

  it("refuses an invalid from or to on a later page with the field", () => {
    const range = historyRange({ openedAt: T0, now: at(600), interval: "1h", maxPoints: 100 });
    const cursor = encodeHistoryCursor(at(120), range);
    const fieldOf = (run: () => unknown): string | undefined => {
      try {
        run();
      } catch (error) {
        return error instanceof ValidationFailed ? error.fields[0]?.field : undefined;
      }
      return undefined;
    };
    expect(fieldOf(() => decodeHistoryCursor(cursor, { interval: "1h", from: new Date("2016-12-31T23:59:60Z") }))).toBe("from");
    expect(fieldOf(() => decodeHistoryCursor(cursor, { interval: "1h", to: new Date(Number.NaN) }))).toBe("to");
  });

  it("names the inbox consumer of each event, projected or not", () => {
    expect(consumerOf(projectionEvent(marketOpenedBody()))).toBe(MARKET_EVENTS_CONSUMER);
    expect(consumerOf(projectionEvent(tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 500_000 })))).toBe(TRADE_EVENTS_CONSUMER);
    expect(consumerOf({ eventType: "si.chance.trading.TradeExecuted.v2" })).toBe(TRADE_EVENTS_CONSUMER);
    expect(consumerOf({ eventType: "si.chance.markets.MarketCreated.v1" })).toBe(MARKET_EVENTS_CONSUMER);
  });
});

describe("marketViewOf", () => {
  it("shows a listed summary with its current price", () => {
    const state = foldEvents([projectionEvent(marketOpenedBody({ startingPrice: 0.4 })), projectionEvent(tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 450_000 }))], at(5));
    const summary = state.summaries.get(MARKET_1);
    if (!summary) throw new Error("missing");
    expect(marketViewOf(summary)).toMatchObject({ marketId: MARKET_1, status: "open", startingPriceYesMicro: 400_000, lastPriceYesMicro: 450_000, currentPriceYesMicro: 450_000, tradeCount: 1 });
  });

  it("refuses a summary that is not listed", () => {
    expect(() => marketViewOf(emptySummary(MARKET_1, T0))).toThrow(DomainError);
  });
});

describe("errors", () => {
  it("maps domain rule violations to use-case errors", () => {
    expect(fromDomainError(new DomainError("invalid_interval", "bad", "interval"))).toBeInstanceOf(ValidationFailed);
    const range = fromDomainError(new DomainError("invalid_range", "too large", "from", { maxPoints: 10 }));
    expect(range).toMatchObject({ code: "validation_failed", details: { maxPoints: 10 }, fields: [{ field: "from" }] });
    const bug = fromDomainError(new DomainError("invariant_violated", "bug"));
    expect(bug).not.toBeInstanceOf(ValidationFailed);
    expect(() => guardDomain(() => { throw new DomainError("invalid_market_id", "x"); })).toThrow(ValidationFailed);
    expect(() => guardDomain(() => { throw new TypeError("plain"); })).toThrow(TypeError);
    expect(guardDomain(() => 7)).toBe(7);
  });

  it("carries the codes and details the API answers with", () => {
    expect(new Updating(4)).toMatchObject({ kind: "conflict", code: "updating", details: { lastTradeSequence: 4 } });
    expect(new TenantNotReady()).toMatchObject({ kind: "unavailable", code: "tenant_not_ready", retryAfterSeconds: 5 });
    expect(new HistoryPaused()).toMatchObject({ kind: "unavailable", code: "history_paused", retryAfterSeconds: 30 });
    expect(new NotFound()).toMatchObject({ kind: "not_found", code: "not_found" });
  });
});
