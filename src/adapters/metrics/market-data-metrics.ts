// The metrics that only market-data has, next to the HTTP metrics of metrics.ts (the same registry, the same listener).
//
//   market_data_projection_events_total{result}      projection events (MarketOpened, MarketClosed, MarketResolved,
//                                                    TradeExecuted and the other types of the two streams) after their
//                                                    transaction committed, by what they did: applied, stale (an older
//                                                    or repeated fact), unprojected (stored, not projected) or
//                                                    duplicate (a redelivery).
//   market_data_projection_trade_sequence_gap        for every trade that changed the active projection: how many trades
//                                                    of the market with a lower sequence it has not seen yet (the
//                                                    highest sequence seen minus the trades seen), in trade sequences.
//                                                    0 is a projection that is complete up to its last trade; a
//                                                    positive value is a trade that arrived before an earlier one.
//   graphql_errors_total{code}                       the errors in the answers of the GraphQL endpoint, by the stable
//                                                    extensions.code (validation_failed, forbidden, depth_limit_exceeded,
//                                                    ...), never by operation name, field or message.
//
// The labels are fixed sets (the `code` of a GraphQL error is one of the constants of src/web/graphql/errors.ts and
// src/web/problems.ts; anything else is "unknown"), so a caller can never create a series.

import { Counter, Histogram } from "prom-client";
import type { Registry } from "prom-client";
import type { ProjectionObserver } from "../../usecases/ports.js";

/** The code label of an error answer that carries no usable code. */
export const UNKNOWN_CODE = "unknown";

/** A code is a short snake_case word: the pattern keeps even a bug from putting free text into a label. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

export interface MarketDataMetrics {
  /** Passed to RecordProjectionEvent. */
  observer: ProjectionObserver;
  /** Passed to the GraphQL endpoint: the `extensions.code` of each error of one answer (undefined when it has none). */
  graphqlErrors: (codes: ReadonlyArray<string | undefined>) => void;
}

export function createMarketDataMetrics(registry: Registry): MarketDataMetrics {
  const events = new Counter({
    name: "market_data_projection_events_total",
    help: "Projection events consumed, by result: applied, stale, unprojected or duplicate.",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const gap = new Histogram({
    name: "market_data_projection_trade_sequence_gap",
    help: "Trades with a lower sequence that the projection has not seen yet, observed for every trade that changed it, in trade sequences.",
    buckets: [0, 1, 2, 5, 10, 25, 50, 100],
    registers: [registry],
  });
  const graphqlErrors = new Counter({
    name: "graphql_errors_total",
    help: "Errors in the answers of the GraphQL endpoint, by error code.",
    labelNames: ["code"] as const,
    registers: [registry],
  });

  return {
    observer: {
      recorded: (result, tradeSequenceGap) => {
        events.inc({ result });
        if (tradeSequenceGap !== null) gap.observe(tradeSequenceGap);
      },
    },
    graphqlErrors: (codes) => {
      for (const code of codes) graphqlErrors.inc({ code: code !== undefined && CODE.test(code) ? code : UNKNOWN_CODE });
    },
  };
}
