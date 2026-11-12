import type { FastifyInstance } from "fastify";
import type { HistoryView, MarketDataUseCases, MarketView } from "../../usecases/use-cases.js";
import { memberHook } from "../auth.js";
import type { RequestHook } from "../auth.js";
import { actorOf } from "../context.js";
import { schemas } from "../schemas.js";

/** A market as `components/schemas/Market` of contracts/openapi.yaml: dates as ISO 8601 text. */
export const marketBody = (market: MarketView) => ({
  marketId: market.marketId,
  question: market.question,
  status: market.status,
  closeTime: market.closeTime.toISOString(),
  openedAt: market.openedAt.toISOString(),
  closedAt: market.closedAt?.toISOString() ?? null,
  resolvedAt: market.resolvedAt?.toISOString() ?? null,
  outcome: market.outcome,
  startingPriceYesMicro: market.startingPriceYesMicro,
  lastPriceYesMicro: market.lastPriceYesMicro,
  currentPriceYesMicro: market.currentPriceYesMicro,
  volumeMicro: market.volumeMicro,
  tradeCount: market.tradeCount,
  lastTradeSequence: market.lastTradeSequence,
  lastTradeAt: market.lastTradeAt?.toISOString() ?? null,
  version: market.version,
  updatedAt: market.updatedAt.toISOString(),
});

/** The history as `components/schemas/History`. */
export const historyBody = (history: HistoryView) => ({
  marketId: history.marketId,
  interval: history.interval,
  from: history.from.toISOString(),
  to: history.to.toISOString(),
  previousCloseYesMicro: history.previousCloseYesMicro,
  buckets: history.buckets.map((bucket) => ({
    start: bucket.start.toISOString(),
    openYesMicro: bucket.openYesMicro,
    highYesMicro: bucket.highYesMicro,
    lowYesMicro: bucket.lowYesMicro,
    closeYesMicro: bucket.closeYesMicro,
    volumeMicro: bucket.volumeMicro,
    trades: bucket.trades,
  })),
  nextCursor: history.nextCursor,
});

/**
 * The three read routes of the caller's tenant. Authentication is an onRequest hook (401 first); the role check runs in
 * preValidation, before the query or the path is validated, so a caller without rights learns nothing from validation.
 * The tenant is never read from the request: the use cases get it from the token (actorOf). Traders and tenant admins
 * read everything.
 */
export function registerMarketRoutes(app: FastifyInstance, useCases: MarketDataUseCases, authenticate: RequestHook): void {
  app.get<{ Querystring: { status?: string; limit?: number; cursor?: string; ids?: string } }>(
    "/v1/market-data/markets",
    { schema: schemas.listMarkets, onRequest: authenticate, preValidation: memberHook },
    async (request) => {
      const { status, limit, cursor, ids } = request.query;
      const page = await useCases.listMarkets.execute({
        actor: actorOf(request),
        // The schema keeps `status` to the three statuses; the use case checks it again for other callers.
        ...(status === undefined ? {} : { status: status as "open" | "closed" | "resolved" }),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(ids === undefined ? {} : { ids: ids.split(",") }),
      });
      return { items: page.items.map(marketBody), nextCursor: page.nextCursor };
    },
  );

  app.get<{ Params: { marketId: string }; Querystring: { afterSequence?: number } }>(
    "/v1/market-data/markets/:marketId",
    { schema: schemas.getMarket, onRequest: authenticate, preValidation: memberHook },
    async (request) =>
      marketBody(
        await useCases.getMarket.execute({
          actor: actorOf(request),
          marketId: request.params.marketId.toLowerCase(),
          ...(request.query.afterSequence === undefined ? {} : { afterSequence: request.query.afterSequence }),
        }),
      ),
  );

  app.get<{ Params: { marketId: string }; Querystring: { interval?: string; from?: string; to?: string; limit?: number; cursor?: string; afterSequence?: number } }>(
    "/v1/market-data/markets/:marketId/history",
    { schema: schemas.getHistory, onRequest: authenticate, preValidation: memberHook },
    async (request) => {
      const { interval, from, to, limit, cursor, afterSequence } = request.query;
      // The schema's date-time format accepts a leap second such as 23:59:60, which `new Date` turns into an Invalid Date:
      // it is passed on as it is, and the use case answers it with 400 on that field.
      const history = await useCases.getHistory.execute({
        actor: actorOf(request),
        marketId: request.params.marketId.toLowerCase(),
        ...(interval === undefined ? {} : { interval }),
        ...(from === undefined ? {} : { from: new Date(from) }),
        ...(to === undefined ? {} : { to: new Date(to) }),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(afterSequence === undefined ? {} : { afterSequence }),
      });
      return historyBody(history);
    },
  );
}
