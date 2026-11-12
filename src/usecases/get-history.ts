import { parseMarketId } from "../domain/consumed.js";
import { DEFAULT_INTERVAL, historyRange, parseInterval } from "../domain/history.js";
import type { HistoryRange } from "../domain/history.js";
import { HistoryPaused, guardDomain } from "./errors.js";
import type { ReadDeps } from "./ports.js";
import { DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE, decodeHistoryCursor, encodeHistoryCursor, pageSize, parseAfterSequence } from "./support.js";
import { loadListedMarket } from "./get-market.js";
import type { GetHistoryUseCase, HistoryInput, HistoryView } from "./use-cases.js";

/**
 * GET /v1/market-data/markets/{marketId}/history (plan 6.3, EP-4): the price points of one market in sparse buckets of a
 * fixed interval (open, high, low, close by trade sequence, volume, trades), ascending, with `previousCloseYesMicro` so
 * the chart can carry the last close forward into a first bucket that starts later.
 *
 * Order of checks (contract): shape, the runtime rule HISTORY_ENABLED (503 history_paused, ADR-037), the tenant, the
 * market (404), afterSequence (409), then the range and the cursor (400). Page 1 resolves its range (`historyRange`: the
 * newest HISTORY_MAX_POINTS buckets by default, `to` defaults to now, a span above HISTORY_MAX_POINTS is refused); the
 * cursor carries that RESOLVED range, so every later page continues exactly the range of page 1: it never recomputes `to`
 * from a later now and is never refused for the range's size again (a cursor that was handed out stays usable).
 */
export class GetHistory implements GetHistoryUseCase {
  constructor(private readonly deps: ReadDeps) {}

  async execute(input: HistoryInput): Promise<HistoryView> {
    const { store, clock, rules } = this.deps;
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    const interval = guardDomain(() => parseInterval(input.interval ?? DEFAULT_INTERVAL));
    const size = pageSize(input.limit, DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE);
    const afterSequence = parseAfterSequence(input.afterSequence);
    // Read once: a runtime change between the pause check and the range check must not give an answer neither rule allows.
    const current = rules.current();
    if (!current.enabled) throw new HistoryPaused();

    const { tenant, view } = await loadListedMarket(store, input.actor.tenantId, marketId, afterSequence);

    let range: HistoryRange;
    let pageStart: Date;
    if (input.cursor !== undefined) {
      ({ range, pageStart } = decodeHistoryCursor(input.cursor, { interval, from: input.from, to: input.to }));
    } else {
      range = guardDomain(() => historyRange({ interval, from: input.from, to: input.to, openedAt: view.openedAt, now: clock.now(), maxPoints: current.maxPoints }));
      pageStart = range.from;
    }

    const { readModel } = tenant.repositories;
    // One bucket more than the page, to know whether a next page exists.
    const buckets = await readModel.buckets(marketId, { interval, from: pageStart, to: range.to, limit: size + 1 });
    const next = buckets[size];
    const previous = await readModel.lastPointBefore(marketId, pageStart);
    return {
      marketId,
      interval,
      from: range.from,
      to: range.to,
      previousCloseYesMicro: previous?.priceYesMicro ?? null,
      buckets: buckets.slice(0, size),
      nextCursor: next === undefined ? null : encodeHistoryCursor(next.start, range),
    };
  }
}
