import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationFailed, HistoryPaused, NotFound, TenantNotReady, Updating } from "../../src/usecases/errors.js";
import { T0, at } from "../support/fakes.js";
import { MARKET_1, MARKET_2, MARKET_3, TENANT_A, asTenantAdmin, asTrader, call, createHarness, expectContract } from "../support/fake-use-cases.js";
import type { Answer, Harness } from "../support/fake-use-cases.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.clearFailures();
  h.fake.clearCalls();
});

const LIST = "/v1/market-data/markets";
const DETAIL = "/v1/market-data/markets/{marketId}";
const HISTORY = "/v1/market-data/markets/{marketId}/history";
const marketUrl = (marketId: string, query = "") => `/v1/market-data/markets/${marketId}${query}`;
const historyUrl = (marketId: string, query = "") => `/v1/market-data/markets/${marketId}/history${query}`;

/** A 400 of the route: a problem+json answer naming the field. */
function expectInvalid(answer: Answer, field: string): void {
  expect(answer.status, JSON.stringify(answer.body)).toBe(400);
  expect(answer.headers["content-type"]).toContain("application/problem+json");
  expect(answer.body).toMatchObject({ status: 400, code: "validation_failed", type: "urn:chance:problem:validation-failed" });
  expect(answer.body?.["errors"]).toEqual([expect.objectContaining({ field })]);
}

describe("GET /v1/market-data/markets", () => {
  it("lists the tenant's markets newest first, as the contract describes a Market, with dates as ISO text", async () => {
    const answer = await call(h, "GET", LIST);
    expect(answer.status).toBe(200);
    expectContract(LIST, "GET", answer);
    const items = answer.body?.["items"] as Array<Record<string, unknown>>;
    expect(items.map((item) => item["marketId"])).toEqual([MARKET_3, MARKET_2, MARKET_1]);
    expect(answer.body?.["nextCursor"]).toBeNull();
    expect(items[2]).toEqual({
      marketId: MARKET_1,
      question: "Will the demo work on the first try?",
      status: "open",
      closeTime: at(48 * 60).toISOString(),
      openedAt: T0.toISOString(),
      closedAt: null,
      resolvedAt: null,
      outcome: null,
      startingPriceYesMicro: 400_000,
      lastPriceYesMicro: 550_000,
      currentPriceYesMicro: 550_000,
      volumeMicro: 30_000_000,
      tradeCount: 3,
      lastTradeSequence: 3,
      lastTradeAt: at(70).toISOString(),
      version: 1,
      updatedAt: expect.any(String) as string,
    });
    // A market without a trade shows its starting price; a resolved one its final price.
    expect(items[1]).toMatchObject({ status: "closed", lastPriceYesMicro: null, currentPriceYesMicro: 400_000, tradeCount: 0, lastTradeAt: null });
    expect(items[0]).toMatchObject({ status: "resolved", outcome: "YES", currentPriceYesMicro: 1_000_000, lastPriceYesMicro: 600_000 });
  });

  it("passes status, limit and cursor on unchanged, and pages to the end", async () => {
    const first = await call(h, "GET", `${LIST}?limit=2`);
    expect(first.status).toBe(200);
    expectContract(LIST, "GET", first);
    expect((first.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId)).toEqual([MARKET_3, MARKET_2]);
    const cursor = first.body?.["nextCursor"] as string;
    expect(cursor).toEqual(expect.any(String));

    const second = await call(h, "GET", `${LIST}?limit=2&cursor=${cursor}`);
    expect((second.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId)).toEqual([MARKET_1]);
    expect(second.body?.["nextCursor"]).toBeNull();
    expect(h.fake.calls.listMarkets.map((input) => ({ limit: input.limit, cursor: input.cursor }))).toEqual([
      { limit: 2, cursor: undefined },
      { limit: 2, cursor },
    ]);

    const closed = await call(h, "GET", `${LIST}?status=closed`);
    expect((closed.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId)).toEqual([MARKET_2]);
    expect(h.fake.calls.listMarkets.at(-1)?.status).toBe("closed");
  });

  it("answers a batch of ids in the order of ids, with unknown and other tenants' markets left out (DM-12)", async () => {
    const unknown = "018f3c1e-7a00-7000-8000-0000000000f1";
    const answer = await call(h, "GET", `${LIST}?ids=${MARKET_3},${unknown},${MARKET_1}`);
    expect(answer.status).toBe(200);
    expectContract(LIST, "GET", answer);
    expect((answer.body?.["items"] as Array<{ marketId: string }>).map((item) => item.marketId)).toEqual([MARKET_3, MARKET_1]);
    expect(answer.body?.["nextCursor"]).toBeNull();
    // The route splits the comma-separated text; checking the ids is the use case's.
    expect(h.fake.calls.listMarkets[0]?.ids).toEqual([MARKET_3, unknown, MARKET_1]);
  });

  it("is a 400 on `ids` when it comes with status, limit or cursor (the use case's answer), and for a malformed list", async () => {
    expectInvalid(await call(h, "GET", `${LIST}?ids=${MARKET_1}&status=open`), "ids");
    expectInvalid(await call(h, "GET", `${LIST}?ids=${MARKET_1}&limit=5`), "ids");
    expectInvalid(await call(h, "GET", `${LIST}?ids=${MARKET_1},,${MARKET_2}`), "ids");
    expectInvalid(await call(h, "GET", `${LIST}?ids=${MARKET_1},not-a-uuid-not-a-uuid-not-a-uuid-xx`), "ids");
    // Shorter than one UUID: refused by the schema before a use case runs.
    h.fake.clearCalls();
    expectInvalid(await call(h, "GET", `${LIST}?ids=abc`), "ids");
    expect(h.fake.calls.listMarkets).toEqual([]);
  });

  it("refuses what the schema does not allow with a 400 that names the field: unknown parameter, status, limit, cursor", async () => {
    const cases: Array<[string, string]> = [
      ["?nonsense=1", "nonsense"],
      ["?status=pending", "status"],
      ["?status=", "status"],
      ["?limit=0", "limit"],
      ["?limit=101", "limit"],
      ["?limit=abc", "limit"],
      ["?limit=2.5", "limit"],
      ["?limit=1&limit=2", "limit"],
      ["?cursor=", "cursor"],
      [`?cursor=${"x".repeat(201)}`, "cursor"],
    ];
    for (const [query, field] of cases) {
      const answer = await call(h, "GET", `${LIST}${query}`);
      expectInvalid(answer, field);
      expectContract(LIST, "GET", answer);
    }
    expect(h.fake.calls.listMarkets).toEqual([]);
  });

  it("answers the use case's errors: 400 for a cursor it refuses, 503 with Retry-After while the tenant is not ready", async () => {
    const bad = await call(h, "GET", `${LIST}?cursor=bm90LWEtY3Vyc29y`);
    expectInvalid(bad, "cursor");
    expectContract(LIST, "GET", bad);

    h.fake.failWith("listMarkets", new TenantNotReady());
    const notReady = await call(h, "GET", LIST);
    expect(notReady.status).toBe(503);
    expect(notReady.headers["retry-after"]).toBe("5");
    expect(notReady.body).toMatchObject({ code: "tenant_not_ready", type: "urn:chance:problem:tenant-not-ready", status: 503 });
    expectContract(LIST, "GET", notReady);
  });

  it("reaches a tenant that nobody provisioned as 503 tenant_not_ready", async () => {
    const stranger = "018f3c1e-7a00-7000-8000-0000000000cc";
    const answer = await call(h, "GET", LIST, { token: asTrader("c-1", stranger) });
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ code: "tenant_not_ready" });
  });
});

describe("GET /v1/market-data/markets/{marketId}", () => {
  it("answers the market, for a trader and for a tenant admin alike", async () => {
    for (const token of [asTrader(), asTenantAdmin()]) {
      const answer = await call(h, "GET", marketUrl(MARKET_3), { token });
      expect(answer.status).toBe(200);
      expectContract(DETAIL, "GET", answer);
      expect(answer.body).toMatchObject({ marketId: MARKET_3, status: "resolved", outcome: "YES", currentPriceYesMicro: 1_000_000, resolvedAt: at(110).toISOString(), closedAt: at(100).toISOString(), version: 3 });
    }
    expect(h.fake.calls.getMarket.map((input) => input.afterSequence)).toEqual([undefined, undefined]);
  });

  it("lowers the case of the id before the use case sees it", async () => {
    const answer = await call(h, "GET", marketUrl(MARKET_1.toUpperCase()));
    expect(answer.status).toBe(200);
    expect(h.fake.calls.getMarket[0]?.marketId).toBe(MARKET_1);
    expect(answer.body?.["marketId"]).toBe(MARKET_1);
  });

  it("is 404 for a market the tenant does not know, with a problem+json body", async () => {
    const answer = await call(h, "GET", marketUrl("018f3c1e-7a00-7000-8000-0000000000f1"));
    expect(answer.status).toBe(404);
    expect(answer.headers["content-type"]).toContain("application/problem+json");
    expect(answer.body).toMatchObject({ status: 404, code: "not_found", type: "urn:chance:problem:not-found", instance: "/v1/market-data/markets/018f3c1e-7a00-7000-8000-0000000000f1" });
    expectContract(DETAIL, "GET", answer);
  });

  it("is a 400 on marketId for an id that is no UUID, and on afterSequence for a value outside 1..2^53-1 or no number", async () => {
    expectInvalid(await call(h, "GET", marketUrl("not-a-uuid")), "marketId");
    for (const query of ["?afterSequence=0", "?afterSequence=-1", "?afterSequence=abc", "?afterSequence=1.5", "?afterSequence=9007199254740992"]) {
      const answer = await call(h, "GET", marketUrl(MARKET_1, query));
      expectInvalid(answer, "afterSequence");
      expectContract(DETAIL, "GET", answer);
    }
    expectInvalid(await call(h, "GET", marketUrl(MARKET_1, "?nonsense=1")), "nonsense");
    expect(h.fake.calls.getMarket).toEqual([]);
  });

  it("waits for the caller's own trade (DM-17): 409 updating with lastTradeSequence until the trade is there, then 200", async () => {
    const behind = await call(h, "GET", marketUrl(MARKET_1, "?afterSequence=4"));
    expect(behind.status).toBe(409);
    expect(behind.headers["content-type"]).toContain("application/problem+json");
    expect(behind.body).toMatchObject({ status: 409, code: "updating", type: "urn:chance:problem:updating", lastTradeSequence: 3 });
    expect(behind.headers["retry-after"]).toBeUndefined();
    expectContract(DETAIL, "GET", behind);

    const there = await call(h, "GET", marketUrl(MARKET_1, "?afterSequence=3"));
    expect(there.status).toBe(200);
    expectContract(DETAIL, "GET", there);
    expect(h.fake.calls.getMarket.map((input) => input.afterSequence)).toEqual([4, 3]);
  });

  it("answers 503 with Retry-After from the use case, and an unexpected error as a 500 that does not leak its message", async () => {
    h.fake.failWith("getMarket", new TenantNotReady(7));
    const notReady = await call(h, "GET", marketUrl(MARKET_1));
    expect(notReady.status).toBe(503);
    expect(notReady.headers["retry-after"]).toBe("7");
    expectContract(DETAIL, "GET", notReady);

    h.fake.failWith("getMarket", new Error("connection to 10.0.0.1 refused"));
    const broken = await call(h, "GET", marketUrl(MARKET_1));
    expect(broken.status).toBe(500);
    expect(broken.body).toMatchObject({ code: "internal_error", detail: "The service failed to handle the request" });
    expect(JSON.stringify(broken.body)).not.toContain("10.0.0.1");
    expect(broken.headers["cache-control"]).toBe("private, no-store");
  });
});

describe("GET /v1/market-data/markets/{marketId}/history", () => {
  it("answers the buckets of the default range, newest range first page: sparse, OHLC by trade sequence, the opening point not a trade", async () => {
    const answer = await call(h, "GET", historyUrl(MARKET_1));
    expect(answer.status).toBe(200);
    expectContract(HISTORY, "GET", answer);
    expect(answer.body).toEqual({
      marketId: MARKET_1,
      interval: "1h",
      from: "2026-11-01T10:00:00.000Z",
      to: at(24 * 60).toISOString(),
      previousCloseYesMicro: null,
      buckets: [
        { start: "2026-11-01T10:00:00.000Z", openYesMicro: 400_000, highYesMicro: 500_000, lowYesMicro: 400_000, closeYesMicro: 500_000, volumeMicro: 20_000_000, trades: 2 },
        { start: "2026-11-01T11:00:00.000Z", openYesMicro: 550_000, highYesMicro: 550_000, lowYesMicro: 550_000, closeYesMicro: 550_000, volumeMicro: 10_000_000, trades: 1 },
      ],
      nextCursor: null,
    });
  });

  it("passes interval, from, to, limit, cursor and afterSequence on, dates as Dates and the rest unchanged", async () => {
    const answer = await call(h, "GET", historyUrl(MARKET_1, "?interval=15m&from=2026-11-01T10:07:00Z&to=2026-11-01T12:00:00.000Z&limit=7&afterSequence=2"));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expectContract(HISTORY, "GET", answer);
    expect(answer.body).toMatchObject({ interval: "15m", from: "2026-11-01T10:00:00.000Z", to: "2026-11-01T12:00:00.000Z" });
    const input = h.fake.calls.getHistory[0];
    expect(input).toMatchObject({ marketId: MARKET_1, interval: "15m", limit: 7, afterSequence: 2 });
    expect(input?.from).toEqual(new Date("2026-11-01T10:07:00Z"));
    expect(input?.to).toEqual(new Date("2026-11-01T12:00:00.000Z"));
    expect(input?.cursor).toBeUndefined();
    expect(Object.keys(input ?? {}).sort()).toEqual(["actor", "afterSequence", "from", "interval", "limit", "marketId", "to"]);
  });

  it("pages with the cursor, which goes through unchanged, and the later page needs neither from nor to", async () => {
    const first = await call(h, "GET", historyUrl(MARKET_1, "?limit=1"));
    expect(first.status).toBe(200);
    expectContract(HISTORY, "GET", first);
    expect((first.body?.["buckets"] as unknown[]).length).toBe(1);
    expect(first.body?.["previousCloseYesMicro"]).toBeNull();
    const cursor = first.body?.["nextCursor"] as string;
    expect(cursor).toEqual(expect.any(String));

    const second = await call(h, "GET", historyUrl(MARKET_1, `?limit=1&cursor=${cursor}`));
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expectContract(HISTORY, "GET", second);
    expect((second.body?.["buckets"] as Array<{ start: string }>).map((bucket) => bucket.start)).toEqual(["2026-11-01T11:00:00.000Z"]);
    expect(second.body?.["nextCursor"]).toBeNull();
    // The latest point before this page: the close of the first bucket.
    expect(second.body?.["previousCloseYesMicro"]).toBe(500_000);
    // The range of page 1 comes back, whatever the clock says.
    expect(second.body).toMatchObject({ from: first.body?.["from"], to: first.body?.["to"] });

    expect(h.fake.calls.getHistory[1]).toMatchObject({ cursor, limit: 1 });
    expect(h.fake.calls.getHistory[1]?.from).toBeUndefined();
    expect(h.fake.calls.getHistory[1]?.to).toBeUndefined();
  });

  it("hands a `from` or `to` that is no real time (a leap second) to the use case as an Invalid Date, which answers 400 on that field", async () => {
    for (const field of ["from", "to"] as const) {
      h.fake.clearCalls();
      const answer = await call(h, "GET", historyUrl(MARKET_1, `?${field}=2016-12-31T23:59:60Z`));
      expectInvalid(answer, field);
      expectContract(HISTORY, "GET", answer);
      const received = h.fake.calls.getHistory[0]?.[field];
      expect(received).toBeInstanceOf(Date);
      expect(Number.isNaN(received?.getTime())).toBe(true);
    }
  });

  it("refuses with a 400 that names the field: unknown parameter, interval, date, limit, cursor, afterSequence, marketId", async () => {
    const cases: Array<[string, string]> = [
      ["?nonsense=1", "nonsense"],
      ["?interval=2h", "interval"],
      ["?interval=1H", "interval"],
      ["?from=yesterday", "from"],
      ["?to=2026-11-01", "to"],
      ["?from=2026-13-01T00:00:00Z", "from"],
      ["?limit=0", "limit"],
      ["?limit=501", "limit"],
      ["?cursor=", "cursor"],
      ["?afterSequence=0", "afterSequence"],
    ];
    for (const [query, field] of cases) {
      const answer = await call(h, "GET", historyUrl(MARKET_1, query));
      expectInvalid(answer, field);
      expectContract(HISTORY, "GET", answer);
    }
    expectInvalid(await call(h, "GET", historyUrl("not-a-uuid")), "marketId");
    expect(h.fake.calls.getHistory).toEqual([]);
  });

  it("answers the use case's 400 with the extension member maxPoints, and 400 on cursor for a cursor of another interval", async () => {
    h.fake.failWith("getHistory", new ValidationFailed([{ field: "from", message: "The range is too large" }], "The range is too large", "validation_failed", { maxPoints: 1000 }));
    const tooLarge = await call(h, "GET", historyUrl(MARKET_1, "?from=2026-01-01T00:00:00Z"));
    expectInvalid(tooLarge, "from");
    expect(tooLarge.body?.["maxPoints"]).toBe(1000);
    expectContract(HISTORY, "GET", tooLarge);
    h.fake.clearFailures();

    const first = await call(h, "GET", historyUrl(MARKET_1, "?limit=1"));
    const wrongInterval = await call(h, "GET", historyUrl(MARKET_1, `?interval=5m&cursor=${first.body?.["nextCursor"] as string}`));
    expectInvalid(wrongInterval, "cursor");
  });

  it("answers 404 for an unknown market, 409 updating with lastTradeSequence, and 503 history_paused and tenant_not_ready with Retry-After", async () => {
    const missing = await call(h, "GET", historyUrl("018f3c1e-7a00-7000-8000-0000000000f1"));
    expect(missing.status).toBe(404);
    expectContract(HISTORY, "GET", missing);

    const behind = await call(h, "GET", historyUrl(MARKET_1, "?afterSequence=9"));
    expect(behind.status).toBe(409);
    expect(behind.body).toMatchObject({ code: "updating", lastTradeSequence: 3 });
    expectContract(HISTORY, "GET", behind);

    h.fake.failWith("getHistory", new HistoryPaused());
    const paused = await call(h, "GET", historyUrl(MARKET_1));
    expect(paused.status).toBe(503);
    expect(paused.headers["retry-after"]).toBe("30");
    expect(paused.body).toMatchObject({ code: "history_paused", type: "urn:chance:problem:history-paused" });
    expectContract(HISTORY, "GET", paused);

    h.fake.failWith("getHistory", new TenantNotReady());
    const notReady = await call(h, "GET", historyUrl(MARKET_1));
    expect(notReady.status).toBe(503);
    expect(notReady.body).toMatchObject({ code: "tenant_not_ready" });
    expectContract(HISTORY, "GET", notReady);

    h.fake.failWith("getHistory", new NotFound());
    expect((await call(h, "GET", historyUrl(MARKET_1))).status).toBe(404);
    h.fake.failWith("getHistory", new Updating(5));
    expect((await call(h, "GET", historyUrl(MARKET_1))).body).toMatchObject({ lastTradeSequence: 5 });
  });

  it("keeps a tenant's history to the tenant: the caller's tenant is the use case's actor", async () => {
    await call(h, "GET", historyUrl(MARKET_1), { token: asTrader("t-1", TENANT_A) });
    expect(h.fake.calls.getHistory[0]?.actor.tenantId).toBe(TENANT_A);
  });
});
