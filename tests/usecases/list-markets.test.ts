import { describe, expect, it } from "vitest";
import { encodeMarketCursor, MAX_IDS } from "../../src/usecases/support.js";
import { TenantNotReady, UseCaseError, ValidationFailed } from "../../src/usecases/errors.js";
import { MARKET_1, MARKET_2, MARKET_3, TENANT_A, TENANT_B, actor, marketClosedBody, marketOpenedBody, marketResolvedBody, tradeExecutedBody } from "../support/fakes.js";
import { consumeAll, createCore } from "./core.js";
import type { Core } from "./core.js";

const trader = actor();
const UNKNOWN = "018f3c1e-7a00-7000-8000-0000000000ff";

/** Market 1 open with a trade, market 2 closed, market 3 resolved YES; a fourth market only seen through a trade. */
async function seeded(): Promise<Core> {
  const core = createCore();
  await consumeAll(core, [
    marketOpenedBody({ marketId: MARKET_1, question: "First market?" }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, costMicro: 2_000_000 }),
    marketOpenedBody({ marketId: MARKET_2, question: "Second market?" }),
    marketClosedBody({ marketId: MARKET_2 }),
    marketOpenedBody({ marketId: MARKET_3, question: "Third market?" }),
    marketResolvedBody({ marketId: MARKET_3, outcome: "YES" }),
    tradeExecutedBody({ marketId: "018f3c1e-7a00-7000-8000-000000000104", tradeSequence: 1, yesPriceMicro: 500_000 }),
  ]);
  return core;
}

const failure = async (promise: Promise<unknown>): Promise<UseCaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UseCaseError) return error;
    throw error;
  }
  throw new Error("The call did not fail");
};

describe("ListMarkets (EP-4, DM-12)", () => {
  it("lists the listed markets newest first, with the price the API shows", async () => {
    const core = await seeded();
    const page = await core.listMarkets.execute({ actor: trader });
    expect(page.nextCursor).toBeNull();
    // The fourth market has a trade but no MarketOpened: not listed.
    expect(page.items.map((item) => item.marketId)).toEqual([MARKET_3, MARKET_2, MARKET_1]);
    expect(page.items.map((item) => [item.status, item.currentPriceYesMicro])).toEqual([
      ["resolved", 1_000_000],
      ["closed", 400_000],
      ["open", 450_000],
    ]);
  });

  it("pages with a cursor, one row more than the page decides whether another page follows", async () => {
    const core = await seeded();
    const first = await core.listMarkets.execute({ actor: trader, limit: 2 });
    expect(first.items.map((item) => item.marketId)).toEqual([MARKET_3, MARKET_2]);
    expect(first.nextCursor).toBe(encodeMarketCursor(MARKET_2));
    const second = await core.listMarkets.execute({ actor: trader, limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((item) => item.marketId)).toEqual([MARKET_1]);
    expect(second.nextCursor).toBeNull();
    // A page that ends exactly on the last market has no next cursor.
    expect((await core.listMarkets.execute({ actor: trader, limit: 3 })).nextCursor).toBeNull();
    expect((await core.listMarkets.execute({ actor: trader, limit: 1 })).nextCursor).toBe(encodeMarketCursor(MARKET_3));
  });

  it("filters by status", async () => {
    const core = await seeded();
    expect((await core.listMarkets.execute({ actor: trader, status: "closed" })).items.map((item) => item.marketId)).toEqual([MARKET_2]);
    expect((await core.listMarkets.execute({ actor: trader, status: "open" })).items.map((item) => item.marketId)).toEqual([MARKET_1]);
    expect((await core.listMarkets.execute({ actor: trader, status: "resolved", limit: 5 })).items.map((item) => item.marketId)).toEqual([MARKET_3]);
  });

  it("answers an id batch in the order of the ids, leaving out unknown, unlisted and collapsing repeats (DM-12)", async () => {
    const core = await seeded();
    const batch = await core.listMarkets.execute({ actor: trader, ids: [MARKET_2, UNKNOWN, MARKET_1.toUpperCase(), MARKET_2, "018f3c1e-7a00-7000-8000-000000000104", MARKET_3] });
    expect(batch.items.map((item) => item.marketId)).toEqual([MARKET_2, MARKET_1, MARKET_3]);
    expect(batch.nextCursor).toBeNull();
    expect((await core.listMarkets.execute({ actor: trader, ids: [UNKNOWN] })).items).toEqual([]);
  });

  it("refuses the bad shapes with a field error: ids with status, limit or cursor, bad ids, bad status, limit or cursor", async () => {
    const core = await seeded();
    const field = async (input: Parameters<typeof core.listMarkets.execute>[0]) => {
      const error = await failure(core.listMarkets.execute(input));
      expect(error).toBeInstanceOf(ValidationFailed);
      expect(error.kind).toBe("validation");
      return error.fields[0]?.field;
    };
    expect(await field({ actor: trader, ids: [MARKET_1], status: "open" })).toBe("ids");
    expect(await field({ actor: trader, ids: [MARKET_1], limit: 5 })).toBe("ids");
    expect(await field({ actor: trader, ids: [MARKET_1], cursor: encodeMarketCursor(MARKET_2) })).toBe("ids");
    expect(await field({ actor: trader, ids: [] })).toBe("ids");
    expect(await field({ actor: trader, ids: ["not-a-uuid"] })).toBe("ids");
    expect(await field({ actor: trader, ids: Array.from({ length: MAX_IDS + 1 }, (_, i) => `018f3c1e-7a00-7000-8000-${String(i + 1000).padStart(12, "0")}`) })).toBe("ids");
    expect(await field({ actor: trader, status: "paused" as never })).toBe("status");
    expect(await field({ actor: trader, limit: 0 })).toBe("limit");
    expect(await field({ actor: trader, limit: 101 })).toBe("limit");
    expect(await field({ actor: trader, limit: 1.5 })).toBe("limit");
    expect(await field({ actor: trader, cursor: "garbage" })).toBe("cursor");
    // 100 ids is the most one batch may name.
    const hundred = Array.from({ length: MAX_IDS }, (_, i) => `018f3c1e-7a00-7000-8000-${String(i + 1000).padStart(12, "0")}`);
    expect((await core.listMarkets.execute({ actor: trader, ids: hundred })).items).toEqual([]);
  });

  it("answers tenant-not-ready for a tenant whose TenantCreated has not been processed, for both shapes", async () => {
    const core = await seeded();
    const stranger = actor("trader-x", "trader", TENANT_B);
    await expect(core.listMarkets.execute({ actor: stranger })).rejects.toBeInstanceOf(TenantNotReady);
    await expect(core.listMarkets.execute({ actor: stranger, ids: [MARKET_1] })).rejects.toBeInstanceOf(TenantNotReady);
    const error = await failure(core.listMarkets.execute({ actor: stranger }));
    expect(error).toMatchObject({ kind: "unavailable", code: "tenant_not_ready", retryAfterSeconds: 5 });
  });

  it("shows a tenant only its own markets, in the list and in an id batch", async () => {
    const core = await seeded();
    await consumeAll(core, [marketOpenedBody({ tenantId: TENANT_B, marketId: MARKET_2, question: "Tenant B's market?" })]);
    const asB = actor("trader-b", "trader", TENANT_B);
    expect((await core.listMarkets.execute({ actor: asB })).items.map((item) => item.question)).toEqual(["Tenant B's market?"]);
    expect((await core.listMarkets.execute({ actor: asB, ids: [MARKET_1, MARKET_2, MARKET_3] })).items.map((item) => item.marketId)).toEqual([MARKET_2]);
    expect((await core.listMarkets.execute({ actor: actor("admin", "tenant-admin", TENANT_A), ids: [MARKET_2] })).items[0]?.question).toBe("Second market?");
  });
});
