import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKET_1, MARKET_2, MARKET_3, TENANT_B, at, marketClosedBody, marketOpenedBody, marketResolvedBody, tradeExecutedBody } from "../support/fakes.js";
import { asTenantAdmin, asTrader, createHarness, get, record } from "../support/harness.js";
import type { Harness } from "../support/harness.js";
import { codesOf, gql } from "../support/graphql.js";

// The GraphQL endpoint and the REST routes over the same real use cases on the memory store, asked the same things: what
// one answers the other answers too, field by field. This is the proof of "no second data path".

const LIST = "/v1/market-data/markets";
const marketUrl = (marketId: string, query = "") => `/v1/market-data/markets/${marketId}${query}`;
const historyUrl = (marketId: string, query = "") => `/v1/market-data/markets/${marketId}/history${query}`;
const UNKNOWN = "018f3c1e-7a00-7000-8000-0000000009ff";

const MARKET_FIELDS = "marketId question status closeTime openedAt closedAt resolvedAt outcome startingPriceYesMicro lastPriceYesMicro currentPriceYesMicro volumeMicro tradeCount lastTradeSequence lastTradeAt version updatedAt";
const BUCKET_FIELDS = "start openYesMicro highYesMicro lowYesMicro closeYesMicro volumeMicro trades";

/** A REST Market as GraphQL tells it: the same fields and values, the status as an enum name. */
const asGraphql = (market: Record<string, unknown>) => ({ ...market, status: String(market["status"]).toUpperCase() });

let h: Harness;

async function seed(harness: Harness): Promise<void> {
  const { core } = harness;
  await record(core, marketOpenedBody({ marketId: MARKET_1, question: "Will the demo work on the first try?", openedAt: at(0), closeTime: at(48 * 60) }));
  for (const [sequence, price, minute] of [[1, 450_000, 1], [2, 500_000, 2], [3, 550_000, 70]] as const) {
    await record(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: sequence, yesPriceMicro: price, executedAt: at(minute) }));
  }
  await record(core, marketOpenedBody({ marketId: MARKET_2, question: "Will the second market close?", openedAt: at(5), closeTime: at(90) }));
  await record(core, marketClosedBody({ marketId: MARKET_2, closedAt: at(100) }));
  await record(core, marketOpenedBody({ marketId: MARKET_3, question: "Will the third market resolve?", openedAt: at(10), closeTime: at(90) }));
  await record(core, tradeExecutedBody({ marketId: MARKET_3, tradeSequence: 1, yesPriceMicro: 600_000, executedAt: at(20) }));
  await record(core, marketClosedBody({ marketId: MARKET_3, version: 2, closedAt: at(100) }));
  await record(core, marketResolvedBody({ marketId: MARKET_3, version: 3, outcome: "YES", resolvedAt: at(110) }));
  await record(core, marketOpenedBody({ marketId: MARKET_3, tenantId: TENANT_B, question: "Another tenant's market?", openedAt: at(1), closeTime: at(120) }));
  core.clock.advanceMs(3 * 3_600_000);
}

beforeAll(async () => {
  h = await createHarness();
  await seed(h);
});
afterAll(async () => {
  await h.close();
});

describe("the markets query answers what GET /markets answers", () => {
  it("lists every market with the same values, in the same order", async () => {
    const rest = await get(h, LIST);
    const graphql = await gql(h, `{ markets { items { ${MARKET_FIELDS} } pageInfo { hasNextPage endCursor } } }`);
    expect(graphql.status).toBe(200);
    expect(graphql.body?.errors).toBeUndefined();
    expect(graphql.body?.data?.["markets"].items).toEqual((rest.body?.["items"] as Array<Record<string, unknown>>).map(asGraphql));
    expect(graphql.body?.data?.["markets"].pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });

  it("filters by status and pages with the cursor of the REST API, to the same pages", async () => {
    for (const status of ["open", "closed", "resolved"]) {
      const rest = await get(h, `${LIST}?status=${status}`);
      const graphql = await gql(h, `{ markets(status: ${status.toUpperCase()}) { items { ${MARKET_FIELDS} } } }`);
      expect(graphql.body?.data?.["markets"].items, status).toEqual((rest.body?.["items"] as Array<Record<string, unknown>>).map(asGraphql));
    }
    const restFirst = await get(h, `${LIST}?limit=2`);
    const first = await gql(h, "{ markets(first: 2) { items { marketId } pageInfo { hasNextPage endCursor } } }");
    expect(first.body?.data?.["markets"].items.map((item: { marketId: string }) => item.marketId)).toEqual((restFirst.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId));
    // One endpoint's cursor is the other's: they are the same opaque text.
    expect(first.body?.data?.["markets"].pageInfo).toEqual({ hasNextPage: true, endCursor: restFirst.body?.["nextCursor"] });
    const restSecond = await get(h, `${LIST}?limit=2&cursor=${String(restFirst.body?.["nextCursor"])}`);
    const second = await gql(h, "query($c: String) { markets(first: 2, after: $c) { items { marketId } pageInfo { hasNextPage endCursor } } }", { variables: { c: restFirst.body?.["nextCursor"] } });
    expect(second.body?.data?.["markets"].items.map((item: { marketId: string }) => item.marketId)).toEqual((restSecond.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId));
    expect(second.body?.data?.["markets"].pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });

  it("answers a batch of ids as the ids query does: given order, unknown and other tenants' ids left out", async () => {
    const rest = await get(h, `${LIST}?ids=${MARKET_1},${UNKNOWN},${MARKET_3},${MARKET_2}`);
    const graphql = await gql(h, "query($ids: [ID!]) { markets(ids: $ids) { items { " + MARKET_FIELDS + " } pageInfo { hasNextPage endCursor } } }", { variables: { ids: [MARKET_1, UNKNOWN, MARKET_3, MARKET_2] } });
    expect(graphql.body?.data?.["markets"].items).toEqual((rest.body?.["items"] as Array<Record<string, unknown>>).map(asGraphql));
    expect(graphql.body?.data?.["markets"].pageInfo).toEqual({ hasNextPage: false, endCursor: null });
    const withPage = await gql(h, `{ markets(ids: ["${MARKET_1}"], first: 5) { items { marketId } } }`);
    expect(codesOf(withPage)).toEqual(["validation_failed"]);
    const tooMany = await gql(h, "query($ids: [ID!]) { markets(ids: $ids) { items { marketId } } }", { variables: { ids: [] } });
    expect(tooMany.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", fields: [{ field: "ids" }] } });
  });

  it("keeps the tenants apart exactly as the REST routes do", async () => {
    const asB = asTrader("trader-b", TENANT_B);
    const rest = await get(h, LIST, asB);
    const graphql = await gql(h, `{ markets { items { ${MARKET_FIELDS} } } }`, { token: asB });
    expect(graphql.body?.data?.["markets"].items).toEqual((rest.body?.["items"] as Array<Record<string, unknown>>).map(asGraphql));
    expect(graphql.body?.data?.["markets"].items).toHaveLength(1);
    const other = await gql(h, `{ market(id: "${MARKET_1}") { marketId } }`, { token: asB });
    expect(other.body?.data).toEqual({ market: null });
    expect(codesOf(other)).toEqual(["not_found"]);
    expect((await get(h, marketUrl(MARKET_1), asB)).status).toBe(404);
  });
});

describe("a market resolved INVALID (UC-16)", () => {
  it("is served with outcome INVALID and its last price by REST and GraphQL alike, also when nothing traded", async () => {
    const own = await createHarness();
    await record(own.core, marketOpenedBody({ marketId: MARKET_1, question: "Will it be answerable?", openedAt: at(0), closeTime: at(90) }));
    await record(own.core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 630_000, executedAt: at(20) }));
    await record(own.core, marketResolvedBody({ marketId: MARKET_1, version: 3, outcome: "INVALID", resolvedAt: at(110) }));
    await record(own.core, marketOpenedBody({ marketId: MARKET_2, question: "Will nobody trade?", openedAt: at(5), closeTime: at(90) }));
    await record(own.core, marketResolvedBody({ marketId: MARKET_2, version: 3, outcome: "INVALID", resolvedAt: at(110) }));

    for (const [marketId, price] of [[MARKET_1, 630_000], [MARKET_2, 400_000]] as const) {
      const rest = await get(own, marketUrl(marketId));
      expect(rest.status).toBe(200);
      expect(rest.body).toMatchObject({ status: "resolved", outcome: "INVALID", currentPriceYesMicro: price });
      const graphql = await gql(own, `{ market(id: "${marketId}") { ${MARKET_FIELDS} } }`);
      expect(graphql.body?.errors).toBeUndefined();
      expect(graphql.body?.data?.["market"]).toEqual(asGraphql(rest.body as Record<string, unknown>));
      expect(graphql.body?.data?.["market"]).toMatchObject({ status: "RESOLVED", outcome: "INVALID", currentPriceYesMicro: price });
    }
    await own.close();
  });
});

describe("the market query answers what GET /markets/{id} answers", () => {
  it("returns the same market, for a trader and for a tenant admin", async () => {
    for (const token of [asTrader(), asTenantAdmin()]) {
      for (const marketId of [MARKET_1, MARKET_2, MARKET_3]) {
        const rest = await get(h, marketUrl(marketId), token);
        const graphql = await gql(h, `{ market(id: "${marketId}") { ${MARKET_FIELDS} } }`, { token });
        expect(graphql.body?.data?.["market"]).toEqual(asGraphql(rest.body as Record<string, unknown>));
      }
    }
  });

  it("tells not_found and a malformed id as the REST routes do, with their codes", async () => {
    const missing = await gql(h, `{ market(id: "${UNKNOWN}") { marketId } }`);
    expect(missing.body?.errors?.[0]).toMatchObject({ extensions: { code: "not_found", status: 404 } });
    expect((await get(h, marketUrl(UNKNOWN))).status).toBe(404);
    const malformed = await gql(h, `{ market(id: "nope") { marketId } }`);
    expect(malformed.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", status: 400, fields: [{ field: "id" }] } });
  });

  it("answers `updating` with the trade sequence until the trade is in the read model (DM-17), then the market", async () => {
    const rest = await get(h, marketUrl(MARKET_1, "?afterSequence=4"));
    expect(rest.status).toBe(409);
    const before = await gql(h, `{ market(id: "${MARKET_1}", afterSequence: 4) { marketId tradeCount } }`);
    expect(before.body?.data).toEqual({ market: null });
    expect(before.body?.errors?.[0]).toMatchObject({ extensions: { code: "updating", status: 409, lastTradeSequence: rest.body?.["lastTradeSequence"] } });
    expect(before.body?.errors?.[0]?.["extensions"]["lastTradeSequence"]).toBe(3);

    await record(h.core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 4, yesPriceMicro: 520_000, executedAt: at(150) }));
    const after = await gql(h, `{ market(id: "${MARKET_1}", afterSequence: 4) { marketId tradeCount lastPriceYesMicro } }`);
    expect(after.body?.errors).toBeUndefined();
    expect(after.body?.data?.["market"]).toEqual({ marketId: MARKET_1, tradeCount: 4, lastPriceYesMicro: 520_000 });
    expect((await get(h, marketUrl(MARKET_1, "?afterSequence=4"))).status).toBe(200);
  });
});

describe("the history query answers what GET /markets/{id}/history answers", () => {
  const INTERVALS: Array<[string, string]> = [
    ["1m", "ONE_MINUTE"],
    ["5m", "FIVE_MINUTES"],
    ["15m", "FIFTEEN_MINUTES"],
    ["1h", "ONE_HOUR"],
    ["4h", "FOUR_HOURS"],
    ["1d", "ONE_DAY"],
  ];

  it.each(INTERVALS)("returns the same buckets for the interval %s (%s)", async (key, name) => {
    const rest = await get(h, historyUrl(MARKET_1, `?interval=${key}`));
    expect(rest.status).toBe(200);
    const graphql = await gql(h, `{ history(marketId: "${MARKET_1}", interval: ${name}) { marketId interval from to previousCloseYesMicro buckets { ${BUCKET_FIELDS} } pageInfo { hasNextPage endCursor } } }`);
    expect(graphql.body?.errors).toBeUndefined();
    expect(graphql.body?.data?.["history"]).toEqual({
      marketId: rest.body?.["marketId"],
      interval: name,
      from: rest.body?.["from"],
      to: rest.body?.["to"],
      previousCloseYesMicro: rest.body?.["previousCloseYesMicro"],
      buckets: rest.body?.["buckets"],
      pageInfo: { hasNextPage: rest.body?.["nextCursor"] !== null, endCursor: rest.body?.["nextCursor"] },
    });
  });

  it("uses one hour when the interval is left out, as REST does", async () => {
    const rest = await get(h, historyUrl(MARKET_1));
    const graphql = await gql(h, `{ history(marketId: "${MARKET_1}") { interval buckets { start } } }`);
    expect(graphql.body?.data?.["history"]).toEqual({ interval: "ONE_HOUR", buckets: (rest.body?.["buckets"] as Array<{ start: string }>).map(({ start }) => ({ start })) });
  });

  it("pages with the same cursor and previous close, and keeps the range of page 1", async () => {
    const restFirst = await get(h, historyUrl(MARKET_1, "?interval=1h&limit=1"));
    const first = await gql(h, `{ history(marketId: "${MARKET_1}", interval: ONE_HOUR, first: 1) { buckets { start } previousCloseYesMicro pageInfo { hasNextPage endCursor } } }`);
    expect(first.body?.data?.["history"].pageInfo).toEqual({ hasNextPage: true, endCursor: restFirst.body?.["nextCursor"] });
    const cursor = String(restFirst.body?.["nextCursor"]);
    const restSecond = await get(h, historyUrl(MARKET_1, `?interval=1h&limit=1&cursor=${cursor}`));
    const second = await gql(h, `query($c: String) { history(marketId: "${MARKET_1}", interval: ONE_HOUR, first: 1, after: $c) { buckets { start } previousCloseYesMicro pageInfo { hasNextPage endCursor } } }`, { variables: { c: cursor } });
    expect(second.body?.data?.["history"]).toEqual({
      buckets: (restSecond.body?.["buckets"] as Array<{ start: string }>).map(({ start }) => ({ start })),
      previousCloseYesMicro: restSecond.body?.["previousCloseYesMicro"],
      // A trade of an earlier test added a third hour, so page 2 of one bucket per page has a next page, here and there.
      pageInfo: { hasNextPage: restSecond.body?.["nextCursor"] !== null, endCursor: restSecond.body?.["nextCursor"] },
    });
    expect(second.body?.data?.["history"].previousCloseYesMicro).toBe(500_000);
    // A cursor of another interval is refused as it is there.
    const wrong = await gql(h, `query($c: String) { history(marketId: "${MARKET_1}", interval: FIVE_MINUTES, after: $c) { marketId } }`, { variables: { c: cursor } });
    expect(wrong.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", fields: [{ field: "after" }] } });
    expect((await get(h, historyUrl(MARKET_1, `?interval=5m&cursor=${cursor}`))).status).toBe(400);
  });

  it("takes from and to as RFC 3339 text, offsets included, and refuses what REST refuses: a leap second, too wide a range", async () => {
    const from = at(0).toISOString();
    const to = at(100).toISOString();
    const rest = await get(h, historyUrl(MARKET_1, `?interval=1m&from=${from}&to=${to}`));
    const graphql = await gql(h, `query($f: DateTime, $t: DateTime) { history(marketId: "${MARKET_1}", interval: ONE_MINUTE, from: $f, to: $t) { from to buckets { ${BUCKET_FIELDS} } } }`, { variables: { f: from.replace("Z", "+00:00"), t: to } });
    expect(graphql.body?.data?.["history"]).toEqual({ from: rest.body?.["from"], to: rest.body?.["to"], buckets: rest.body?.["buckets"] });

    const leap = await gql(h, `{ history(marketId: "${MARKET_1}", from: "2026-11-01T23:59:60Z") { marketId } }`);
    expect(leap.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", fields: [{ field: "from" }] } });
    expect((await get(h, historyUrl(MARKET_1, "?from=2026-11-01T23:59:60Z"))).status).toBe(400);

    const wide = await gql(h, `{ history(marketId: "${MARKET_1}", interval: ONE_MINUTE, from: "2025-01-01T00:00:00Z", to: "2026-11-01T00:00:00Z") { marketId } }`);
    const wideRest = await get(h, historyUrl(MARKET_1, "?interval=1m&from=2025-01-01T00:00:00Z&to=2026-11-01T00:00:00Z"));
    expect(wideRest.status).toBe(400);
    expect(wide.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", status: 400, maxPoints: wideRest.body?.["maxPoints"] } });
  });

  it("answers `updating` and not_found as the REST routes do", async () => {
    const before = await gql(h, `{ history(marketId: "${MARKET_1}", afterSequence: 99) { marketId } }`);
    expect(before.body?.errors?.[0]).toMatchObject({ extensions: { code: "updating", status: 409, lastTradeSequence: expect.any(Number) as number } });
    const missing = await gql(h, `{ history(marketId: "${UNKNOWN}") { marketId } }`);
    expect(codesOf(missing)).toEqual(["not_found"]);
    expect((await get(h, historyUrl(UNKNOWN))).status).toBe(404);
  });

  it("is paused with history_paused while HISTORY_ENABLED is false, and the market list keeps working, as REST", async () => {
    h.core.rules.rules = { ...h.core.rules.rules, enabled: false };
    try {
      const paused = await gql(h, `{ history(marketId: "${MARKET_1}") { marketId } markets { items { marketId } } }`);
      expect(paused.status).toBe(200);
      expect(paused.body?.data).toMatchObject({ history: null, markets: { items: expect.any(Array) as unknown[] } });
      expect(paused.body?.errors).toHaveLength(1);
      expect(paused.body?.errors?.[0]).toMatchObject({ path: ["history"], extensions: { code: "history_paused", status: 503, retryAfterSeconds: 30 } });
      expect((await get(h, historyUrl(MARKET_1))).status).toBe(503);
    } finally {
      h.core.rules.rules = { ...h.core.rules.rules, enabled: true };
    }
    expect((await gql(h, `{ history(marketId: "${MARKET_1}") { marketId } }`)).body?.errors).toBeUndefined();
  });

  it("is limited to HISTORY_MAX_POINTS like REST: the runtime rule applies to both", async () => {
    const original = h.core.rules.rules;
    h.core.rules.rules = { ...original, maxPoints: 10 };
    try {
      const graphql = await gql(h, `{ history(marketId: "${MARKET_1}", interval: ONE_MINUTE, from: "${at(0).toISOString()}", to: "${at(100).toISOString()}") { marketId } }`);
      expect(graphql.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", maxPoints: 10 } });
      expect((await get(h, historyUrl(MARKET_1, `?interval=1m&from=${at(0).toISOString()}&to=${at(100).toISOString()}`))).status).toBe(400);
    } finally {
      h.core.rules.rules = original;
    }
  });
});

describe("a tenant that is not set up yet", () => {
  it("answers tenant_not_ready on every query, as the REST routes answer 503", async () => {
    const harness = await createHarness({ provision: false });
    try {
      const queries = {
        markets: "{ markets { items { marketId } } }",
        market: `{ market(id: "${MARKET_1}") { marketId } }`,
        history: `{ history(marketId: "${MARKET_1}") { marketId } }`,
      };
      for (const [name, query] of Object.entries(queries)) {
        const answer = await gql(harness, query);
        expect(answer.status, name).toBe(200);
        expect(answer.body?.data, name).toEqual({ [name]: null });
        expect(answer.body?.errors?.[0], name).toMatchObject({ path: [name], extensions: { code: "tenant_not_ready", status: 503, retryAfterSeconds: 5 } });
      }
      expect((await get(harness, LIST)).status).toBe(503);
    } finally {
      await harness.close();
    }
  });
});

describe("reading never writes", () => {
  it("leaves the read model as it was after a query of every kind", async () => {
    const before = await get(h, LIST);
    await gql(h, `{ markets { items { marketId } } market(id: "${MARKET_1}") { marketId } history(marketId: "${MARKET_1}") { marketId } }`);
    const after = await get(h, LIST);
    expect(after.body).toEqual(before.body);
    const mutation = await gql(h, `mutation { markets { items { marketId } } }`);
    expect(mutation.status).toBe(400);
  });
});
