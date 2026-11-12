import type { FastifyReply } from "fastify";
import type { MercuriusContext } from "mercurius";
import type { Interval } from "../../domain/history.js";
import type { MarketStatus } from "../../domain/projection.js";
import { ValidationFailed } from "../../usecases/errors.js";
import type { Actor } from "../../usecases/ports.js";
import type { HistoryView, MarketDataUseCases, MarketView } from "../../usecases/use-cases.js";
import { dateTimeScalar, longScalar } from "./scalars.js";

// The three queries of contracts/graphql/schema.graphql. They call exactly the use cases of the REST routes
// (MarketDataUseCases): there is no second data path, and the use cases are the only place that checks a value, finds a
// market or decides an error. What is here only renames: the enums (GraphQL names cannot start with a digit), the
// arguments (`first` and `after` are `limit` and `cursor`) and the page (`pageInfo`).

/** What the route puts in the GraphQL context: the caller, taken from the token, and never from the query. */
export interface GraphqlContext {
  actor: Actor;
  reply: FastifyReply;
}

/** The caller of a resolver. mercurius types the context of every resolver as its own; the route made it a GraphqlContext. */
const actorIn = (context: MercuriusContext): Actor => (context as unknown as GraphqlContext).actor;

// A Record over the domain's own lists: a status or an interval added there fails to compile until it is named here.
export const STATUS_NAME: Readonly<Record<MarketStatus, string>> = { open: "OPEN", closed: "CLOSED", resolved: "RESOLVED" };
export const INTERVAL_NAME: Readonly<Record<Interval, string>> = {
  "1m": "ONE_MINUTE",
  "5m": "FIVE_MINUTES",
  "15m": "FIFTEEN_MINUTES",
  "1h": "ONE_HOUR",
  "4h": "FOUR_HOURS",
  "1d": "ONE_DAY",
};
const reversed = <K extends string>(names: Readonly<Record<K, string>>): ReadonlyMap<string, K> =>
  new Map((Object.entries(names) as Array<[K, string]>).map(([key, name]) => [name, key]));
const STATUS_BY_NAME = reversed(STATUS_NAME);
const INTERVAL_BY_NAME = reversed(INTERVAL_NAME);

/** The argument names of a GraphQL field for the names the use cases report their field errors under. */
type Renames = Readonly<Record<string, string>>;
const PAGING: Renames = { limit: "first", cursor: "after" };

/**
 * A validation failure names its field as the REST API does (`limit`, `cursor`, `marketId`); here the caller sent
 * `first`, `after` or `id`, so the field and the first word of its message are renamed. Nothing else changes.
 */
function renamed(error: unknown, renames: Renames): unknown {
  if (!(error instanceof ValidationFailed)) return error;
  const fields = error.fields.map(({ field, message }) => {
    const to = renames[field];
    return to === undefined ? { field, message } : { field: to, message: message.startsWith(field) ? to + message.slice(field.length) : message };
  });
  return new ValidationFailed(fields, error.message, error.code, error.details);
}

async function run<T>(renames: Renames, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw renamed(error, renames);
  }
}

/** A GraphQL argument that was left out or sent as null is absent, as a REST parameter that was not sent. */
const given = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

const pageInfoOf = (nextCursor: string | null) => ({ hasNextPage: nextCursor !== null, endCursor: nextCursor });

interface MarketsArgs {
  status?: string | null;
  ids?: string[] | null;
  first?: number | null;
  after?: string | null;
}
interface MarketArgs {
  id: string;
  afterSequence?: number | null;
}
interface HistoryArgs {
  marketId: string;
  interval?: string | null;
  from?: Date | null;
  to?: Date | null;
  first?: number | null;
  after?: string | null;
  afterSequence?: number | null;
}

export function createResolvers(useCases: MarketDataUseCases) {
  return {
    DateTime: dateTimeScalar,
    Long: longScalar,
    Query: {
      markets: (_root: unknown, args: MarketsArgs, context: MercuriusContext) =>
        run(PAGING, async () => {
          const status = given(args.status);
          const ids = given(args.ids);
          const first = given(args.first);
          const after = given(args.after);
          const page = await useCases.listMarkets.execute({
            actor: actorIn(context),
            ...(status === undefined ? {} : { status: STATUS_BY_NAME.get(status) }),
            ...(first === undefined ? {} : { limit: first }),
            ...(after === undefined ? {} : { cursor: after }),
            ...(ids === undefined ? {} : { ids }),
          });
          return { items: page.items, pageInfo: pageInfoOf(page.nextCursor) };
        }),

      market: (_root: unknown, args: MarketArgs, context: MercuriusContext) =>
        run({ marketId: "id" }, () => {
          const afterSequence = given(args.afterSequence);
          return useCases.getMarket.execute({
            actor: actorIn(context),
            marketId: args.id.toLowerCase(),
            ...(afterSequence === undefined ? {} : { afterSequence }),
          });
        }),

      history: (_root: unknown, args: HistoryArgs, context: MercuriusContext) =>
        run(PAGING, async () => {
          const [interval, from, to, first, after, afterSequence] = [given(args.interval), given(args.from), given(args.to), given(args.first), given(args.after), given(args.afterSequence)];
          const view = await useCases.getHistory.execute({
            actor: actorIn(context),
            marketId: args.marketId.toLowerCase(),
            ...(interval === undefined ? {} : { interval: INTERVAL_BY_NAME.get(interval) }),
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(first === undefined ? {} : { limit: first }),
            ...(after === undefined ? {} : { cursor: after }),
            ...(afterSequence === undefined ? {} : { afterSequence }),
          });
          return { ...view, pageInfo: pageInfoOf(view.nextCursor) };
        }),
    },
    Market: {
      status: (market: MarketView) => STATUS_NAME[market.status],
    },
    PriceHistory: {
      interval: (history: HistoryView) => INTERVAL_NAME[history.interval],
    },
  };
}
