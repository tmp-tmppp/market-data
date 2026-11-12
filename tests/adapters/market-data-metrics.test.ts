import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import { UNKNOWN_CODE, createMarketDataMetrics } from "../../src/adapters/metrics/market-data-metrics.js";
import type { ProjectionObserver } from "../../src/usecases/ports.js";
import { graphqlErrorCodes } from "../../src/web/graphql/errors.js";
import { MARKET_1, MARKET_2, marketClosedBody, marketOpenedBody, tradeExecutedBody } from "../support/fakes.js";
import { consume, consumeAll, createCore } from "../usecases/core.js";

// The projection and GraphQL metrics of the service (src/adapters/metrics/market-data-metrics.ts): the counters on their
// own, the observer on the real use case over the in-memory store, and the reader of the GraphQL error codes.

interface Sample {
  labels: Record<string, string | number>;
  value: number;
  metricName?: string;
}

const trade = (marketId: string, tradeSequence: number) => tradeExecutedBody({ marketId, tradeSequence, yesPriceMicro: 450_000 });

async function samples(registry: Registry, name: string): Promise<Sample[]> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  return (await metric.get()).values as Sample[];
}

describe("graphql_errors_total", () => {
  it("counts every error by its code, an answer with two errors twice", async () => {
    const registry = new Registry();
    const { graphqlErrors } = createMarketDataMetrics(registry);
    graphqlErrors(["not_found", "validation_failed"]);
    graphqlErrors(["not_found"]);
    expect(await samples(registry, "graphql_errors_total")).toEqual([
      { value: 2, labels: { code: "not_found" } },
      { value: 1, labels: { code: "validation_failed" } },
    ]);
  });

  it('puts a missing code or a value that is not a short snake_case word under "unknown", never into a label', async () => {
    const registry = new Registry();
    const { graphqlErrors } = createMarketDataMetrics(registry);
    graphqlErrors([undefined, "Not A Code", "x".repeat(200), 'quote"', ""]);
    expect(await samples(registry, "graphql_errors_total")).toEqual([{ value: 5, labels: { code: UNKNOWN_CODE } }]);
  });
});

describe("graphqlErrorCodes", () => {
  it("reads extensions.code of each error, in order, and undefined for an error without one", () => {
    const body = JSON.stringify({ data: null, errors: [{ message: "a", extensions: { code: "forbidden", status: 403 } }, { message: "b" }, { message: "c", extensions: { code: 7 } }] });
    expect(graphqlErrorCodes(body)).toEqual(["forbidden", undefined, undefined]);
  });

  it("is empty for an answer without errors, for a body that is not JSON and for anything that is not text", () => {
    expect(graphqlErrorCodes(JSON.stringify({ data: { markets: null } }))).toEqual([]);
    expect(graphqlErrorCodes('{"errors": not json')).toEqual([]);
    expect(graphqlErrorCodes('{"title":"mentions \\"errors\\" in text"}')).toEqual([]);
    expect(graphqlErrorCodes(JSON.stringify({ errors: "nope" }))).toEqual([]);
    expect(graphqlErrorCodes(JSON.stringify({ errors: [null, 5] }))).toEqual([undefined, undefined]);
    expect(graphqlErrorCodes(Buffer.from('{"errors":[]}'))).toEqual([]);
    expect(graphqlErrorCodes(undefined)).toEqual([]);
  });
});

describe("the projection observer on the real use case", () => {
  function observed() {
    const registry = new Registry();
    const metrics = createMarketDataMetrics(registry);
    return { registry, core: createCore({ observer: metrics.observer }) };
  }

  it("counts every event by its result after its transaction committed", async () => {
    const { registry, core } = observed();
    const open = marketOpenedBody({ marketId: MARKET_1 });
    expect(await consumeAll(core, [open, trade(MARKET_1, 1), trade(MARKET_1, 1), marketClosedBody({ marketId: MARKET_1 })])).toEqual(["applied", "applied", "stale", "applied"]);
    // The same message again (a redelivery): the inbox says duplicate.
    expect(await consume(core, open)).toBe("duplicate");
    const values = await samples(registry, "market_data_projection_events_total");
    const count = (result: string) => values.find((sample) => sample.labels["result"] === result)?.value;
    expect(count("applied")).toBe(3);
    expect(count("stale")).toBe(1);
    expect(count("duplicate")).toBe(1);
  });

  it("observes the trade-sequence gap of each trade that changed the projection: 0 in order, positive when one arrived early, 0 again once it is filled", async () => {
    const { registry, core } = observed();
    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    for (const sequence of [1, 4, 2, 3]) await consume(core, trade(MARKET_1, sequence));
    // Trade 4 arrived with 2 and 3 missing (gap 2); 2 leaves one missing (gap 1); 3 completes it (gap 0): 0, 2, 1, 0.
    const values = await samples(registry, "market_data_projection_trade_sequence_gap");
    const at = (name: string, le?: string) => values.find((sample) => sample.metricName === name && (le === undefined || String(sample.labels["le"]) === le))?.value;
    expect(at("market_data_projection_trade_sequence_gap_count")).toBe(4);
    expect(at("market_data_projection_trade_sequence_gap_sum")).toBe(3);
    expect(at("market_data_projection_trade_sequence_gap_bucket", "0")).toBe(2);
    expect(at("market_data_projection_trade_sequence_gap_bucket", "1")).toBe(3);
    expect(at("market_data_projection_trade_sequence_gap_bucket", "2")).toBe(4);
  });

  it("observes no gap for a lifecycle event or a stale trade, and one for every applied trade of any market", async () => {
    const { registry, core } = observed();
    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    await consume(core, trade(MARKET_1, 1));
    await consume(core, trade(MARKET_1, 1));
    await consume(core, marketClosedBody({ marketId: MARKET_1 }));
    const count = (await samples(registry, "market_data_projection_trade_sequence_gap")).find((sample) => sample.metricName === "market_data_projection_trade_sequence_gap_count");
    expect(count?.value).toBe(1);
    await consume(core, trade(MARKET_2, 1));
    const after = (await samples(registry, "market_data_projection_trade_sequence_gap")).find((sample) => sample.metricName === "market_data_projection_trade_sequence_gap_count");
    expect(after?.value).toBe(2);
  });

  it("does not report an event whose transaction failed: the broker redelivers it", async () => {
    const reported: Array<[string, number | null]> = [];
    const observer: ProjectionObserver = { recorded: (result, gap) => reported.push([result, gap]) };
    const core = createCore({ observer });
    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    core.store.ensureTenant = () => Promise.reject(new Error("the store is gone"));
    await expect(consume(core, trade(MARKET_1, 1))).rejects.toThrow("the store is gone");
    expect(reported).toEqual([["applied", null]]);
  });
});
