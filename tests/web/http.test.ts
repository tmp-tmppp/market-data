import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TenantNotReady } from "../../src/usecases/errors.js";
import { MARKET_1, asPlatformAdmin, asTrader, call, createHarness, expectContract } from "../support/fake-use-cases.js";
import type { Harness } from "../support/fake-use-cases.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.clearFailures();
  h.setDraining(false);
  h.failPing(null);
});

const LIST = "/v1/market-data/markets";
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("correlation (X-Correlation-Id)", () => {
  it("makes an id when the caller sends none, on every kind of answer", async () => {
    const answers = [
      await call(h, "GET", LIST),
      await call(h, "GET", LIST, { token: null }),
      await call(h, "GET", LIST, { token: asPlatformAdmin() }),
      await call(h, "GET", `${LIST}/${MARKET_1}`),
      await call(h, "GET", "/v1/market-data/nothing"),
      await call(h, "GET", "/health/live", { token: null }),
    ];
    const ids = answers.map((answer) => answer.headers["x-correlation-id"] as string);
    for (const id of ids) expect(id).toMatch(UUID_TEXT);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns the caller's id when it is made of letters, digits and . _ : -, and logs it, but replaces anything else", async () => {
    const kept = await call(h, "GET", LIST, { headers: { "x-correlation-id": "web-7f3a:order.12_x" } });
    expect(kept.headers["x-correlation-id"]).toBe("web-7f3a:order.12_x");
    expect(h.logLines.join("")).toContain('"correlationId":"web-7f3a:order.12_x"');

    for (const odd of ["has space", "semi;colon", "x".repeat(129), "line<script>"]) {
      const replaced = await call(h, "GET", LIST, { headers: { "x-correlation-id": odd } });
      expect(replaced.headers["x-correlation-id"], odd).toMatch(UUID_TEXT);
    }
  });

  it("passes the correlation id to the use case with the actor", async () => {
    h.fake.clearCalls();
    await call(h, "GET", LIST, { headers: { "x-correlation-id": "corr-from-client" } });
    expect(h.fake.calls.listMarkets[0]?.actor.correlationId).toBe("corr-from-client");
  });
});

describe("Cache-Control (INF-02)", () => {
  it("is private, no-store on every /v1/ answer: success, each error status and the path that does not exist", async () => {
    h.fake.failWith("listMarkets", new TenantNotReady());
    const notReady = await call(h, "GET", LIST);
    h.fake.clearFailures();
    const answers = [
      await call(h, "GET", LIST), // 200
      await call(h, "GET", `${LIST}?limit=0`), // 400
      await call(h, "GET", LIST, { token: null }), // 401
      await call(h, "GET", LIST, { token: asPlatformAdmin() }), // 403
      await call(h, "GET", `${LIST}/018f3c1e-7a00-7000-8000-0000000000f1`), // 404 of the use case
      await call(h, "GET", `${LIST}/${MARKET_1}?afterSequence=99`), // 409
      notReady, // 503
      await call(h, "GET", "/v1/market-data/nothing"), // 404 of the router
      await call(h, "GET", `/v1/market-data/markets/${"a".repeat(600)}`), // 414
    ];
    expect(answers.map((answer) => answer.status)).toEqual([200, 400, 401, 403, 404, 409, 503, 404, 414]);
    for (const answer of answers) expect(answer.headers["cache-control"], String(answer.status)).toBe("private, no-store");
  });

  it("is not set on the health probes", async () => {
    for (const path of ["/health/startup", "/health/ready", "/health/live"]) {
      expect((await call(h, "GET", path, { token: null })).headers["cache-control"], path).toBeUndefined();
    }
  });
});

describe("problem details (RFC 9457)", () => {
  it("answers an unknown path, an unsupported method and a path parameter that is too long as problem+json", async () => {
    const unknown = await call(h, "GET", "/v1/market-data/nothing", { token: null });
    expect(unknown.status).toBe(404);
    expect(unknown.headers["content-type"]).toContain("application/problem+json");
    expect(unknown.body).toMatchObject({ status: 404, code: "not_found", title: "Not Found", type: "urn:chance:problem:not-found", instance: "/v1/market-data/nothing" });

    const method = await call(h, "POST", LIST, { token: null, body: {} });
    expect(method.status).toBe(404);
    expect(method.headers["content-type"]).toContain("application/problem+json");

    const long = await call(h, "GET", `${LIST}/${"a".repeat(600)}`, { token: null });
    expect(long.status).toBe(414);
    expect(long.body).toMatchObject({ code: "uri_too_long", type: "urn:chance:problem:uri-too-long" });
    // The text is fixed: Fastify's own message repeats the whole URL.
    expect(long.body?.["detail"]).toBe("A path parameter is too long");
  });

  it("answers a malformed URL as a 400 problem that does not repeat the URL", async () => {
    const answer = await call(h, "GET", `${LIST}/%E0%A4%A`, { token: null });
    expect(answer.status).toBe(400);
    expect(answer.headers["content-type"]).toContain("application/problem+json");
    expect(answer.body).toMatchObject({ code: "bad_request", detail: "The request URL is invalid" });
  });

  it("names the path without the query in `instance` and a type made from the code", async () => {
    const answer = await call(h, "GET", `${LIST}?limit=0&secret=1`);
    expect(answer.body).toMatchObject({ instance: LIST, type: "urn:chance:problem:validation-failed", title: "Bad Request" });
    expect(JSON.stringify(answer.body)).not.toContain("secret=1");
  });

  it("reports every invalid field of one request, not only the first", async () => {
    const answer = await call(h, "GET", `${LIST}?limit=0&status=pending&nonsense=1`);
    expect(answer.status).toBe(400);
    const fields = (answer.body?.["errors"] as Array<{ field: string }>).map((issue) => issue.field).sort();
    expect(fields).toEqual(["limit", "nonsense", "status"]);
  });

  it("accepts a GET that carries Content-Type: application/json with an empty body", async () => {
    const response = await h.app.inject({
      method: "GET",
      url: LIST,
      headers: { authorization: `Bearer ${await h.sign(asTrader())}`, "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("health probes", () => {
  it("answer 200 without a token, as the contract describes", async () => {
    for (const [path, status] of [
      ["/health/startup", 200],
      ["/health/ready", 200],
      ["/health/live", 200],
    ] as const) {
      const answer = await call(h, "GET", path, { token: null });
      expect(answer.status, path).toBe(status);
      expect(answer.body).toEqual({ status: "up" });
      expectContract(path, "GET", answer);
    }
  });

  it("say not ready (503) while the process is shutting down, and when the database does not answer; liveness stays up", async () => {
    h.setDraining(true);
    const draining = await call(h, "GET", "/health/ready", { token: null });
    expect(draining.status).toBe(503);
    expect(draining.headers["content-type"]).toContain("application/problem+json");
    expect(draining.body).toMatchObject({ code: "shutting_down" });
    expectContract("/health/ready", "GET", draining);
    expect((await call(h, "GET", "/health/live", { token: null })).status).toBe(200);
    h.setDraining(false);

    h.failPing(new Error("connection refused"));
    const down = await call(h, "GET", "/health/ready", { token: null });
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ code: "not_ready", detail: "The database does not answer" });
    expect(JSON.stringify(down.body)).not.toContain("connection refused");
    expectContract("/health/ready", "GET", down);
    expect((await call(h, "GET", "/health/live", { token: null })).status).toBe(200);
    expect((await call(h, "GET", "/health/startup", { token: null })).status).toBe(200);
  });
});

describe("the application", () => {
  it("has no local events route unless it is built for local mode", async () => {
    const answer = await call(h, "POST", "/local/events", { body: {} });
    expect(answer.status).toBe(404);
    expect(h.app.registeredRoutes.map((route) => `${route.method} ${route.url}`)).not.toContain("POST /local/events");
  });
});
