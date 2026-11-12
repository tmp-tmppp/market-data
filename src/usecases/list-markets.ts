import { isListed, isMarketStatus } from "../domain/projection.js";
import { TenantNotReady, ValidationFailed } from "./errors.js";
import type { UseCaseDeps } from "./ports.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, decodeMarketCursor, encodeMarketCursor, marketViewOf, pageSize, parseIds } from "./support.js";
import type { PageOf } from "./support.js";
import type { ListMarketsInput, ListMarketsUseCase, MarketView } from "./use-cases.js";

/**
 * GET /v1/market-data/markets (plan 6.3, EP-4). Two shapes, never mixed:
 * - a page: the listed markets of the caller's tenant, newest first (market id descending: UUIDv7), optionally by status,
 *   with an opaque cursor;
 * - a batch (`ids`, DM-12): the portfolio page asks for the prices of all its positions in ONE call. The items come in
 *   the order of `ids` (duplicates collapsed), an id that is unknown, belongs to another tenant or whose MarketOpened has
 *   not arrived is left out, and there is no next page.
 * A market is served only once its MarketOpened has filled the question (`isListed`), so a market first seen through a
 * trade is absent until then.
 */
export class ListMarkets implements ListMarketsUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: ListMarketsInput): Promise<PageOf<MarketView>> {
    const { store } = this.deps;
    if (input.ids !== undefined) {
      if (input.status !== undefined || input.limit !== undefined || input.cursor !== undefined) {
        throw new ValidationFailed([{ field: "ids", message: "ids cannot be combined with status, limit or cursor" }]);
      }
      const ids = parseIds(input.ids);
      const tenant = await store.forTenant(input.actor.tenantId);
      if (tenant === null) throw new TenantNotReady();
      const found = new Map((await tenant.repositories.readModel.summariesOf(ids)).filter(isListed).map((summary) => [summary.marketId, summary] as const));
      const items = ids.flatMap((id) => {
        const summary = found.get(id);
        return summary === undefined ? [] : [marketViewOf(summary)];
      });
      return { items, nextCursor: null };
    }

    if (input.status !== undefined && !isMarketStatus(input.status)) throw new ValidationFailed([{ field: "status", message: "status must be open, closed or resolved" }]);
    const size = pageSize(input.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const beforeId = decodeMarketCursor(input.cursor);
    const tenant = await store.forTenant(input.actor.tenantId);
    if (tenant === null) throw new TenantNotReady();
    // One row more than the page, to know whether a next page exists without a count.
    const rows = await tenant.repositories.readModel.listSummaries({ status: input.status ?? null, beforeId, limit: size + 1 });
    const page = rows.slice(0, size);
    const last = page.at(-1);
    return { items: page.map(marketViewOf), nextCursor: rows.length > size && last !== undefined ? encodeMarketCursor(last.marketId) : null };
  }
}
