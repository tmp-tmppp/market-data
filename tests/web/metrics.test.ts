import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMarketDataMetrics } from "../../src/adapters/metrics/market-data-metrics.js";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { tenantOfRequest } from "../../src/web/auth.js";
import { MARKET_1, TENANT_A, TENANT_B, marketOpenedBody } from "../support/fakes.js";
import { gql, send } from "../support/graphql.js";
import { asTrader, createHarness, get, record } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

// The metrics wired into the real application the way src/main.ts wires them: the tenant label is the tenant of the
// token that the service verified, the GraphQL endpoint is one route, and its errors are counted by code. The
// convention itself is tested in tests/adapters/metrics.test.ts.

let metrics: Metrics;
let h: Harness;
beforeAll(async () => {
  metrics = createMetrics({ tenantOf: tenantOfRequest });
  const marketData = createMarketDataMetrics(metrics.registry);
  h = await createHarness({ metrics, onGraphqlErrors: marketData.graphqlErrors });
  await record(h.core, marketOpenedBody({ marketId: MARKET_1 }));
});
afterAll(async () => {
  await h.close();
});

async function sampleSum(name: string, labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric(name);
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}
const requests = (labels: Record<string, string>) => sampleSum("http_requests_total", labels);
const graphqlErrors = (code: string) => sampleSum("graphql_errors_total", { code });

const GRAPHQL_ROUTE = "/v1/market-data/graphql";

describe("the metrics of the REST routes", () => {
  it("counts a request under the template of its route and the tenant of its token, never the market id", async () => {
    const answer = await get(h, `/v1/market-data/markets/${MARKET_1}`, asTrader("trader-9", TENANT_A));
    expect(answer.status).toBe(200);
    expect(await requests({ method: "GET", route: "/v1/market-data/markets/:marketId", status_code: "200", tenant: TENANT_A })).toBe(1);
    const history = await get(h, `/v1/market-data/markets/${MARKET_1}/history`, asTrader("trader-9", TENANT_B));
    expect(history.status).toBe(404);
    expect(await requests({ method: "GET", route: "/v1/market-data/markets/:marketId/history", status_code: "404", tenant: TENANT_B })).toBe(1);
    const text = await metrics.registry.metrics();
    expect(text).not.toContain(MARKET_1);
    expect(text).not.toContain("trader-9");
  });

  it('counts a request without a token as 401 for the tenant "none"', async () => {
    expect((await get(h, "/v1/market-data/markets", null)).status).toBe(401);
    expect(await requests({ method: "GET", route: "/v1/market-data/markets", status_code: "401", tenant: "none" })).toBe(1);
  });

  it('does not serve /metrics on the API port: the 404 is counted as "unmatched"', async () => {
    const response = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("http_requests_total");
    expect(await requests({ method: "GET", route: "unmatched", status_code: "404", tenant: "none" })).toBe(1);
  });
});

describe("the metrics of the GraphQL endpoint", () => {
  it("is one route template, whatever the query, the operation name or the variables", async () => {
    const queries = [
      { query: "{ markets { items { marketId } } }" },
      { query: "query ListAll { markets { items { marketId } } }", operationName: "ListAll" },
      { query: "query One($ids: [ID!]) { markets(ids: $ids) { items { marketId } } }", variables: { ids: [MARKET_1] }, operationName: "One" },
    ];
    for (const { query, ...options } of queries) expect((await gql(h, query, options)).status).toBe(200);
    expect(await requests({ method: "POST", route: GRAPHQL_ROUTE, status_code: "200", tenant: TENANT_A })).toBe(3);
    const text = await metrics.registry.metrics();
    for (const leaked of ["ListAll", "One", MARKET_1, "markets {"]) expect(text, leaked).not.toContain(leaked);
    expect(await graphqlErrors("validation_failed")).toBe(0);
  });

  it("counts the errors of a refused query by their code, without the operation name", async () => {
    const answer = await gql(h, "query Broken { markets { nope } }", { operationName: "Broken" });
    expect(answer.status).toBe(400);
    expect(await graphqlErrors("graphql_validation_failed")).toBe(1);
    expect(await requests({ method: "POST", route: GRAPHQL_ROUTE, status_code: "400", tenant: TENANT_A })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain("Broken");
  });

  it("counts a syntax error, a caller without rights and a missing token, each under its own code", async () => {
    expect((await gql(h, "{ markets ")).status).toBe(400);
    expect(await graphqlErrors("graphql_syntax_error")).toBe(1);
    expect((await gql(h, "{ markets { items { marketId } } }", { token: { sub: "platform-1", roles: ["platform-admin"] } })).status).toBe(403);
    expect(await graphqlErrors("forbidden")).toBe(1);
    expect((await gql(h, "{ markets { items { marketId } } }", { token: null })).status).toBe(401);
    expect(await graphqlErrors("unauthorized")).toBe(1);
    expect(await requests({ method: "POST", route: GRAPHQL_ROUTE, status_code: "401", tenant: "none" })).toBe(1);
  });

  it("counts the field error of a query that ran (a 200 with errors) by its code", async () => {
    const answer = await gql(h, "query($id: ID!) { market(id: $id) { marketId } }", { variables: { id: "018f3c1e-7a00-7000-8000-0000000000f1" } });
    expect(answer.status).toBe(200);
    expect(answer.body?.errors?.[0]?.["extensions"]?.["code"]).toBe("not_found");
    expect(await graphqlErrors("not_found")).toBe(1);
  });

  it("counts the 405 of another method on the endpoint, and leaves the 404 of an unknown path below it out", async () => {
    expect((await send(h, "GET", GRAPHQL_ROUTE, undefined)).status).toBe(405);
    expect(await graphqlErrors("method_not_allowed")).toBe(1);
    const before = await sampleSum("graphql_errors_total", {});
    expect((await send(h, "POST", `${GRAPHQL_ROUTE}/nothing-here`, { query: "{ markets { items { marketId } } }" })).status).toBe(404);
    expect(await sampleSum("graphql_errors_total", {})).toBe(before);
    expect(await requests({ method: "POST", route: "unmatched", status_code: "404", tenant: "none" })).toBeGreaterThanOrEqual(1);
  });

  it("counts nothing for an answer without errors", async () => {
    const before = await sampleSum("graphql_errors_total", {});
    expect((await gql(h, "{ markets { items { marketId } } }")).status).toBe(200);
    expect(await sampleSum("graphql_errors_total", {})).toBe(before);
  });
});

describe("the harness without metrics", () => {
  it("answers the same: the hooks are optional", async () => {
    const plain = await createHarness();
    expect((await gql(plain, "{ markets { items { marketId } } }")).status).toBe(200);
    expect((await gql(plain, "{ nope }")).status).toBe(400);
    await plain.close();
  });
});
