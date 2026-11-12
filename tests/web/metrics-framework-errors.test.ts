import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { tenantOfRequest } from "../../src/web/auth.js";
import { asTrader, createHarness, get } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

// Fastify answers a URL it cannot route (a malformed percent-encoding, a path parameter over the limit) through its
// frameworkErrors handler, on a request that carries none of the application's hooks. Those answers are still counted:
// a burst of them must show on the request-rate and status panels, as route "unmatched" and tenant "none".

let metrics: Metrics;
let h: Harness;
beforeAll(async () => {
  metrics = createMetrics({ tenantOf: tenantOfRequest });
  h = await createHarness({ metrics });
});
afterAll(async () => {
  await h.close();
});

async function sampleSum(name: string, labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric(name.replace(/_count$/, ""));
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => ((sample as { metricName?: string }).metricName ?? name) === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

describe("the metrics of the answers Fastify gives before a route matches", () => {
  it("counts a malformed URL as a 400 on the route unmatched, for the tenant none, and observes its duration", async () => {
    const answer = await get(h, "/v1/market-data/markets/%E0%A4%A", asTrader());
    expect(answer.status).toBe(400);
    const labels = { method: "GET", route: "unmatched", status_code: "400", tenant: "none" };
    expect(await sampleSum("http_requests_total", labels)).toBe(1);
    expect(await sampleSum("http_request_duration_seconds_count", labels)).toBe(1);
  });

  it("counts a path parameter over the limit as a 414, and never puts the URL in a label", async () => {
    const long = "a".repeat(600);
    const answer = await get(h, `/v1/market-data/markets/${long}`);
    expect(answer.status).toBe(414);
    expect(await sampleSum("http_requests_total", { method: "GET", route: "unmatched", status_code: "414", tenant: "none" })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain(long);
  });
});
