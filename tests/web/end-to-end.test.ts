import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKET_1, MARKET_2, MARKET_3, T0, TENANT_A, TENANT_B, at, marketClosedBody, marketOpenedBody, marketResolvedBody, tradeExecutedBody } from "../support/fakes.js";
import { asTrader, createHarness, expectContract, get, provisionTenants, record } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

// The whole stack of market-data in one process: events go in through the real RecordProjectionEvent, the answers come
// out of the real application over the real use cases, on the memory store. Each describe block builds its own world.

const LIST = "/v1/market-data/markets";
const HISTORY = "/v1/market-data/markets/{marketId}/history";
const DETAIL = "/v1/market-data/markets/{marketId}";
const marketUrl = (marketId: string, query = "") => `/v1/market-data/markets/${marketId}${query}`;
const historyUrl = (marketId: string, query = "") => `/v1/market-data/markets/${marketId}/history${query}`;

const MARKET_4 = "018f3c1e-7a00-7000-8000-000000000104";
const MARKET_5 = "018f3c1e-7a00-7000-8000-000000000105";

let h: Harness;
const close = async (): Promise<void> => {
  await h.close();
};

/** TENANT_A: MARKET_1 open with three trades (an hour apart for the last two), MARKET_2 closed, MARKET_3 resolved YES. */
async function seed(harness: Harness): Promise<void> {
  const { core } = harness;
  await record(core, marketOpenedBody({ marketId: MARKET_1, question: "Will the demo work on the first try?", openedAt: at(0), closeTime: at(48 * 60) }));
  await record(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, executedAt: at(1) }));
  await record(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 500_000, executedAt: at(2) }));
  await record(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 3, yesPriceMicro: 550_000, executedAt: at(70) }));
  await record(core, marketOpenedBody({ marketId: MARKET_2, question: "Will the second market close?", openedAt: at(5), closeTime: at(90) }));
  await record(core, marketClosedBody({ marketId: MARKET_2, closedAt: at(100) }));
  await record(core, marketOpenedBody({ marketId: MARKET_3, question: "Will the third market resolve?", openedAt: at(10), closeTime: at(90) }));
  await record(core, tradeExecutedBody({ marketId: MARKET_3, tradeSequence: 1, yesPriceMicro: 600_000, executedAt: at(20) }));
  await record(core, marketClosedBody({ marketId: MARKET_3, version: 2, closedAt: at(100) }));
  await record(core, marketResolvedBody({ marketId: MARKET_3, version: 3, outcome: "YES", resolvedAt: at(110) }));
  await record(core, marketOpenedBody({ marketId: MARKET_3, tenantId: TENANT_B, question: "Another tenant's market?", openedAt: at(1), closeTime: at(120) }));
  // The clock is where the reads happen: after every event above.
  core.clock.advanceMs(3 * 3_600_000);
}

describe("the reads over the real use cases", () => {
  beforeAll(async () => {
    h = await createHarness();
    await seed(h);
  });
  afterAll(close);

  it("lists the tenant's listed markets newest first, with the current prices a trade left behind", async () => {
    const answer = await get(h, LIST);
    expect(answer.status).toBe(200);
    expectContract(LIST, answer);
    const items = answer.body?.["items"] as Array<Record<string, unknown>>;
    expect(items.map((item) => item["marketId"])).toEqual([MARKET_3, MARKET_2, MARKET_1]);
    expect(items[2]).toMatchObject({ status: "open", currentPriceYesMicro: 550_000, lastPriceYesMicro: 550_000, tradeCount: 3, lastTradeSequence: 3, volumeMicro: 30_000_000, startingPriceYesMicro: 400_000 });
    expect(items[1]).toMatchObject({ status: "closed", lastPriceYesMicro: null, currentPriceYesMicro: 400_000 });
    expect(items[0]).toMatchObject({ status: "resolved", outcome: "YES", currentPriceYesMicro: 1_000_000, lastPriceYesMicro: 600_000 });
    expect(answer.headers["cache-control"]).toBe("private, no-store");
  });

  it("filters by status and pages with a cursor to the end", async () => {
    const open = await get(h, `${LIST}?status=open`);
    expect((open.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId)).toEqual([MARKET_1]);
    const first = await get(h, `${LIST}?limit=2`);
    expectContract(LIST, first);
    expect((first.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId)).toEqual([MARKET_3, MARKET_2]);
    const second = await get(h, `${LIST}?limit=2&cursor=${String(first.body?.["nextCursor"])}`);
    expect((second.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId)).toEqual([MARKET_1]);
    expect(second.body?.["nextCursor"]).toBeNull();
  });

  it("answers ?ids= in the order given, leaving out unknown and other tenants' markets, and refuses it with a page parameter", async () => {
    const unknown = "018f3c1e-7a00-7000-8000-0000000009ff";
    const answer = await get(h, `${LIST}?ids=${MARKET_1},${unknown},${MARKET_3},${MARKET_2}`);
    expect(answer.status).toBe(200);
    expectContract(LIST, answer);
    expect((answer.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId)).toEqual([MARKET_1, MARKET_3, MARKET_2]);
    expect(answer.body?.["nextCursor"]).toBeNull();
    const combined = await get(h, `${LIST}?ids=${MARKET_1}&limit=5`);
    expect(combined.status).toBe(400);
    expect(combined.body?.["errors"]).toEqual([expect.objectContaining({ field: "ids" })]);
  });

  it("keeps the tenants apart: the same market id is another market, or none, for another tenant", async () => {
    const own = await get(h, marketUrl(MARKET_3));
    expect(own.body).toMatchObject({ question: "Will the third market resolve?", status: "resolved" });
    const other = await get(h, marketUrl(MARKET_3), asTrader("trader-b", TENANT_B));
    expect(other.body).toMatchObject({ question: "Another tenant's market?", status: "open" });
    expect((await get(h, marketUrl(MARKET_1), asTrader("trader-b", TENANT_B))).status).toBe(404);
    const listB = await get(h, LIST, asTrader("trader-b", TENANT_B));
    expect((listB.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId)).toEqual([MARKET_3]);
  });

  it("answers a market with its contract shape and 404 for one that does not exist", async () => {
    const answer = await get(h, marketUrl(MARKET_1));
    expect(answer.status).toBe(200);
    expectContract(DETAIL, answer);
    expect(answer.body).toMatchObject({ marketId: MARKET_1, version: 1, openedAt: T0.toISOString() });
    const missing = await get(h, marketUrl("018f3c1e-7a00-7000-8000-0000000009ff"));
    expect(missing.status).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
  });

  it("answers the history in hourly buckets with the close before the page, from the opening point on", async () => {
    const answer = await get(h, historyUrl(MARKET_1, "?interval=1h"));
    expect(answer.status).toBe(200);
    expectContract(HISTORY, answer);
    expect(answer.body).toMatchObject({ marketId: MARKET_1, interval: "1h", previousCloseYesMicro: null, nextCursor: null });
    expect(answer.body?.["buckets"]).toEqual([
      { start: "2026-11-01T10:00:00.000Z", openYesMicro: 400_000, highYesMicro: 500_000, lowYesMicro: 400_000, closeYesMicro: 500_000, volumeMicro: 20_000_000, trades: 2 },
      { start: "2026-11-01T11:00:00.000Z", openYesMicro: 550_000, highYesMicro: 550_000, lowYesMicro: 550_000, closeYesMicro: 550_000, volumeMicro: 10_000_000, trades: 1 },
    ]);
  });

  it("gives page 2 of the history the previous close of the page before", async () => {
    const first = await get(h, historyUrl(MARKET_1, "?interval=1h&limit=1"));
    expect(first.status).toBe(200);
    expect((first.body?.["buckets"] as unknown[]).length).toBe(1);
    const second = await get(h, historyUrl(MARKET_1, `?interval=1h&limit=1&cursor=${String(first.body?.["nextCursor"])}`));
    expect(second.status).toBe(200);
    expectContract(HISTORY, second);
    expect(second.body).toMatchObject({ previousCloseYesMicro: 500_000, nextCursor: null });
    expect((second.body?.["buckets"] as Array<{ start: string }>)[0]?.start).toBe("2026-11-01T11:00:00.000Z");
  });

  it("refuses a leap second as `from` with a 400 on that field, never a 500", async () => {
    const answer = await get(h, historyUrl(MARKET_1, "?from=2026-11-01T23:59:60Z"));
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: "validation_failed" });
    expect(answer.body?.["errors"]).toEqual([expect.objectContaining({ field: "from" })]);
  });

  it("answers 409 updating until the trade the caller made is in the read model, then 200", async () => {
    const before = await get(h, marketUrl(MARKET_1, "?afterSequence=4"));
    expect(before.status).toBe(409);
    expect(before.body).toMatchObject({ code: "updating", lastTradeSequence: 3 });
    const beforeHistory = await get(h, historyUrl(MARKET_1, "?afterSequence=4"));
    expect(beforeHistory.status).toBe(409);
    await record(h.core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 4, yesPriceMicro: 520_000, executedAt: at(150) }));
    const after = await get(h, marketUrl(MARKET_1, "?afterSequence=4"));
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ currentPriceYesMicro: 520_000, lastTradeSequence: 4, tradeCount: 4 });
    expect((await get(h, historyUrl(MARKET_1, "?afterSequence=4"))).status).toBe(200);
  });

  it("answers 503 history_paused while HISTORY_ENABLED is false, and the history again when it is true", async () => {
    h.core.rules.rules = { ...h.core.rules.rules, enabled: false };
    const paused = await get(h, historyUrl(MARKET_1));
    expect(paused.status).toBe(503);
    expect(paused.body).toMatchObject({ code: "history_paused" });
    expect(paused.headers["retry-after"]).toBeDefined();
    expect((await get(h, marketUrl(MARKET_1))).status).toBe(200);
    h.core.rules.rules = { ...h.core.rules.rules, enabled: true };
    expect((await get(h, historyUrl(MARKET_1))).status).toBe(200);
  });

  it("refuses a range of more than HISTORY_MAX_POINTS buckets with a 400 that names the limit", async () => {
    const original = h.core.rules.rules;
    h.core.rules.rules = { ...original, maxPoints: 10 };
    const answer = await get(h, historyUrl(MARKET_1, "?interval=1m&from=2026-11-01T10:00:00Z&to=2026-11-01T11:00:00Z"));
    h.core.rules.rules = original;
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ maxPoints: 10 });
    expect(answer.body?.["errors"]).toEqual([expect.objectContaining({ field: "from" })]);
  });
});

describe("a tenant that has no schema yet", () => {
  beforeAll(async () => {
    h = await createHarness({ provision: false });
  });
  afterAll(close);

  it("answers 503 tenant_not_ready with Retry-After on every read until its TenantCreated has been processed", async () => {
    for (const url of [LIST, marketUrl(MARKET_1), historyUrl(MARKET_1)]) {
      const answer = await get(h, url);
      expect(answer.status, url).toBe(503);
      expect(answer.body, url).toMatchObject({ code: "tenant_not_ready" });
      expect(answer.headers["retry-after"], url).toBeDefined();
    }
    await provisionTenants(h.core, [TENANT_A]);
    const ready = await get(h, LIST);
    expect(ready.status).toBe(200);
    expect(ready.body?.["items"]).toEqual([]);
  });

  it("registers the tenant of a market event that arrives before TenantCreated (the tenant is never stuck)", async () => {
    await record(h.core, marketOpenedBody({ marketId: MARKET_4, tenantId: TENANT_B, question: "Is B ready?" }));
    const answer = await get(h, LIST, asTrader("trader-b", TENANT_B));
    expect(answer.status).toBe(200);
    expect((answer.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId)).toEqual([MARKET_4]);
  });
});

describe("a market the read model has only heard of through a trade", () => {
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(close);

  it("is 404 and left out of lists until MarketOpened arrives, then appears with every trade already counted", async () => {
    await record(h.core, tradeExecutedBody({ marketId: MARKET_5, tradeSequence: 1, yesPriceMicro: 430_000, executedAt: at(3) }));
    h.core.clock.advanceMs(3_600_000);
    expect((await get(h, marketUrl(MARKET_5))).status).toBe(404);
    expect((await get(h, historyUrl(MARKET_5))).status).toBe(404);
    expect((await get(h, LIST)).body?.["items"]).toEqual([]);
    expect((await get(h, `${LIST}?ids=${MARKET_5}`)).body?.["items"]).toEqual([]);
    await record(h.core, marketOpenedBody({ marketId: MARKET_5, question: "Late opening?", openedAt: at(0) }));
    const answer = await get(h, marketUrl(MARKET_5));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ tradeCount: 1, currentPriceYesMicro: 430_000, volumeMicro: 10_000_000 });
  });
});

describe("questions of the longest allowed length", () => {
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(close);

  it("lists a question of 200 astral characters (400 UTF-16 units) and does not list one of 201", async () => {
    const astral = "\u{1F600}".repeat(200);
    expect(astral.length).toBe(400);
    expect(await record(h.core, marketOpenedBody({ marketId: MARKET_4, question: astral }))).toBe("applied");
    const tooLong = await record(h.core, marketOpenedBody({ marketId: MARKET_5, question: "\u{1F600}".repeat(201) }));
    expect(tooLong).toBe("unprojected");
    const answer = await get(h, LIST);
    expectContract(LIST, answer);
    const items = answer.body?.["items"] as Array<{ marketId: string; question: string }>;
    expect(items.map((item) => item.marketId)).toEqual([MARKET_4]);
    expect(Array.from(items[0]?.question ?? "").length).toBe(200);
    expect(items[0]?.question).toBe(astral);
  });
});

describe("history pages while the clock moves on (to omitted)", () => {
  beforeAll(async () => {
    h = await createHarness();
    h.core.rules.rules = { ...h.core.rules.rules, maxPoints: 10 };
    await record(h.core, marketOpenedBody({ marketId: MARKET_1, openedAt: at(0), closeTime: at(48 * 60) }));
    // One trade in each of the ten minutes 1..10 after the opening, then the clock stands at minute 11.
    for (let minute = 1; minute <= 10; minute += 1) {
      await record(h.core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: minute, yesPriceMicro: 400_000 + minute * 10_000, executedAt: at(minute) }));
    }
    h.core.clock.advanceMs(11 * 60_000);
  });
  afterAll(close);

  it("continues the range of page 1 on page 2 although the clock moved, and never answers the limit again", async () => {
    const first = await get(h, historyUrl(MARKET_1, "?interval=1m&limit=5"));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const firstStarts = (first.body?.["buckets"] as Array<{ start: string }>).map((bucket) => bucket.start);
    expect(firstStarts).toHaveLength(5);
    // Three more minutes pass, and an event of the next minute arrives: a range recomputed from now would move.
    h.core.clock.advanceMs(3 * 60_000);
    await record(h.core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 11, yesPriceMicro: 515_000, executedAt: at(12) }));
    const second = await get(h, historyUrl(MARKET_1, `?interval=1m&limit=5&cursor=${String(first.body?.["nextCursor"])}`));
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ from: first.body?.["from"], to: first.body?.["to"] });
    const secondStarts = (second.body?.["buckets"] as Array<{ start: string }>).map((bucket) => bucket.start);
    expect([...firstStarts, ...secondStarts]).toEqual([...new Set([...firstStarts, ...secondStarts])].sort());
    expect(new Date(secondStarts[0] ?? "").getTime() - new Date(firstStarts[4] ?? "").getTime()).toBe(60_000);
    // The trade of minute 12 lies beyond page 1's range and is not in it.
    expect(secondStarts.every((start) => new Date(start).getTime() < new Date(String(first.body?.["to"])).getTime())).toBe(true);
  });
});
