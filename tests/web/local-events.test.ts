import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKET_1, TENANT_A, asPlatformAdmin, asTrader, call, createHarness } from "../support/fake-use-cases.js";
import type { Harness } from "../support/fake-use-cases.js";
import { at, marketOpenedBody, nextEventId, tenantCreatedBody, tradeExecutedBody } from "../support/fakes.js";

// The local events route (APP_ENV=local without NATS): the consumers' use cases behind a plain POST.

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ local: true });
});
afterAll(async () => {
  await h.close();
});

const EVENTS = "/local/events";
const NEW_TENANT = "018f3c1e-7a00-7000-8000-0000000000dd";
const NEW_MARKET = "018f3c1e-7a00-7000-8000-000000000201";

describe("POST /local/events", () => {
  it("registers a tenant from TenantCreated and says duplicate for the same event id, so a request of that tenant stops being 503", async () => {
    const stranger = asTrader("local-1", NEW_TENANT);
    expect((await call(h, "GET", "/v1/market-data/markets", { token: stranger })).status).toBe(503);

    const body = tenantCreatedBody(NEW_TENANT);
    const first = await call(h, "POST", EVENTS, { body });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ result: "provisioned" });
    expect((await call(h, "POST", EVENTS, { body })).body).toEqual({ result: "duplicate" });

    expect((await call(h, "GET", "/v1/market-data/markets", { token: stranger })).status).toBe(200);
    expect(h.fake.calls.provisionTenant.at(-1)).toMatchObject({ tenantId: NEW_TENANT, eventId: body["id"] });
  });

  it("projects the market events and the trade of a developer's curl: the market appears in the list and its history", async () => {
    const opened = marketOpenedBody({ marketId: NEW_MARKET, question: "Is the local route usable?", openedAt: at(0) });
    const trade = tradeExecutedBody({ marketId: NEW_MARKET, tradeSequence: 1, yesPriceMicro: 520_000, executedAt: at(3) });
    expect((await call(h, "POST", EVENTS, { body: opened })).body).toEqual({ result: "applied" });
    expect((await call(h, "POST", EVENTS, { body: trade })).body).toEqual({ result: "applied" });

    const market = await call(h, "GET", `/v1/market-data/markets/${NEW_MARKET}?afterSequence=1`);
    expect(market.status).toBe(200);
    expect(market.body).toMatchObject({ question: "Is the local route usable?", lastPriceYesMicro: 520_000, tradeCount: 1 });
    const history = await call(h, "GET", `/v1/market-data/markets/${NEW_MARKET}/history`);
    expect(history.status).toBe(200);
    expect((history.body?.["buckets"] as unknown[]).length).toBe(1);
  });

  it("hands the use case the event as read and the body as received, and answers duplicate for a repeated id", async () => {
    const body = marketOpenedBody({ marketId: MARKET_1, id: nextEventId(), extra: { someLaterField: "an optional field of a later contract" } });
    const answer = await call(h, "POST", EVENTS, { body });
    expect(answer.status).toBe(200);
    const input = h.fake.calls.recordProjectionEvent.at(-1);
    expect(input?.raw).toEqual(body);
    expect(input?.event).toMatchObject({ kind: "market_opened", tenantId: TENANT_A, eventId: body["id"], facts: { marketId: MARKET_1 } });
    expect((await call(h, "POST", EVENTS, { body })).body).toEqual({ result: "duplicate" });
  });

  it("accepts an event of another type of the MARKETS stream as unprojected: it is stored, not an error", async () => {
    const body = { ...marketOpenedBody({ marketId: NEW_MARKET }), id: nextEventId(), type: "si.chance.markets.MarketCreated.v1" };
    const answer = await call(h, "POST", EVENTS, { body });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ result: "unprojected" });
  });

  it("refuses an event that cannot be attributed to a tenant with a 400 that says why, where a consumer would park it", async () => {
    const { tenantid: _removed, ...withoutTenant } = marketOpenedBody({ marketId: NEW_MARKET });
    for (const body of [withoutTenant, { ...marketOpenedBody(), specversion: "0.3" }, { ...marketOpenedBody(), id: "not-a-uuid" }, { ...marketOpenedBody(), type: "" }]) {
      const answer = await call(h, "POST", EVENTS, { body });
      expect(answer.status, JSON.stringify(answer.body)).toBe(400);
      expect(answer.headers["content-type"]).toContain("application/problem+json");
      expect(answer.body).toMatchObject({ code: "validation_failed", errors: [{ field: "event", message: expect.any(String) as string }] });
    }
    const badTenant = await call(h, "POST", EVENTS, { body: { ...tenantCreatedBody(NEW_TENANT, nextEventId()), tenantid: "acme" } });
    expect(badTenant.status).toBe(400);
    expect(badTenant.body).toMatchObject({ errors: [{ field: "event" }] });
  });

  it("answers 400 for a body that is not a JSON object, and 413 for one that is far too large", async () => {
    expect((await call(h, "POST", EVENTS, { body: [] })).status).toBe(400);
    // Text that is no JSON, sent as JSON (Fastify's parser answers 400), and the same without a media type (415).
    const malformed = await call(h, "POST", EVENTS, { body: "just text", headers: { "content-type": "application/json" } });
    expect(malformed.status).toBe(400);
    expect(malformed.headers["content-type"]).toContain("application/problem+json");
    expect((await call(h, "POST", EVENTS, { body: "just text" })).status).toBe(415);
    const huge = await call(h, "POST", EVENTS, { body: { ...marketOpenedBody(), padding: "x".repeat(20_000) } });
    expect(huge.status).toBe(413);
    expect(huge.headers["content-type"]).toContain("application/problem+json");
  });

  it("needs a valid bearer token, but any: a platform admin's or a trader's, whatever the tenant of the event", async () => {
    expect((await call(h, "POST", EVENTS, { token: null, body: marketOpenedBody({ marketId: NEW_MARKET, id: nextEventId() }) })).status).toBe(401);
    expect((await call(h, "POST", EVENTS, { token: asPlatformAdmin(), body: marketOpenedBody({ marketId: NEW_MARKET, id: nextEventId() }) })).status).toBe(200);
    expect((await call(h, "POST", EVENTS, { token: { sub: "nobody" }, body: marketOpenedBody({ marketId: NEW_MARKET, id: nextEventId() }) })).status).toBe(200);
  });

  it("is outside /v1: the gateway never routes it, and its answers carry no Cache-Control", async () => {
    const answer = await call(h, "POST", EVENTS, { body: marketOpenedBody({ marketId: NEW_MARKET, id: nextEventId() }) });
    expect(answer.headers["cache-control"]).toBeUndefined();
    expect(answer.headers["x-correlation-id"]).toBeDefined();
  });
});
