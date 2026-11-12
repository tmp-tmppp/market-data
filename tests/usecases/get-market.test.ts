import { describe, expect, it } from "vitest";
import { NotFound, TenantNotReady, Updating, UseCaseError, ValidationFailed } from "../../src/usecases/errors.js";
import { GetMarket } from "../../src/usecases/get-market.js";
import type { Store } from "../../src/usecases/ports.js";
import { MARKET_1, MARKET_2, TENANT_B, actor, at, marketOpenedBody, marketResolvedBody, tradeExecutedBody } from "../support/fakes.js";
import { consume, consumeAll, createCore } from "./core.js";
import type { Core } from "./core.js";

const trader = actor();

/**
 * The store of a core whose first read of the read model (the summary or the point, whichever the use case asks for
 * first) is followed by `commit`: the commit of a live transaction that lands between the two statements of GetMarket,
 * which are separate statements of the pool in PostgreSQL.
 */
function storeCommittingAfterFirstRead(core: Core, commit: () => Promise<unknown>): Store {
  let done = false;
  const afterFirstRead = async (): Promise<void> => {
    if (done) return;
    done = true;
    await commit();
  };
  return {
    repositories: core.store.repositories,
    transaction: (work) => core.store.transaction(work),
    forTenant: async (tenantId) => {
      const tenant = await core.store.forTenant(tenantId);
      if (tenant === null) return null;
      const { readModel } = tenant.repositories;
      const summary = async (marketId: string) => {
        const result = await readModel.summary(marketId);
        await afterFirstRead();
        return result;
      };
      const hasPoint = async (marketId: string, tradeSequence: number) => {
        const result = await readModel.hasPoint(marketId, tradeSequence);
        await afterFirstRead();
        return result;
      };
      return { ...tenant, repositories: { ...tenant.repositories, readModel: { ...readModel, summary, hasPoint } } };
    },
    ensureTenant: (tenantId, now) => core.store.ensureTenant(tenantId, now),
    ping: () => core.store.ping(),
  };
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

describe("GetMarket (EP-4, DM-17)", () => {
  it("returns the market as the API shows it, for a trader and for a tenant admin", async () => {
    const core = createCore();
    await consumeAll(core, [
      marketOpenedBody({ marketId: MARKET_1, question: "  Will the demo work?  ", startingPrice: 0.35, closeTime: at(120), openedAt: at(1) }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 420_000, costMicro: 7_000_000, executedAt: at(5) }),
    ]);
    const expected = {
      marketId: MARKET_1,
      question: "Will the demo work?",
      status: "open",
      closeTime: at(120),
      openedAt: at(1),
      closedAt: null,
      resolvedAt: null,
      outcome: null,
      startingPriceYesMicro: 350_000,
      lastPriceYesMicro: 420_000,
      currentPriceYesMicro: 420_000,
      volumeMicro: 7_000_000,
      tradeCount: 1,
      lastTradeSequence: 1,
      lastTradeAt: at(5),
      version: 1,
    };
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject(expected);
    expect(await core.getMarket.execute({ actor: actor("admin", "tenant-admin"), marketId: MARKET_1.toUpperCase() })).toMatchObject(expected);
  });

  it("shows the starting price until the first trade and the final price once resolved", async () => {
    const core = createCore();
    await consume(core, marketOpenedBody({ marketId: MARKET_1, startingPrice: 0.4 }));
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ lastPriceYesMicro: null, currentPriceYesMicro: 400_000, lastTradeAt: null });
    await consume(core, marketResolvedBody({ marketId: MARKET_1, outcome: "YES" }));
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ status: "resolved", outcome: "YES", currentPriceYesMicro: 1_000_000, lastPriceYesMicro: null });
  });

  it("answers not found for an unknown market, a market of another tenant and a market whose MarketOpened has not arrived", async () => {
    const core = createCore();
    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    await consume(core, tradeExecutedBody({ marketId: MARKET_2, tradeSequence: 1, yesPriceMicro: 450_000 }));
    await consume(core, marketOpenedBody({ tenantId: TENANT_B, marketId: MARKET_2 }));
    expect(await failure(core.getMarket.execute({ actor: trader, marketId: "018f3c1e-7a00-7000-8000-0000000000ff" }))).toMatchObject({ kind: "not_found", code: "not_found" });
    // Tenant A has MARKET_2's trade but not its MarketOpened; tenant B has MARKET_2 complete: tenant A still sees nothing.
    await expect(core.getMarket.execute({ actor: trader, marketId: MARKET_2 })).rejects.toBeInstanceOf(NotFound);
    expect(await core.getMarket.execute({ actor: actor("trader-b", "trader", TENANT_B), marketId: MARKET_2 })).toMatchObject({ marketId: MARKET_2, tradeCount: 0 });
    await expect(core.getMarket.execute({ actor: actor("trader-b", "trader", TENANT_B), marketId: MARKET_1 })).rejects.toBeInstanceOf(NotFound);
  });

  it("answers updating (409) with the last trade sequence until the caller's trade is in, then 200 (DM-17)", async () => {
    const core = createCore();
    await consumeAll(core, [marketOpenedBody({ marketId: MARKET_1 }), tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000 }), tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 460_000 })]);
    expect((await core.getMarket.execute({ actor: trader, marketId: MARKET_1, afterSequence: 2 })).lastTradeSequence).toBe(2);
    expect((await core.getMarket.execute({ actor: trader, marketId: MARKET_1, afterSequence: 1 })).lastTradeSequence).toBe(2);

    const error = await failure(core.getMarket.execute({ actor: trader, marketId: MARKET_1, afterSequence: 3 }));
    expect(error).toBeInstanceOf(Updating);
    expect(error).toMatchObject({ kind: "conflict", code: "updating", details: { lastTradeSequence: 2 } });

    await consume(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 3, yesPriceMicro: 470_000 }));
    expect((await core.getMarket.execute({ actor: trader, marketId: MARKET_1, afterSequence: 3 })).lastPriceYesMicro).toBe(470_000);
  });

  it("checks the market (404) before afterSequence (409), and a trade that arrived out of order satisfies it by its own point", async () => {
    const core = createCore();
    await expect(core.getMarket.execute({ actor: trader, marketId: MARKET_1, afterSequence: 1 })).rejects.toBeInstanceOf(TenantNotReady);
    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    await expect(core.getMarket.execute({ actor: trader, marketId: MARKET_2, afterSequence: 5 })).rejects.toBeInstanceOf(NotFound);
    // Sequence 2 arrives before sequence 1: its point exists, so afterSequence 2 is satisfied although 1 is still missing.
    await consume(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 460_000 }));
    expect((await core.getMarket.execute({ actor: trader, marketId: MARKET_1, afterSequence: 2 })).tradeCount).toBe(1);
    await expect(core.getMarket.execute({ actor: trader, marketId: MARKET_1, afterSequence: 1 })).rejects.toBeInstanceOf(Updating);
  });

  it("never answers 200 with a summary that lacks the trade: a trade committed between the two reads makes it 409, and the retry gets the trade (DM-17)", async () => {
    const core = createCore();
    await consumeAll(core, [marketOpenedBody({ marketId: MARKET_1 })]);
    const racing = new GetMarket({ store: storeCommittingAfterFirstRead(core, () => consume(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000 }))), clock: core.clock, logger: core.logger });

    // Read first: the point is not there yet, so the answer is 409 although the trade has committed by the time the summary
    // is read; a summary read first would be older than a point that then passes (200 with tradeCount 0).
    await expect(racing.execute({ actor: trader, marketId: MARKET_1, afterSequence: 1 })).rejects.toBeInstanceOf(Updating);
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1, afterSequence: 1 })).toMatchObject({ tradeCount: 1, lastTradeSequence: 1, lastPriceYesMicro: 450_000 });
  });

  it("answers 404 before 409 also for a market that is not listed yet and whose point is missing", async () => {
    const core = createCore();
    // Only a trade of MARKET_2 (point 1) arrived; its MarketOpened has not: the summary exists but is not listed.
    await consume(core, tradeExecutedBody({ marketId: MARKET_2, tradeSequence: 1, yesPriceMicro: 450_000 }));
    await expect(core.getMarket.execute({ actor: trader, marketId: MARKET_2, afterSequence: 5 })).rejects.toBeInstanceOf(NotFound);
    await expect(core.getMarket.execute({ actor: trader, marketId: MARKET_2, afterSequence: 1 })).rejects.toBeInstanceOf(NotFound);
  });

  it("refuses a malformed id or afterSequence with a field error, before it looks at the tenant", async () => {
    const core = createCore();
    const field = async (input: { marketId: string; afterSequence?: number }) => {
      const error = await failure(core.getMarket.execute({ actor: trader, ...input }));
      expect(error).toBeInstanceOf(ValidationFailed);
      return error.fields[0]?.field;
    };
    expect(await field({ marketId: "nope" })).toBe("marketId");
    expect(await field({ marketId: MARKET_1, afterSequence: 0 })).toBe("afterSequence");
    expect(await field({ marketId: MARKET_1, afterSequence: 1.5 })).toBe("afterSequence");
  });

  it("answers tenant-not-ready for a tenant that has no schema yet", async () => {
    const core = createCore();
    const error = await failure(core.getMarket.execute({ actor: trader, marketId: MARKET_1 }));
    expect(error).toBeInstanceOf(TenantNotReady);
    expect(error).toMatchObject({ kind: "unavailable", code: "tenant_not_ready" });
  });
});
