import { describe, expect, it } from "vitest";
import { MARKET_EVENTS_CONSUMER, TRADE_EVENTS_CONSUMER } from "../../src/usecases/support.js";
import { NotFound } from "../../src/usecases/errors.js";
import { MARKET_1, MARKET_2, T0, TENANT_A, TENANT_B, actor, at, marketClosedBody, marketOpenedBody, marketResolvedBody, tradeExecutedBody } from "../support/fakes.js";
import { activeVersionOf, consume, consumeAll, createCore, expectActiveEquals, foldBodies, stateOf } from "./core.js";

const trader = actor();

describe("RecordProjectionEvent (DM-04, DM-09, DM-10, ADR-032, ADR-058)", () => {
  it("stores and projects a market's lifecycle and trades, each in one transaction of its tenant", async () => {
    const core = createCore();
    const bodies = [
      marketOpenedBody({ marketId: MARKET_1 }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, costMicro: 10_000_000 }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 520_000, costMicro: 5_000_000 }),
      marketClosedBody({ marketId: MARKET_1 }),
    ];
    expect(await consumeAll(core, bodies)).toEqual(["applied", "applied", "applied", "applied"]);

    const market = await core.getMarket.execute({ actor: trader, marketId: MARKET_1 });
    expect(market).toMatchObject({ status: "closed", version: 2, startingPriceYesMicro: 400_000, lastPriceYesMicro: 520_000, currentPriceYesMicro: 520_000, volumeMicro: 15_000_000, tradeCount: 2, lastTradeSequence: 2 });
    const state = core.store.snapshot();
    expect(state.tenantData[TENANT_A]?.consumedEvents.map((row) => [row.position, row.eventType.split(".").at(-2), row.marketId])).toEqual([
      [1, "MarketOpened", MARKET_1],
      [2, "TradeExecuted", MARKET_1],
      [3, "TradeExecuted", MARKET_1],
      [4, "MarketClosed", MARKET_1],
    ]);
    expect(state.tenantData[TENANT_A]?.consumedEvents[1]?.event).toEqual(bodies[1]);
    expect(state.inbox.map((row) => row.consumer)).toEqual([MARKET_EVENTS_CONSUMER, TRADE_EVENTS_CONSUMER, TRADE_EVENTS_CONSUMER, MARKET_EVENTS_CONSUMER]);
    expectActiveEquals(core, bodies);
    expect(core.logger.lines[0]).toMatchObject({ level: "info", fields: { tenantId: TENANT_A, marketId: MARKET_1, version: 1, result: "applied" } });
  });

  it("reports a repeated sequence and an older version with nothing to fill as stale, and filled facts as applied", async () => {
    const core = createCore();
    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    await consume(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000 }));
    const before = stateOf(core, 1);

    // The same trade sequence under another event id (a republished trade): nothing changes.
    expect(await consume(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 600_000, costMicro: 99_000_000 }))).toBe("stale");
    // The same market version again: nothing is missing.
    expect(await consume(core, marketOpenedBody({ marketId: MARKET_1, question: "Another question?" }))).toBe("stale");
    expect(stateOf(core, 1).summaries.get(MARKET_1)).toEqual(before.summaries.get(MARKET_1));
    expect(stateOf(core, 1).points.size).toBe(before.points.size);

    // MarketClosed (version 2) before MarketOpened (version 1): the older MarketOpened fills the facts, not the status.
    expect(await consume(core, marketClosedBody({ marketId: MARKET_2, version: 2 }))).toBe("applied");
    expect(await consume(core, marketOpenedBody({ marketId: MARKET_2, version: 1, question: "Filled afterwards?" }))).toBe("applied");
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_2 })).toMatchObject({ status: "closed", version: 2, question: "Filled afterwards?" });
  });

  it("answers duplicate for a redelivery (the inbox) and for a stored id whose inbox entry was purged (consumed_events)", async () => {
    const core = createCore();
    const opened = marketOpenedBody({ marketId: MARKET_1 });
    const trade = tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000 });
    expect(await consumeAll(core, [opened, trade])).toEqual(["applied", "applied"]);
    const before = core.store.snapshot().tenantData[TENANT_A];

    expect(await consume(core, trade)).toBe("duplicate");
    expect(core.store.snapshot().tenantData[TENANT_A]).toEqual(before);

    // The inbox is purged after 31 days; consumed_events never is, and it refuses the id.
    await core.store.repositories.inbox.purge(new Date(T0.getTime() + 24 * 3_600_000));
    expect(core.store.snapshot().inbox).toEqual([]);
    expect(await consume(core, trade)).toBe("duplicate");
    expect(core.store.snapshot().tenantData[TENANT_A]).toEqual(before);

    // An event id is unique across both consumers: a MarketOpened that reuses a trade's id is a duplicate too.
    expect(await consume(core, { ...marketOpenedBody({ marketId: MARKET_2 }), id: trade["id"] })).toBe("duplicate");
    expect(await core.listMarkets.execute({ actor: trader })).toMatchObject({ items: [expect.objectContaining({ marketId: MARKET_1 })] });
  });

  it("stores an event of another type without projecting it, and a repeat of it is a duplicate", async () => {
    const core = createCore();
    const operations: string[] = [];
    core.store.hooks.onOperation = (operation) => operations.push(operation);
    const created = { ...marketOpenedBody({ marketId: MARKET_1 }), type: "si.chance.markets.MarketCreated.v1" };

    expect(await consume(core, created)).toBe("unprojected");
    expect(await consume(core, created)).toBe("duplicate");

    const stored = core.store.snapshot().tenantData[TENANT_A];
    expect(stored?.consumedEvents).toHaveLength(1);
    expect(stored?.consumedEvents[0]).toMatchObject({ eventType: "si.chance.markets.MarketCreated.v1", marketId: MARKET_1, position: 1 });
    expect(stored?.versions[1]).toEqual({ summaries: [], points: [] });
    // No projection lock for an event nobody projects, and a normal skip is not logged.
    expect(operations).not.toContain("checkpoints.targets");
    expect(operations).not.toContain("projections.insertSummary");
    expect(core.logger.lines).toEqual([]);
    expect(core.store.snapshot().inbox.map((row) => row.consumer)).toEqual([MARKET_EVENTS_CONSUMER]);
  });

  it("stores an event of a projected type that this reader cannot read, warns with the reason, and projects nothing", async () => {
    const core = createCore();
    const later = { ...tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000 }), type: "si.chance.trading.TradeExecuted.v2" };
    const badPrice = tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 5 });
    const opened = marketOpenedBody({ marketId: MARKET_1 });

    expect(await consumeAll(core, [opened, later, badPrice])).toEqual(["applied", "unprojected", "unprojected"]);

    const stored = core.store.snapshot().tenantData[TENANT_A];
    expect(stored?.consumedEvents.map((row) => row.eventType.split(".").slice(-2).join("."))).toEqual(["MarketOpened.v1", "TradeExecuted.v2", "TradeExecuted.v1"]);
    // Neither trade changed the read model; the market has no trades.
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ tradeCount: 0, volumeMicro: 0 });
    const warnings = core.logger.lines.filter((line) => line.level === "warn");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.fields).toMatchObject({ tenantId: TENANT_A, marketId: MARKET_1, result: "unprojected" });
    expect(JSON.stringify(warnings[0]?.fields)).toContain("TradeExecuted.v2");
    expect(JSON.stringify(warnings[1]?.fields)).toContain("yesPriceMicro");
    // A trading event goes through the trade consumer's inbox even when it is not projected.
    expect(core.store.snapshot().inbox.map((row) => row.consumer)).toEqual([MARKET_EVENTS_CONSUMER, TRADE_EVENTS_CONSUMER, TRADE_EVENTS_CONSUMER]);

    // A repeat is a duplicate and does not warn again.
    expect(await consume(core, later)).toBe("duplicate");
    expect(core.logger.lines.filter((line) => line.level === "warn")).toHaveLength(2);
  });

  it("provisions the schema of a tenant it has not seen (ensureTenant), never answering tenant-not-ready", async () => {
    const core = createCore();
    expect(await core.store.forTenant(TENANT_B)).toBeNull();
    expect(await consume(core, marketOpenedBody({ tenantId: TENANT_B, marketId: MARKET_1 }))).toBe("applied");
    expect(await core.store.forTenant(TENANT_B)).not.toBeNull();
    expect(await core.store.forTenant(TENANT_A)).toBeNull();
    expect(await core.getMarket.execute({ actor: actor("trader-b", "trader", TENANT_B), marketId: MARKET_1 })).toMatchObject({ marketId: MARKET_1 });
  });

  it("keeps tenants apart: the same market id in two tenants has two histories", async () => {
    const core = createCore();
    await consumeAll(core, [
      marketOpenedBody({ marketId: MARKET_1, question: "Tenant A's market?" }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, costMicro: 1_000_000 }),
      marketOpenedBody({ tenantId: TENANT_B, marketId: MARKET_1, question: "Tenant B's market?" }),
      tradeExecutedBody({ tenantId: TENANT_B, marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 700_000, costMicro: 2_000_000 }),
      tradeExecutedBody({ tenantId: TENANT_B, marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 710_000, costMicro: 3_000_000 }),
    ]);
    const asB = actor("trader-b", "trader", TENANT_B);
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ question: "Tenant A's market?", tradeCount: 1, volumeMicro: 1_000_000, lastPriceYesMicro: 450_000 });
    expect(await core.getMarket.execute({ actor: asB, marketId: MARKET_1 })).toMatchObject({ question: "Tenant B's market?", tradeCount: 2, volumeMicro: 5_000_000, lastPriceYesMicro: 710_000 });
    // A market that only tenant B has is not found by tenant A.
    await consume(core, marketOpenedBody({ tenantId: TENANT_B, marketId: MARKET_2 }));
    await expect(core.getMarket.execute({ actor: trader, marketId: MARKET_2 })).rejects.toBeInstanceOf(NotFound);
    expect((await core.listMarkets.execute({ actor: trader })).items.map((item) => item.marketId)).toEqual([MARKET_1]);
    expect((await core.listMarkets.execute({ actor: asB })).items.map((item) => item.marketId)).toEqual([MARKET_2, MARKET_1]);
  });

  it("serves a market only after its MarketOpened: a trade that arrives first waits, then the market is complete", async () => {
    const core = createCore();
    await consume(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, costMicro: 10_000_000 }));
    await expect(core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).rejects.toBeInstanceOf(NotFound);
    expect((await core.listMarkets.execute({ actor: trader })).items).toEqual([]);

    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ status: "open", tradeCount: 1, volumeMicro: 10_000_000, lastPriceYesMicro: 450_000, currentPriceYesMicro: 450_000 });
  });

  it("never rolls a market back: an older version fills missing facts but not the status, the version or the outcome", async () => {
    const core = createCore();
    // Resolved (3) first, then closed (2), then opened (1): the order of arrival is the reverse of the order of events.
    await consumeAll(core, [marketResolvedBody({ marketId: MARKET_1, version: 3, outcome: "NO", resolvedAt: at(700) }), marketClosedBody({ marketId: MARKET_1, version: 2, closedAt: at(600) }), marketOpenedBody({ marketId: MARKET_1, version: 1 })]);
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ status: "resolved", version: 3, outcome: "NO", closedAt: at(600), resolvedAt: at(700), currentPriceYesMicro: 0 });

    // A late MarketClosed does not undo a resolution, and a repeated MarketResolved changes nothing.
    expect(await consume(core, marketClosedBody({ marketId: MARKET_1, version: 2, closedAt: at(1) }))).toBe("stale");
    expect(await consume(core, marketResolvedBody({ marketId: MARKET_1, version: 3, outcome: "YES" }))).toBe("stale");
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ outcome: "NO", closedAt: at(600) });
  });

  it("keeps the highest sequence's price whatever the order of the trades, and counts every point once", async () => {
    const core = createCore();
    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    await consumeAll(core, [
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 3, yesPriceMicro: 500_000, costMicro: 3_000_000 }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, costMicro: 1_000_000 }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 480_000, costMicro: 2_000_000 }),
    ]);
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ lastPriceYesMicro: 500_000, lastTradeSequence: 3, tradeCount: 3, volumeMicro: 6_000_000 });
    // A repeat of sequence 3 under a new event id and with another price is ignored.
    expect(await consume(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 3, yesPriceMicro: 990_000, costMicro: 7_000_000 }))).toBe("stale");
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ lastPriceYesMicro: 500_000, tradeCount: 3, volumeMicro: 6_000_000 });
    expect(stateOf(core, 1).points.size).toBe(4);
  });

  it("gives the same projection in every order of the same events (the rules commute)", async () => {
    const events = [
      marketOpenedBody({ marketId: MARKET_1, id: "00000000-0000-7000-8000-00000000a001" }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, costMicro: 1_000_000, id: "00000000-0000-7000-8000-00000000a002" }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 480_000, costMicro: 2_000_000, id: "00000000-0000-7000-8000-00000000a003" }),
      marketClosedBody({ marketId: MARKET_1, id: "00000000-0000-7000-8000-00000000a004" }),
      marketResolvedBody({ marketId: MARKET_1, id: "00000000-0000-7000-8000-00000000a005" }),
    ];
    const permutations = (items: number[]): number[][] => (items.length <= 1 ? [items] : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])));
    const orders = permutations([0, 1, 2, 3, 4]);
    expect(orders).toHaveLength(120);
    const expected = foldBodies(events);
    for (const order of orders) {
      const core = createCore();
      await consumeAll(core, order.map((index) => events[index]!));
      const state = stateOf(core, 1);
      expect([...state.summaries.values()].map((row) => ({ ...row, updatedAt: T0 }))).toEqual([...expected.summaries.values()].map((row) => ({ ...row, updatedAt: T0 })));
      expect(state.points.size).toBe(expected.points.size);
      expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ status: "resolved", version: 3, tradeCount: 2, volumeMicro: 3_000_000, lastPriceYesMicro: 480_000 });
    }
  });

  it("rolls everything back when a step fails, so the redelivery starts clean (the position is used up)", async () => {
    const core = createCore();
    const opened = marketOpenedBody({ marketId: MARKET_1 });
    core.store.hooks.onOperation = (operation) => {
      if (operation === "projections.insertSummary") throw new Error("deadlock detected");
    };
    await expect(consume(core, opened)).rejects.toThrow("deadlock detected");
    const failed = core.store.snapshot();
    expect(failed.inbox).toEqual([]);
    expect(failed.tenantData[TENANT_A]?.consumedEvents).toEqual([]);
    expect(failed.tenantData[TENANT_A]?.versions[1]).toEqual({ summaries: [], points: [] });
    expect(core.logger.lines).toEqual([]);

    core.store.hooks.onOperation = undefined;
    expect(await consume(core, opened)).toBe("applied");
    expect(core.store.snapshot().tenantData[TENANT_A]?.consumedEvents.map((row) => row.position)).toEqual([2]);
  });

  it("writes the active version only while no replay builds one", async () => {
    const core = createCore();
    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    expect(Object.keys(core.store.snapshot().tenantData[TENANT_A]?.versions ?? {})).toEqual(["1"]);
    expect(activeVersionOf(core)).toBe(1);
  });
});
