import { describe, expect, it } from "vitest";
import type { ProjectionEvent } from "../../src/domain/consumed.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  OPENING_SEQUENCE,
  applyClosed,
  applyOpened,
  applyResolved,
  applyToProjection,
  applyTrade,
  currentPriceYesMicro,
  effectOf,
  emptyProjection,
  emptySummary,
  foldEvents,
  isListed,
  isMarketStatus,
  pointKey,
  projectionDifferences,
  sameSummary,
  tradePoint,
} from "../../src/domain/projection.js";
import { MARKET_1, MARKET_2, T0, at, marketClosedBody, marketOpenedBody, marketResolvedBody, projectionEvent, tradeExecutedBody } from "../support/fakes.js";

const NOW = at(1000);

type FactsOf = { [E in ProjectionEvent as E["kind"]]: E["facts"] };

function factsOf<K extends keyof FactsOf>(event: ProjectionEvent, kind: K): FactsOf[K] {
  if (event.kind !== kind) throw new Error(`expected ${kind}`);
  return event.facts as unknown as FactsOf[K];
}

const opened = projectionEvent(marketOpenedBody({ startingPrice: 0.4 }));
const closed = projectionEvent(marketClosedBody());
const resolved = projectionEvent(marketResolvedBody({ outcome: "YES" }));
const trade = (sequence: number, price: number, cost = 1_000_000): ProjectionEvent => projectionEvent(tradeExecutedBody({ tradeSequence: sequence, yesPriceMicro: price, costMicro: cost }));

/** Every order of `items` (Heap's algorithm); used with at most 6 events (720 orders). */
function permutations<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  const a = [...items];
  const c = new Array<number>(a.length).fill(0);
  result.push([...a]);
  let i = 0;
  while (i < a.length) {
    if ((c[i] ?? 0) < i) {
      const j = i % 2 === 0 ? 0 : (c[i] ?? 0);
      [a[j], a[i]] = [a[i] as T, a[j] as T];
      result.push([...a]);
      c[i] = (c[i] ?? 0) + 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
  return result;
}

describe("lifecycle events (DM-04 version guard)", () => {
  it("opens, closes and resolves a market in order", () => {
    let summary = emptySummary(MARKET_1, T0);
    expect(isListed(summary)).toBe(false);
    summary = applyOpened(summary, factsOf(opened, "market_opened"), NOW).summary;
    expect(summary).toMatchObject({ version: 1, status: "open", question: "Will the demo work on the first try?", startingPriceYesMicro: 400_000 });
    expect(isListed(summary)).toBe(true);
    expect(currentPriceYesMicro(summary)).toBe(400_000);
    summary = applyClosed(summary, factsOf(closed, "market_closed"), NOW).summary;
    expect(summary).toMatchObject({ version: 2, status: "closed", closedAt: at(600) });
    summary = applyResolved(summary, factsOf(resolved, "market_resolved"), NOW).summary;
    expect(summary).toMatchObject({ version: 3, status: "resolved", outcome: "YES", resolvedAt: at(700) });
    expect(currentPriceYesMicro(summary)).toBe(1_000_000);
  });

  it("never rolls the status back; an older event only fills facts that are missing", () => {
    let summary = applyResolved(emptySummary(MARKET_1, T0), factsOf(resolved, "market_resolved"), NOW).summary;
    expect(isListed(summary)).toBe(false);

    const lateClose = applyClosed(summary, factsOf(closed, "market_closed"), NOW);
    expect(lateClose).toMatchObject({ kind: "filled", changed: true, summary: { status: "resolved", version: 3, closedAt: at(600) } });
    summary = lateClose.summary;
    expect(applyClosed(summary, factsOf(closed, "market_closed"), NOW)).toMatchObject({ kind: "stale", changed: false });

    const lateOpen = applyOpened(summary, factsOf(opened, "market_opened"), NOW);
    expect(lateOpen).toMatchObject({ kind: "filled", summary: { status: "resolved", version: 3, question: "Will the demo work on the first try?" } });
    expect(isListed(lateOpen.summary)).toBe(true);
    expect(applyOpened(lateOpen.summary, factsOf(opened, "market_opened"), NOW).kind).toBe("stale");
    expect(applyResolved(lateOpen.summary, factsOf(resolved, "market_resolved"), NOW).kind).toBe("stale");
  });

  it("refuses an event of another market (a bug)", () => {
    expect(() => applyClosed(emptySummary(MARKET_2, T0), factsOf(closed, "market_closed"), NOW)).toThrow(DomainError);
  });

  it("knows the three statuses", () => {
    expect(isMarketStatus("open")).toBe(true);
    expect(isMarketStatus("funded")).toBe(false);
  });
});

describe("trades (sequence guard)", () => {
  it("adds volume and count for a new point and moves the last price only for a higher sequence", () => {
    const opening = applyOpened(emptySummary(MARKET_1, T0), factsOf(opened, "market_opened"), NOW).summary;
    const five = applyTrade(opening, tradePoint(factsOf(trade(5, 600_000, 3_000_000), "trade_executed")), NOW).summary;
    expect(five).toMatchObject({ tradeCount: 1, volumeMicro: 3_000_000, lastTradeSequence: 5, lastPriceYesMicro: 600_000, lastTradeAt: at(5) });
    expect(currentPriceYesMicro(five)).toBe(600_000);
    const lateThree = applyTrade(five, tradePoint(factsOf(trade(3, 450_000, 2_000_000), "trade_executed")), NOW).summary;
    expect(lateThree).toMatchObject({ tradeCount: 2, volumeMicro: 5_000_000, lastTradeSequence: 5, lastPriceYesMicro: 600_000, lastTradeAt: at(5) });
  });

  it("changes nothing for a repeated sequence (the store did not insert the point)", () => {
    const effect = effectOf(trade(1, 500_000), NOW);
    const summary = emptySummary(MARKET_1, T0);
    expect(effect.apply(summary, false)).toMatchObject({ kind: "stale", changed: false, summary });
    expect(effect.apply(summary, true).summary.tradeCount).toBe(1);
  });

  it("refuses a trade point of sequence 0 (the opening point is not a trade)", () => {
    const point = { ...tradePoint(factsOf(trade(1, 500_000), "trade_executed")), tradeSequence: OPENING_SEQUENCE };
    expect(() => applyTrade(emptySummary(MARKET_1, T0), point, NOW)).toThrow(DomainError);
  });

  it("starts the series at the starting price and counts no trade for it", () => {
    const state = foldEvents([opened], NOW);
    expect(state.points.get(pointKey(MARKET_1, OPENING_SEQUENCE))).toEqual({ marketId: MARKET_1, tradeSequence: 0, time: T0, priceYesMicro: 400_000, volumeMicro: 0 });
    expect(state.summaries.get(MARKET_1)).toMatchObject({ tradeCount: 0, lastPriceYesMicro: null });
  });
});

describe("the replay fold", () => {
  it("gives the same projection for every order of the same events, repeats included", () => {
    const events = [opened, closed, resolved, trade(1, 450_000), trade(2, 520_000, 2_500_000), trade(2, 520_000, 2_500_000)];
    const reference = foldEvents(events, NOW);
    for (const order of permutations(events)) {
      expect(projectionDifferences(foldEvents(order, NOW), reference)).toEqual([]);
    }
    expect(reference.summaries.get(MARKET_1)).toMatchObject({
      status: "resolved",
      outcome: "YES",
      tradeCount: 2,
      lastTradeSequence: 2,
      lastPriceYesMicro: 520_000,
      volumeMicro: 3_500_000,
    });
    expect(reference.points.size).toBe(3);
  });

  it("converges for a market seen first through a trade, and lists it only once MarketOpened arrived", () => {
    const state = emptyProjection();
    applyToProjection(state, trade(1, 470_000), NOW);
    const first = state.summaries.get(MARKET_1);
    expect(first).toMatchObject({ version: 0, status: null, tradeCount: 1, lastPriceYesMicro: 470_000 });
    expect(first && isListed(first)).toBe(false);
    expect(first && currentPriceYesMicro(first)).toBe(470_000);
    applyToProjection(state, opened, NOW);
    const listed = state.summaries.get(MARKET_1);
    expect(listed && isListed(listed)).toBe(true);
    expect(projectionDifferences(state, foldEvents([opened, trade(1, 470_000)], NOW))).toEqual([]);
  });

  it("reports the markets whose summaries or points differ", () => {
    const a = foldEvents([opened, trade(1, 450_000)], NOW);
    const b = foldEvents([opened, trade(1, 460_000)], NOW);
    expect(projectionDifferences(a, b)).toEqual([MARKET_1]);
    const other = foldEvents([projectionEvent(marketOpenedBody({ marketId: MARKET_2 }))], NOW);
    expect(projectionDifferences(a, other)).toEqual([MARKET_1, MARKET_2].sort());
  });

  it("compares summaries without their write time", () => {
    const one = foldEvents([opened], NOW).summaries.get(MARKET_1);
    const two = foldEvents([opened], at(2000)).summaries.get(MARKET_1);
    expect(one && two && sameSummary(one, two)).toBe(true);
    expect(one && two && sameSummary(one, { ...two, volumeMicro: 1 })).toBe(false);
  });

  it("keeps the last price of a market resolved INVALID (UC-16), or the starting price when nothing traded", () => {
    const traded = projectionEvent(tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 620_000 }));
    const invalid = projectionEvent(marketResolvedBody({ outcome: "INVALID" }));
    const withTrade = foldEvents([opened, traded, invalid], NOW).summaries.get(MARKET_1);
    expect(withTrade).toMatchObject({ status: "resolved", outcome: "INVALID", lastPriceYesMicro: 620_000 });
    expect(withTrade && currentPriceYesMicro(withTrade)).toBe(620_000);
    const untraded = foldEvents([opened, invalid], NOW).summaries.get(MARKET_1);
    expect(untraded && currentPriceYesMicro(untraded)).toBe(400_000);
  });

  it("shows the final price of a market resolved NO", () => {
    const state = foldEvents([opened, projectionEvent(marketResolvedBody({ outcome: "NO" }))], NOW);
    const summary = state.summaries.get(MARKET_1);
    expect(summary && currentPriceYesMicro(summary)).toBe(0);
  });
});
