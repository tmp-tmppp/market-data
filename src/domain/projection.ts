import type { ClosedFacts, OpenedFacts, ProjectionEvent, ResolvedFacts, TradeFacts } from "./consumed.js";
import { DomainError } from "./errors.js";
import { RESOLVED_NO_PRICE_MICRO, RESOLVED_YES_PRICE_MICRO, addMicro } from "./units.js";
import type { Outcome } from "./units.js";

// The read model of market-data (CQRS read side, EP-4, ADR-021): one summary per market for the list and the detail
// header, and one price point per trade for the chart. Every rule here is a pure function of the summary and one event,
// and the rules commute: whatever order the events of a market arrive in (redeliveries, a nak and a later retry, two
// consumers, a replay), the summary and the points end up the same.
// - Lifecycle events (MarketOpened, MarketClosed, MarketResolved) carry markets' version of the market (DM-04): an
//   event changes the status only when its version is higher than the stored one. An older event still fills the facts
//   that are missing (a MarketOpened that arrives after MarketClosed fills the question, the close time and the starting
//   price; a MarketClosed after MarketResolved fills closedAt), never the status, the version or the outcome.
// - Trades carry the market's trade sequence (1, 2, 3 ... without gaps). A price point is stored once per (market,
//   sequence) (DM-10); only a point that is new adds to the volume and the trade count, and only the highest sequence
//   sets the last price. A repeated sequence changes nothing; an older one that arrives late still adds its point.
// - A market seen first through a trade or a later lifecycle event gets an empty summary (version 0, no question). It
//   is not listed until its MarketOpened has filled the question (isListed), and then it is complete.

export const MARKET_STATUSES = ["open", "closed", "resolved"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];

export function isMarketStatus(value: unknown): value is MarketStatus {
  return typeof value === "string" && (MARKET_STATUSES as readonly string[]).includes(value);
}

/** One market of the read model (table market_summaries, one row per projection version and market). */
export interface MarketSummary {
  marketId: string;
  /** markets' version of the market (DM-04); 0 until a lifecycle event was applied. */
  version: number;
  /** Null while version is 0. */
  status: MarketStatus | null;
  /** From MarketOpened; null until it arrived. */
  question: string | null;
  closeTime: Date | null;
  startingPriceYesMicro: number | null;
  openedAt: Date | null;
  closedAt: Date | null;
  resolvedAt: Date | null;
  /** Set exactly when status is "resolved". */
  outcome: Outcome | null;
  /** The YES price of the trade with the highest sequence; null until a trade arrived. */
  lastPriceYesMicro: number | null;
  /** The highest trade sequence seen; 0 without trades. */
  lastTradeSequence: number;
  lastTradeAt: Date | null;
  /** Distinct trades seen (sequences >= 1). Equals lastTradeSequence once every trade has arrived. */
  tradeCount: number;
  /** Sum of the trades' costMicro: microcredits traded. */
  volumeMicro: number;
  /** When this row last changed. Not part of the projection's content: comparisons ignore it. */
  updatedAt: Date;
}

/** One point of the price series (table price_points, one row per projection version, market and sequence). */
export interface PricePoint {
  marketId: string;
  /** OPENING_SEQUENCE (0) for the starting price from MarketOpened; the trade sequence (>= 1) for a trade. */
  tradeSequence: number;
  /** openedAt for the opening point, executedAt for a trade. */
  time: Date;
  priceYesMicro: number;
  /** costMicro of the trade; 0 for the opening point. */
  volumeMicro: number;
}

/** The sequence of the opening point: the series starts at the starting price (plan 6.3). */
export const OPENING_SEQUENCE = 0;

/** "applied": the event's version or sequence was new; "filled": an older event filled missing facts; "stale": nothing changed. */
export type ApplyKind = "applied" | "filled" | "stale";

export interface Applied {
  summary: MarketSummary;
  /** False for "stale": the caller writes nothing. */
  changed: boolean;
  kind: ApplyKind;
}

const stale = (summary: MarketSummary): Applied => ({ summary, changed: false, kind: "stale" });

/** The summary of a market nothing is known about yet. */
export function emptySummary(marketId: string, now: Date): MarketSummary {
  return {
    marketId,
    version: 0,
    status: null,
    question: null,
    closeTime: null,
    startingPriceYesMicro: null,
    openedAt: null,
    closedAt: null,
    resolvedAt: null,
    outcome: null,
    lastPriceYesMicro: null,
    lastTradeSequence: 0,
    lastTradeAt: null,
    tradeCount: 0,
    volumeMicro: 0,
    updatedAt: now,
  };
}

function assertSameMarket(summary: MarketSummary, marketId: string): void {
  if (summary.marketId !== marketId) throw new DomainError("invariant_violated", `An event of market ${marketId} was applied to the summary of ${summary.marketId}`);
}

/** MarketOpened: status "open" when its version is new; otherwise it only fills the static facts that are missing. */
export function applyOpened(summary: MarketSummary, facts: OpenedFacts, now: Date): Applied {
  assertSameMarket(summary, facts.marketId);
  const statics = { question: facts.question, closeTime: facts.closeTime, startingPriceYesMicro: facts.startingPriceYesMicro, openedAt: facts.openedAt };
  if (facts.version > summary.version) {
    return { summary: { ...summary, ...statics, version: facts.version, status: "open", updatedAt: now }, changed: true, kind: "applied" };
  }
  if (summary.question !== null && summary.closeTime !== null && summary.startingPriceYesMicro !== null && summary.openedAt !== null) return stale(summary);
  return {
    summary: {
      ...summary,
      question: summary.question ?? statics.question,
      closeTime: summary.closeTime ?? statics.closeTime,
      startingPriceYesMicro: summary.startingPriceYesMicro ?? statics.startingPriceYesMicro,
      openedAt: summary.openedAt ?? statics.openedAt,
      updatedAt: now,
    },
    changed: true,
    kind: "filled",
  };
}

/** MarketClosed: status "closed" when its version is new; otherwise it only fills a missing closedAt. */
export function applyClosed(summary: MarketSummary, facts: ClosedFacts, now: Date): Applied {
  assertSameMarket(summary, facts.marketId);
  if (facts.version > summary.version) {
    return { summary: { ...summary, version: facts.version, status: "closed", closedAt: facts.closedAt, updatedAt: now }, changed: true, kind: "applied" };
  }
  if (summary.closedAt !== null) return stale(summary);
  return { summary: { ...summary, closedAt: facts.closedAt, updatedAt: now }, changed: true, kind: "filled" };
}

/**
 * MarketResolved: status "resolved" with the outcome when its version is new (FL-A step 10: the final price, see
 * currentPriceYesMicro). An older one changes nothing: the outcome only ever comes with the status.
 */
export function applyResolved(summary: MarketSummary, facts: ResolvedFacts, now: Date): Applied {
  assertSameMarket(summary, facts.marketId);
  if (facts.version > summary.version) {
    return {
      summary: { ...summary, version: facts.version, status: "resolved", outcome: facts.outcome, resolvedAt: facts.resolvedAt, updatedAt: now },
      changed: true,
      kind: "applied",
    };
  }
  return stale(summary);
}

/** The opening point of the series: the starting price at openedAt, no volume. */
export function openingPoint(facts: OpenedFacts): PricePoint {
  return { marketId: facts.marketId, tradeSequence: OPENING_SEQUENCE, time: facts.openedAt, priceYesMicro: facts.startingPriceYesMicro, volumeMicro: 0 };
}

/** The price point of a trade. */
export function tradePoint(facts: TradeFacts): PricePoint {
  return { marketId: facts.marketId, tradeSequence: facts.tradeSequence, time: facts.executedAt, priceYesMicro: facts.priceYesMicro, volumeMicro: facts.volumeMicro };
}

/**
 * A trade whose price point was NEW in this projection version (the store inserted it: the caller never calls this for
 * a repeated sequence). Adds the volume and the count; the last price moves only for a higher sequence.
 */
export function applyTrade(summary: MarketSummary, point: PricePoint, now: Date): Applied {
  assertSameMarket(summary, point.marketId);
  if (!Number.isSafeInteger(point.tradeSequence) || point.tradeSequence < 1) {
    throw new DomainError("invariant_violated", `A trade must have a sequence of 1 or more, not ${point.tradeSequence}`);
  }
  const newest = point.tradeSequence > summary.lastTradeSequence;
  return {
    summary: {
      ...summary,
      tradeCount: summary.tradeCount + 1,
      volumeMicro: addMicro(summary.volumeMicro, point.volumeMicro),
      lastTradeSequence: newest ? point.tradeSequence : summary.lastTradeSequence,
      lastPriceYesMicro: newest ? point.priceYesMicro : summary.lastPriceYesMicro,
      lastTradeAt: newest ? point.time : summary.lastTradeAt,
      updatedAt: now,
    },
    changed: true,
    kind: "applied",
  };
}

/**
 * What one event does to one market in one projection version, the same for the live consumer and the replay
 * (ADR-032: "the same handlers"): first the point is stored if absent (`point`, null for MarketClosed and
 * MarketResolved), then `apply` gets the market's summary (emptySummary when there is none) and whether the store
 * inserted the point.
 */
export interface EventEffect {
  marketId: string;
  point: PricePoint | null;
  apply(summary: MarketSummary, pointInserted: boolean): Applied;
}

export function effectOf(event: ProjectionEvent, now: Date): EventEffect {
  switch (event.kind) {
    case "market_opened": {
      const facts = event.facts;
      return { marketId: facts.marketId, point: openingPoint(facts), apply: (summary) => applyOpened(summary, facts, now) };
    }
    case "market_closed": {
      const facts = event.facts;
      return { marketId: facts.marketId, point: null, apply: (summary) => applyClosed(summary, facts, now) };
    }
    case "market_resolved": {
      const facts = event.facts;
      return { marketId: facts.marketId, point: null, apply: (summary) => applyResolved(summary, facts, now) };
    }
    case "trade_executed": {
      const point = tradePoint(event.facts);
      return { marketId: point.marketId, point, apply: (summary, inserted) => (inserted ? applyTrade(summary, point, now) : stale(summary)) };
    }
  }
}

/** A market is served (list, detail, ids, history) once its MarketOpened has filled the question and a status is known. */
export function isListed(summary: MarketSummary): boolean {
  return summary.question !== null && summary.status !== null && summary.closeTime !== null && summary.startingPriceYesMicro !== null && summary.openedAt !== null;
}

/**
 * The YES price the list and the detail show: the outcome's final price once resolved (1 000 000 for YES, 0 for NO),
 * else the last trade's price, else the starting price; null only for a summary that is not listed. The NO price is
 * always 1 000 000 minus it. A market resolved INVALID (UC-16) has no final price: nothing paid one credit, every stake
 * was refunded, so it keeps the last price it traded at (else its starting price), and `outcome` says it was cancelled.
 */
export function currentPriceYesMicro(summary: MarketSummary): number | null {
  if (summary.status === "resolved" && summary.outcome === "YES") return RESOLVED_YES_PRICE_MICRO;
  if (summary.status === "resolved" && summary.outcome === "NO") return RESOLVED_NO_PRICE_MICRO;
  return summary.lastPriceYesMicro ?? summary.startingPriceYesMicro;
}

const time = (value: Date | null): number | null => (value === null ? null : value.getTime());

/** Equal content; `updatedAt` is ignored (it records when a row was written, which differs between a replay and live). */
export function sameSummary(a: MarketSummary, b: MarketSummary): boolean {
  return (
    a.marketId === b.marketId &&
    a.version === b.version &&
    a.status === b.status &&
    a.question === b.question &&
    time(a.closeTime) === time(b.closeTime) &&
    a.startingPriceYesMicro === b.startingPriceYesMicro &&
    time(a.openedAt) === time(b.openedAt) &&
    time(a.closedAt) === time(b.closedAt) &&
    time(a.resolvedAt) === time(b.resolvedAt) &&
    a.outcome === b.outcome &&
    a.lastPriceYesMicro === b.lastPriceYesMicro &&
    a.lastTradeSequence === b.lastTradeSequence &&
    time(a.lastTradeAt) === time(b.lastTradeAt) &&
    a.tradeCount === b.tradeCount &&
    a.volumeMicro === b.volumeMicro
  );
}

export function samePoint(a: PricePoint, b: PricePoint): boolean {
  return a.marketId === b.marketId && a.tradeSequence === b.tradeSequence && a.time.getTime() === b.time.getTime() && a.priceYesMicro === b.priceYesMicro && a.volumeMicro === b.volumeMicro;
}

// The replay fold: the whole projection of a list of events, in memory. The memory store keeps its projection versions
// in this shape, and the tests use it to show that any order of the same events gives the same projection.

export interface ProjectionState {
  summaries: Map<string, MarketSummary>;
  /** Keyed by pointKey(marketId, tradeSequence). */
  points: Map<string, PricePoint>;
}

export function pointKey(marketId: string, tradeSequence: number): string {
  return `${marketId}/${tradeSequence}`;
}

export function emptyProjection(): ProjectionState {
  return { summaries: new Map(), points: new Map() };
}

/** Applies one event to an in-memory projection (changes `state`), exactly as the store does it. */
export function applyToProjection(state: ProjectionState, event: ProjectionEvent, now: Date): Applied {
  const effect = effectOf(event, now);
  let inserted = false;
  if (effect.point !== null) {
    const key = pointKey(effect.point.marketId, effect.point.tradeSequence);
    if (!state.points.has(key)) {
      state.points.set(key, effect.point);
      inserted = true;
    }
  }
  const current = state.summaries.get(effect.marketId) ?? emptySummary(effect.marketId, now);
  const applied = effect.apply(current, inserted);
  // As the store: a summary is written only when it changed (a point and its summary are always written together).
  if (applied.changed) state.summaries.set(effect.marketId, applied.summary);
  return applied;
}

/** The projection of `events`, applied in the given order. */
export function foldEvents(events: Iterable<ProjectionEvent>, now: Date): ProjectionState {
  const state = emptyProjection();
  for (const event of events) applyToProjection(state, event, now);
  return state;
}

/** The market ids whose summaries or points differ between two projections, sorted. Empty when they are equal. */
export function projectionDifferences(a: ProjectionState, b: ProjectionState): string[] {
  const differing = new Set<string>();
  for (const id of new Set([...a.summaries.keys(), ...b.summaries.keys()])) {
    const left = a.summaries.get(id);
    const right = b.summaries.get(id);
    if (left === undefined || right === undefined || !sameSummary(left, right)) differing.add(id);
  }
  for (const key of new Set([...a.points.keys(), ...b.points.keys()])) {
    const left = a.points.get(key);
    const right = b.points.get(key);
    if (left === undefined || right === undefined || !samePoint(left, right)) differing.add((left ?? right)?.marketId ?? key);
  }
  return [...differing].sort();
}
