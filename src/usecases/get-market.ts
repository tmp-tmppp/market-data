import { parseMarketId } from "../domain/consumed.js";
import { isListed } from "../domain/projection.js";
import type { MarketSummary } from "../domain/projection.js";
import { NotFound, TenantNotReady, Updating, guardDomain } from "./errors.js";
import type { Store, TenantStore, UseCaseDeps } from "./ports.js";
import { marketViewOf, parseAfterSequence } from "./support.js";
import type { GetMarketInput, GetMarketUseCase, MarketView } from "./use-cases.js";

/**
 * The checks every read of one market shares, in the order of the contract (the web layer has already refused platform
 * admins and tokens without a tenant role): the tenant's schema (TenantNotReady, 503), the market in the active
 * projection version (NotFound, 404, also while its MarketOpened has not arrived: the summary exists but is not listed),
 * then DM-17's afterSequence (Updating, 409, until the caller's trade has its price point). The tenant comes from the
 * token, so a market of another tenant is simply not in this schema: NotFound, never a hint that it exists.
 */
export async function loadListedMarket(
  store: Store,
  tenantId: string,
  marketId: string,
  afterSequence: number | undefined,
): Promise<{ tenant: TenantStore; summary: MarketSummary; view: MarketView }> {
  const tenant = await store.forTenant(tenantId);
  if (tenant === null) throw new TenantNotReady();
  const { readModel } = tenant.repositories;
  // The point is read BEFORE the summary: the two are separate statements, and the consumer commits a trade's point and its
  // summary together. A trade that commits between the two reads then shows in the summary read second (a 409 at worst,
  // which the client retries); read the other way round, a point that has just appeared would be paired with a summary
  // that does not include its trade, and the 200 is the answer the client stops asking on (DM-17). 404 still comes first:
  // the answer to a missing market never depends on the point.
  const pointSeen = afterSequence === undefined ? true : await readModel.hasPoint(marketId, afterSequence);
  const summary = await readModel.summary(marketId);
  if (summary === null || !isListed(summary)) throw new NotFound();
  if (!pointSeen) throw new Updating(summary.lastTradeSequence);
  return { tenant, summary, view: marketViewOf(summary) };
}

/**
 * GET /v1/market-data/markets/{marketId} (plan 6.3, EP-4): one market of the read model. `afterSequence` is DM-17's
 * read-your-writes: the portfolio and the order form pass the tradeSequence of their order answer and get 409 `updating`
 * with the summary's lastTradeSequence until that trade is projected (the client asks again for about two seconds).
 */
export class GetMarket implements GetMarketUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: GetMarketInput): Promise<MarketView> {
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    const afterSequence = parseAfterSequence(input.afterSequence);
    const { view } = await loadListedMarket(this.deps.store, input.actor.tenantId, marketId, afterSequence);
    return view;
  }
}
