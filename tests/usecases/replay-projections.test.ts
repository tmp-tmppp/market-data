import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Consumed from "../../src/domain/consumed.js";
import { MAX_REPLAY_BATCH_SIZE, REPLAY_BATCH_TIME_BUDGET_MS } from "../../src/usecases/support.js";
import { TenantNotReady, UseCaseError, ValidationFailed } from "../../src/usecases/errors.js";
import type { ReplayReport } from "../../src/usecases/use-cases.js";
import { MARKET_1, MARKET_2, MARKET_3, T0, TENANT_A, TENANT_B, actor, at, marketClosedBody, marketOpenedBody, tradeExecutedBody } from "../support/fakes.js";
import { checkpointsOf, consume, consumeAll, createCore, expectActiveEquals, provision, rowCount, stateOf } from "./core.js";
import type { Core } from "./core.js";

// A deployed reader fix, played in one place: while `readerFix.on` is set, a stored TradeExecuted.v2 reads as the v1 it
// carries the same fields as. Off (the default), the real reader runs, so every other test in this file is unaffected.
const readerFix = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/domain/consumed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Consumed>();
  return {
    ...actual,
    readProjectionEvent: (body: unknown) => {
      const fixed = readerFix.on && typeof body === "object" && body !== null && (body as Record<string, unknown>)["type"] === "si.chance.trading.TradeExecuted.v2";
      return actual.readProjectionEvent(fixed ? { ...(body as Record<string, unknown>), type: actual.TRADE_EXECUTED_TYPE } : body);
    },
  };
});
afterEach(() => {
  readerFix.on = false;
});

const trader = actor();
const MARKET_4 = "018f3c1e-7a00-7000-8000-000000000104";

type Body = Record<string, unknown>;

/**
 * Eight consumed events (positions 1 to 8): market 1 opened with three trades, market 2 opened and closed, a MarketCreated
 * that nobody projects, and a trade of market 3 whose MarketOpened never came. Seven are projection events; in version 1
 * that makes 3 summaries and 6 points (9 rows).
 */
function standardBodies(): Body[] {
  return [
    marketOpenedBody({ marketId: MARKET_1 }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, costMicro: 10_000_000 }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 480_000, costMicro: 5_000_000 }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 3, yesPriceMicro: 500_000, costMicro: 1_000_000 }),
    marketOpenedBody({ marketId: MARKET_2, question: "Will the second market close?" }),
    marketClosedBody({ marketId: MARKET_2 }),
    { ...marketOpenedBody({ marketId: MARKET_1 }), type: "si.chance.markets.MarketCreated.v1" },
    tradeExecutedBody({ marketId: MARKET_3, tradeSequence: 1, yesPriceMicro: 500_000 }),
  ];
}

async function standardCore(): Promise<{ core: Core; bodies: Body[] }> {
  const core = createCore();
  const bodies = standardBodies();
  await consumeAll(core, bodies);
  return { core, bodies };
}

/** A trade of market 1 that arrives while a replay runs (a live event). */
const liveTrade = (sequence: number): Body => tradeExecutedBody({ marketId: MARKET_1, tradeSequence: sequence, yesPriceMicro: 520_000, costMicro: 2_000_000, executedAt: at(30 + sequence) });

const failure = async (promise: Promise<unknown>): Promise<UseCaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UseCaseError) return error;
    throw error;
  }
  throw new Error("The call did not fail");
};

const versionsOf = (core: Core, tenantId: string = TENANT_A) => checkpointsOf(core, tenantId).map((row) => [row.version, row.state]);

describe("ReplayProjections: the rebuild (DM-09, ADR-032, REQ-12)", () => {
  it("rebuilds into version 2, switches, empties version 1 and reports what it did", async () => {
    const { core, bodies } = await standardCore();
    expect(rowCount(core, 1)).toBe(9);
    core.clock.advanceMs(10 * 60_000);

    const report = await core.replay.execute({ tenantId: TENANT_A });

    expect(report).toEqual<ReplayReport>({
      tenantId: TENANT_A,
      outcome: "switched",
      resumed: false,
      rescanned: false,
      fromVersion: 1,
      toVersion: 2,
      highWaterPosition: 8,
      eventsApplied: 7,
      eventsNotProjected: 1,
      eventsUnreadable: 0,
      summaries: 3,
      points: 6,
      differences: [],
      retiredRowsDeleted: 9,
      startedAt: at(10),
      switchedAt: at(10),
    });
    expect(checkpointsOf(core)).toEqual([
      { version: 1, state: "retired", highWaterPosition: null, rebuiltThrough: 0, unreadableEvents: 0, createdAt: T0, activatedAt: T0, retiredAt: at(10) },
      { version: 2, state: "active", highWaterPosition: 8, rebuiltThrough: 8, unreadableEvents: 0, createdAt: at(10), activatedAt: at(10), retiredAt: null },
    ]);
    expect(rowCount(core, 1)).toBe(0);
    expectActiveEquals(core, bodies);
    // Reads now come from version 2, with the same answers.
    expect((await core.listMarkets.execute({ actor: trader })).items.map((item) => item.marketId)).toEqual([MARKET_2, MARKET_1]);
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ tradeCount: 3, volumeMicro: 16_000_000, lastPriceYesMicro: 500_000 });
    expect(core.logger.messages("info")).toContain("Projection replay switched");
  });

  it("keeps the old rows with keepOld, and the next run deletes every retired version's rows before and after its own switch", async () => {
    const { core, bodies } = await standardCore();

    const first = await core.replay.execute({ tenantId: TENANT_A, keepOld: true });
    expect(first).toMatchObject({ outcome: "switched", fromVersion: 1, toVersion: 2, retiredRowsDeleted: 0 });
    expect(rowCount(core, 1)).toBe(9);
    const second = await core.replay.execute({ tenantId: TENANT_A, keepOld: true });
    expect(second).toMatchObject({ outcome: "switched", fromVersion: 2, toVersion: 3, retiredRowsDeleted: 0 });
    expect([1, 2, 3].map((version) => rowCount(core, version))).toEqual([9, 9, 9]);

    // Version 1 and 2 are both retired and still full (an interrupted cleanup looks the same): the next run empties both,
    // builds version 4, and after its switch deletes version 3 too.
    const third = await core.replay.execute({ tenantId: TENANT_A });
    expect(third).toMatchObject({ outcome: "switched", fromVersion: 3, toVersion: 4, retiredRowsDeleted: 27 });
    expect([1, 2, 3, 4].map((version) => rowCount(core, version))).toEqual([0, 0, 0, 9]);
    expect(versionsOf(core)).toEqual([[1, "retired"], [2, "retired"], [3, "retired"], [4, "active"]]);
    expectActiveEquals(core, bodies);
  });

  it("rebuilds an empty tenant into an empty version", async () => {
    const core = createCore();
    await provision(core);
    const report = await core.replay.execute({ tenantId: TENANT_A });
    expect(report).toMatchObject({ outcome: "switched", highWaterPosition: 0, eventsApplied: 0, summaries: 0, points: 0, differences: [] });
    expect(versionsOf(core)).toEqual([[1, "retired"], [2, "active"]]);
  });

  it("refuses a bad batch size or tenant id with a field error, and an unknown tenant with tenant-not-ready", async () => {
    const { core } = await standardCore();
    for (const batchSize of [0, MAX_REPLAY_BATCH_SIZE + 1, 1.5, -1]) {
      const error = await failure(core.replay.execute({ tenantId: TENANT_A, batchSize }));
      expect(error).toBeInstanceOf(ValidationFailed);
      expect(error.fields[0]?.field).toBe("batchSize");
    }
    const bad = await failure(core.replay.execute({ tenantId: "not-a-tenant" }));
    expect(bad).toBeInstanceOf(ValidationFailed);
    expect(bad.fields[0]?.field).toBe("tenantId");
    await expect(core.replay.execute({ tenantId: TENANT_B })).rejects.toBeInstanceOf(TenantNotReady);
    // Nothing was started by any of them.
    expect(versionsOf(core)).toEqual([[1, "active"]]);
    expect((await core.replay.execute({ tenantId: TENANT_A, batchSize: MAX_REPLAY_BATCH_SIZE })).outcome).toBe("switched");
  });

  it("rebuilds one tenant only: another tenant's rows, versions and events are untouched", async () => {
    const { core, bodies } = await standardCore();
    await consumeAll(core, [
      marketOpenedBody({ tenantId: TENANT_B, marketId: MARKET_1, question: "Tenant B's market?" }),
      tradeExecutedBody({ tenantId: TENANT_B, marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 700_000, costMicro: 3_000_000 }),
    ]);
    const before = core.store.snapshot().tenantData[TENANT_B];

    await core.replay.execute({ tenantId: TENANT_A });

    expect(core.store.snapshot().tenantData[TENANT_B]).toEqual(before);
    expect(versionsOf(core, TENANT_B)).toEqual([[1, "active"]]);
    expectActiveEquals(core, bodies, TENANT_A);
    // Tenant A's market 1 has tenant A's three trades, not tenant B's one.
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ tradeCount: 3 });
    expect(await core.getMarket.execute({ actor: actor("trader-b", "trader", TENANT_B), marketId: MARKET_1 })).toMatchObject({ tradeCount: 1, question: "Tenant B's market?" });
    // Tenant B can be rebuilt on its own afterwards.
    expect((await core.replay.execute({ tenantId: TENANT_B })).eventsApplied).toBe(2);
  });
});

describe("ReplayProjections: batches, resume and the time budget", () => {
  it("applies the rows in batches of the given size, each batch advancing the checkpoint to its last row", async () => {
    const { core, bodies } = await standardCore();
    const advances: string[] = [];
    core.store.hooks.onOperation = (operation) => {
      if (operation === "checkpoints.advance") advances.push(operation);
    };
    const report = await core.replay.execute({ tenantId: TENANT_A, batchSize: 3 });
    // 8 rows in batches of 3, 3 and 2.
    expect(advances).toHaveLength(3);
    expect(report).toMatchObject({ outcome: "switched", eventsApplied: 7, eventsNotProjected: 1 });
    expectActiveEquals(core, bodies);
  });

  it("ends a batch at the time budget, after the row in progress, and continues in the next batch", async () => {
    const { core, bodies } = await standardCore();
    let advances = 0;
    core.store.hooks.onOperation = (operation) => {
      // The batch's clock runs a whole budget while it reads: every batch can finish one row only.
      if (operation === "consumedEvents.read") core.clock.advanceMs(REPLAY_BATCH_TIME_BUDGET_MS);
      if (operation === "checkpoints.advance") advances += 1;
    };
    const report = await core.replay.execute({ tenantId: TENANT_A });
    expect(advances).toBe(8);
    expect(report).toMatchObject({ outcome: "switched", eventsApplied: 7, eventsNotProjected: 1, highWaterPosition: 8 });
    expectActiveEquals(core, bodies);

    // Without a slow batch the default size takes all eight rows in one.
    const quick = await standardCore();
    let quickAdvances = 0;
    quick.core.store.hooks.onOperation = (operation) => {
      if (operation === "checkpoints.advance") quickAdvances += 1;
    };
    await quick.core.replay.execute({ tenantId: TENANT_A });
    expect(quickAdvances).toBe(1);
  });

  it("resumes a stopped replay at the last committed batch instead of starting again", async () => {
    const { core, bodies } = await standardCore();
    let advances = 0;
    core.store.hooks.onOperation = (operation) => {
      if (operation === "checkpoints.advance") {
        advances += 1;
        if (advances === 3) throw new Error("the process was stopped");
      }
    };
    await expect(core.replay.execute({ tenantId: TENANT_A, batchSize: 1 })).rejects.toThrow("the process was stopped");
    // Two batches committed; the third rolled back with its rows. Version 1 is still the active one.
    expect(checkpointsOf(core).map((row) => [row.version, row.state, row.rebuiltThrough])).toEqual([[1, "active", 0], [2, "building", 2]]);
    expect(stateOf(core, 2).points.size).toBe(2);

    core.store.hooks.onOperation = undefined;
    const report = await core.replay.execute({ tenantId: TENANT_A, batchSize: 1 });
    // Rows 3 to 8 are this run's: five projection events and the MarketCreated.
    // A build without unreadable rows is continued, never read again: `rescanned` is false.
    expect(report).toMatchObject({ outcome: "switched", resumed: true, rescanned: false, fromVersion: 1, toVersion: 2, highWaterPosition: 8, eventsApplied: 5, eventsNotProjected: 1, differences: [] });
    expectActiveEquals(core, bodies);
    expect(versionsOf(core)).toEqual([[1, "retired"], [2, "active"]]);
  });

  it("changes no count when the positions have gaps (a rolled-back transaction, burned values)", async () => {
    const core = createCore();
    const opened = marketOpenedBody({ marketId: MARKET_1 });
    const trade1 = tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000 });
    const trade2 = tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 460_000 });
    const closed = marketClosedBody({ marketId: MARKET_1 });
    await consume(core, opened);
    core.store.burnPositions(TENANT_A, 3);
    await consume(core, trade1);
    // A transaction that fails after its append uses a position up and stores nothing.
    core.store.hooks.onOperation = (operation) => {
      if (operation === "projections.insertPoint") throw new Error("deadlock detected");
    };
    await expect(consume(core, trade2)).rejects.toThrow("deadlock detected");
    core.store.hooks.onOperation = undefined;
    await consume(core, trade2);
    core.store.burnPositions(TENANT_A, 2);
    await consume(core, closed);
    // Burned values after the last row are not rows.
    core.store.burnPositions(TENANT_A, 5);
    expect(core.store.snapshot().tenantData[TENANT_A]?.consumedEvents.map((row) => row.position)).toEqual([1, 5, 7, 10]);

    const report = await core.replay.execute({ tenantId: TENANT_A, batchSize: 2 });
    expect(report).toMatchObject({ outcome: "switched", highWaterPosition: 10, eventsApplied: 4, eventsNotProjected: 0, eventsUnreadable: 0, differences: [] });
    expect(checkpointsOf(core)[1]).toMatchObject({ state: "active", highWaterPosition: 10, rebuiltThrough: 10 });
    expectActiveEquals(core, [opened, trade1, trade2, closed]);
  });
});

describe("ReplayProjections: a replay racing live events (ADR-058)", () => {
  it("writes a live event recorded between two batches to the active and the building version, and loses none", async () => {
    const { core, bodies } = await standardCore();
    const live = [liveTrade(4), marketOpenedBody({ marketId: MARKET_4, question: "A market opened during the replay?" })];
    const afterLive: Array<{ active: number; building: number }> = [];
    const seen: number[] = [];
    let next = 0;
    core.store.hooks.afterCommit = async ({ operations }) => {
      // Every commit of the replay: what a reader sees (the active version) and what the building version holds.
      const market = await core.getMarket.execute({ actor: trader, marketId: MARKET_1 });
      seen.push(market.tradeCount);
      if ((operations.includes("checkpoints.startBuilding") || operations.includes("checkpoints.advance")) && next < live.length) {
        expect(await consume(core, live[next]!)).toBe("applied");
        next += 1;
        if (next === 1) {
          const data = core.store.snapshot().tenantData[TENANT_A];
          afterLive.push({ active: data?.versions[1]?.points.filter((point) => point.marketId === MARKET_1).length ?? 0, building: data?.versions[2]?.points.filter((point) => point.marketId === MARKET_1).length ?? 0 });
        }
      }
    };

    const report = await core.replay.execute({ tenantId: TENANT_A, batchSize: 2 });
    core.store.hooks.afterCommit = undefined;

    expect(next).toBe(2);
    // The first live trade came right after the start: version 1 had 4 points of market 1 (opening and 3 trades) plus the
    // live one; the building version held only the live one so far, and readers never saw it.
    expect(afterLive).toEqual([{ active: 5, building: 1 }]);
    // Rows above the high water mark are the live consumer's: the report counts rows 1 to 8 only.
    expect(report).toMatchObject({ outcome: "switched", highWaterPosition: 8, eventsApplied: 7, eventsNotProjected: 1, differences: [] });
    expect(checkpointsOf(core)[1]).toMatchObject({ state: "active", highWaterPosition: 8, rebuiltThrough: 8 });
    expect(core.store.snapshot().tenantData[TENANT_A]?.consumedEvents.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expectActiveEquals(core, [...bodies, ...live]);
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ tradeCount: 4, lastTradeSequence: 4 });
    expect((await core.listMarkets.execute({ actor: trader })).items.map((item) => item.marketId)).toEqual([MARKET_4, MARKET_2, MARKET_1]);
    expect(rowCount(core, 1)).toBe(0);
    // Readers never saw a half-built version: the trade count of market 1 is 3 before the live trade, 4 after it, never less.
    expect(seen.length).toBeGreaterThan(8);
    expect(seen.every((count, index) => count >= 3 && (index === 0 || count >= (seen[index - 1] ?? 0)))).toBe(true);
    expect(seen.at(-1)).toBe(4);
  });

  it("answers every read from version 1 while version 2 is half built, and from version 2 right after the switch", async () => {
    const { core } = await standardCore();
    const building: number[] = [];
    const served: number[] = [];
    core.store.hooks.afterCommit = async () => {
      const market = await core.getMarket.execute({ actor: trader, marketId: MARKET_1 });
      served.push(market.tradeCount);
      const version2 = core.store.snapshot().tenantData[TENANT_A]?.versions[2]?.summaries.find((row) => row.marketId === MARKET_1);
      if (version2 !== undefined) building.push(version2.tradeCount);
    };

    await core.replay.execute({ tenantId: TENANT_A, batchSize: 1 });
    core.store.hooks.afterCommit = undefined;

    expect(served.length).toBeGreaterThan(8);
    expect(served.every((count) => count === 3)).toBe(true);
    // Version 2 passed through 0, 1, 2 and 3 trades of market 1 while that was served.
    expect(new Set(building)).toEqual(new Set([0, 1, 2, 3]));
    expect(served.at(-1)).toBe(3);
  });

  it("ends with finished_elsewhere when another run switched the version after this run created it", async () => {
    const { core, bodies } = await standardCore();
    let inner: ReplayReport | null = null;
    core.store.hooks.afterCommit = async ({ operations }) => {
      if (inner === null && operations.includes("checkpoints.startBuilding")) {
        // A second run of the same tenant starts right after the first created version 2: it resumes it and switches.
        core.store.hooks.afterCommit = undefined;
        inner = await core.replay.execute({ tenantId: TENANT_A });
      }
    };
    const outer = await core.replay.execute({ tenantId: TENANT_A });

    expect(inner).toMatchObject({ outcome: "switched", resumed: true, fromVersion: 1, toVersion: 2, eventsApplied: 7 });
    expect(outer).toMatchObject({ outcome: "finished_elsewhere", resumed: false, fromVersion: 1, toVersion: 2, eventsApplied: 0, switchedAt: null, differences: [] });
    expect(versionsOf(core)).toEqual([[1, "retired"], [2, "active"]]);
    expectActiveEquals(core, bodies);
  });

  it("ends with finished_elsewhere at the switch when the version was switched between the last batch and the switch", async () => {
    const { core, bodies } = await standardCore();
    let inner: ReplayReport | null = null;
    core.store.hooks.afterCommit = async ({ operations }) => {
      // The commit that only took the rebuild lock found the build complete; the other run switches before this one does.
      if (inner === null && operations.length === 1 && operations[0] === "checkpoints.lockForRebuild") {
        core.store.hooks.afterCommit = undefined;
        inner = await core.replay.execute({ tenantId: TENANT_A });
      }
    };
    const outer = await core.replay.execute({ tenantId: TENANT_A });

    expect(inner).toMatchObject({ outcome: "switched", resumed: true, eventsApplied: 0 });
    expect(outer).toMatchObject({ outcome: "finished_elsewhere", resumed: false, fromVersion: 1, toVersion: 2, eventsApplied: 7, eventsNotProjected: 1, switchedAt: null });
    expect(versionsOf(core)).toEqual([[1, "retired"], [2, "active"]]);
    expect(rowCount(core, 1)).toBe(0);
    expectActiveEquals(core, bodies);
  });

  it("stops writing as soon as its version is no longer building", async () => {
    const { core } = await standardCore();
    let forced = false;
    core.store.hooks.afterCommit = async ({ operations }) => {
      if (!forced && operations.includes("checkpoints.advance")) {
        forced = true;
        // Another run took the version over after this run's first batch.
        const tenant = await core.store.ensureTenant(TENANT_A, T0);
        await tenant.transaction((repositories) => repositories.checkpoints.activate(2, at(1)));
      }
    };
    const report = await core.replay.execute({ tenantId: TENANT_A, batchSize: 1 });
    core.store.hooks.afterCommit = undefined;

    expect(report).toMatchObject({ outcome: "finished_elsewhere", fromVersion: 1, toVersion: 2, eventsApplied: 1 });
    // Only the first row (the opening point and the summary of market 1) was written by this run.
    expect(rowCount(core, 2)).toBe(2);
  });

  it("lets two runs of one tenant started together share one building version: one switches, the other finishes elsewhere", async () => {
    const { core, bodies } = await standardCore();
    const reports = await Promise.all([core.replay.execute({ tenantId: TENANT_A }), core.replay.execute({ tenantId: TENANT_A })]);
    expect(reports.map((report) => report.outcome).sort()).toEqual(["finished_elsewhere", "switched"]);
    expect(reports.map((report) => report.resumed).sort()).toEqual([false, true]);
    // One version 2, not two builds: no version 3.
    expect(versionsOf(core)).toEqual([[1, "retired"], [2, "active"]]);
    expectActiveEquals(core, bodies);
  });
});

describe("ReplayProjections: unreadable rows hold the switch (ADR-058)", () => {
  /** The standard events plus a later type version and a trade with a price outside the contract, both stored live. */
  async function withUnreadable() {
    const { core, bodies } = await standardCore();
    const later = { ...tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 9, yesPriceMicro: 450_000 }), type: "si.chance.trading.TradeExecuted.v2" };
    const badPrice = tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 10, yesPriceMicro: 5 });
    expect(await consumeAll(core, [later, badPrice])).toEqual(["unprojected", "unprojected"]);
    return { core, bodies };
  }

  it("holds the switch: version 2 stays building, version 1 stays active and keeps its rows", async () => {
    const { core, bodies } = await withUnreadable();
    const report = await core.replay.execute({ tenantId: TENANT_A });

    expect(report).toMatchObject({ outcome: "held", resumed: false, fromVersion: 1, toVersion: 2, highWaterPosition: 10, eventsApplied: 7, eventsNotProjected: 1, eventsUnreadable: 2, summaries: 3, points: 6, differences: [], retiredRowsDeleted: 0, switchedAt: null });
    expect(checkpointsOf(core).map((row) => [row.version, row.state, row.rebuiltThrough, row.unreadableEvents])).toEqual([[1, "active", 0, 0], [2, "building", 10, 2]]);
    expect(rowCount(core, 1)).toBe(9);
    expect(rowCount(core, 2)).toBe(9);
    expectActiveEquals(core, bodies);
    expect((await core.listMarkets.execute({ actor: trader })).items).toHaveLength(2);
    expect(core.logger.messages("warn").filter((message) => message?.startsWith("Projection replay held"))).toHaveLength(1);
    // The replay names each row it could not read.
    expect(core.logger.lines.filter((line) => line.message === "A stored event could not be read by the replay")).toHaveLength(2);
  });

  it("a rerun without the flag reads the stored rows again from the start: it holds again only while the reader still cannot read them", async () => {
    const { core } = await withUnreadable();
    await core.replay.execute({ tenantId: TENANT_A });
    const again = await core.replay.execute({ tenantId: TENANT_A });
    // The counter starts again at 0 (2, not 4), the mark and the progress are those of the new read.
    expect(again).toMatchObject({ outcome: "held", resumed: true, rescanned: true, highWaterPosition: 10, eventsApplied: 7, eventsNotProjected: 1, eventsUnreadable: 2 });
    expect(checkpointsOf(core).map((row) => [row.version, row.state, row.rebuiltThrough, row.unreadableEvents])).toEqual([[1, "active", 0, 0], [2, "building", 10, 2]]);
  });

  it("recovers a held build after the reader is fixed: a rerun without the flag reads the stored row and switches with it (ADR-058)", async () => {
    const { core, bodies } = await standardCore();
    const later = { ...tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 9, yesPriceMicro: 450_000 }), type: "si.chance.trading.TradeExecuted.v2" };
    expect(await consume(core, later)).toBe("unprojected");
    expect(await core.replay.execute({ tenantId: TENANT_A })).toMatchObject({ outcome: "held", eventsUnreadable: 1 });

    readerFix.on = true;
    const fixed = await core.replay.execute({ tenantId: TENANT_A });

    // Version 1 never had trade 9 (its reader could not read it), so the comparison names the market.
    expect(fixed).toMatchObject({ outcome: "switched", resumed: true, rescanned: true, eventsApplied: 8, eventsUnreadable: 0, differences: [MARKET_1] });
    expect(versionsOf(core)).toEqual([[1, "retired"], [2, "active"]]);
    expectActiveEquals(core, [...bodies, later]);
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ tradeCount: 4, lastTradeSequence: 9 });
  });

  it("a rerun after the fix also reads a row that was stored live after the held build's high water mark", async () => {
    const { core, bodies } = await standardCore();
    const first = { ...tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 9, yesPriceMicro: 450_000 }), type: "si.chance.trading.TradeExecuted.v2" };
    await consume(core, first);
    expect(await core.replay.execute({ tenantId: TENANT_A })).toMatchObject({ outcome: "held", highWaterPosition: 9 });
    // Stored while held, unreadable: the live consumer does not count it in the checkpoint, so only a new mark finds it.
    const second = { ...tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 10, yesPriceMicro: 470_000 }), type: "si.chance.trading.TradeExecuted.v2" };
    expect(await consume(core, second)).toBe("unprojected");

    readerFix.on = true;
    const fixed = await core.replay.execute({ tenantId: TENANT_A });

    expect(fixed).toMatchObject({ outcome: "switched", rescanned: true, highWaterPosition: 10, eventsApplied: 9, eventsUnreadable: 0 });
    expectActiveEquals(core, [...bodies, first, second]);
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ tradeCount: 5, lastTradeSequence: 10 });
  });

  it("switches on a rerun with allowUnreadable after reading again, and a live event recorded while held is in the new version", async () => {
    const { core, bodies } = await withUnreadable();
    await core.replay.execute({ tenantId: TENANT_A });
    // While the switch is held the live consumer keeps writing both versions.
    const live = liveTrade(4);
    expect(await consume(core, live)).toBe("applied");
    const oldRows = rowCount(core, 1);

    const switched = await core.replay.execute({ tenantId: TENANT_A, allowUnreadable: true });
    expect(switched).toMatchObject({ outcome: "switched", resumed: true, rescanned: true, fromVersion: 1, toVersion: 2, highWaterPosition: 11, eventsApplied: 8, eventsNotProjected: 1, eventsUnreadable: 2, differences: [], retiredRowsDeleted: oldRows });
    expect(versionsOf(core)).toEqual([[1, "retired"], [2, "active"]]);
    expect(rowCount(core, 1)).toBe(0);
    expectActiveEquals(core, [...bodies, live]);
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ tradeCount: 4 });
  });

  it("switches in one run when allowUnreadable is given from the start", async () => {
    const { core } = await withUnreadable();
    const report = await core.replay.execute({ tenantId: TENANT_A, allowUnreadable: true });
    expect(report).toMatchObject({ outcome: "switched", eventsApplied: 7, eventsUnreadable: 2 });
    expect(versionsOf(core)).toEqual([[1, "retired"], [2, "active"]]);
  });

  it("finishes an interrupted cleanup at the start of a run, even when that run then holds", async () => {
    const { core } = await standardCore();
    await core.replay.execute({ tenantId: TENANT_A, keepOld: true });
    expect(rowCount(core, 1)).toBe(9);
    await consume(core, { ...tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 9, yesPriceMicro: 450_000 }), type: "si.chance.trading.TradeExecuted.v2" });

    const held = await core.replay.execute({ tenantId: TENANT_A });

    expect(held).toMatchObject({ outcome: "held", fromVersion: 2, toVersion: 3, retiredRowsDeleted: 9 });
    expect(rowCount(core, 1)).toBe(0);
    // The active version keeps its rows; the held one is built next to it.
    expect([rowCount(core, 2), rowCount(core, 3)]).toEqual([9, 9]);
  });

  it("does not hold for a row of another type, which is normal", async () => {
    const { core } = await standardCore();
    expect((await core.replay.execute({ tenantId: TENANT_A })).eventsNotProjected).toBe(1);
    expect(checkpointsOf(core)[1]?.state).toBe("active");
  });

  it("recovers a stored row that an older reader did not project: the replay applies it and reports the difference", async () => {
    const { core, bodies } = await standardCore();
    // A row the live consumer stored without projecting it (an earlier reader could not read it): valid for today's reader.
    const recovered = liveTrade(4);
    const tenant = await core.store.ensureTenant(TENANT_A, T0);
    await tenant.transaction((repositories) =>
      repositories.consumedEvents.append({ eventId: recovered["id"] as string, eventType: recovered["type"] as string, marketId: MARKET_1, event: recovered, receivedAt: T0 }),
    );

    const report = await core.replay.execute({ tenantId: TENANT_A });

    expect(report).toMatchObject({ outcome: "switched", eventsApplied: 8, eventsUnreadable: 0, highWaterPosition: 9, differences: [MARKET_1] });
    expectActiveEquals(core, [...bodies, recovered]);
    expect(await core.getMarket.execute({ actor: trader, marketId: MARKET_1 })).toMatchObject({ tradeCount: 4, lastTradeSequence: 4 });
    // With a difference the retired version is kept for comparison, and the next run deletes it.
    expect(rowCount(core, 1)).toBe(9);
    expect((await core.replay.execute({ tenantId: TENANT_A })).retiredRowsDeleted).toBeGreaterThanOrEqual(9 + 10);
    expect(rowCount(core, 1)).toBe(0);
  });
});

describe("ReplayProjections: the comparison of the two versions", () => {
  it("reports a market whose summary differs, switches anyway, and keeps the old version until the next run", async () => {
    const { core, bodies } = await standardCore();
    const tenant = await core.store.ensureTenant(TENANT_A, T0);
    const tampered = stateOf(core, 1).summaries.get(MARKET_1);
    if (!tampered) throw new Error("no summary");
    await tenant.transaction((repositories) => repositories.projections.updateSummary(1, { ...tampered, volumeMicro: tampered.volumeMicro + 1 }));

    const report = await core.replay.execute({ tenantId: TENANT_A });

    expect(report).toMatchObject({ outcome: "switched", differences: [MARKET_1], retiredRowsDeleted: 0 });
    expect(rowCount(core, 1)).toBe(9);
    expectActiveEquals(core, bodies);
    // The next run deletes the kept rows first.
    expect((await core.replay.execute({ tenantId: TENANT_A })).retiredRowsDeleted).toBe(18);
    expect(rowCount(core, 1)).toBe(0);
  });

  it("reports a market whose price points differ while the summaries agree", async () => {
    const { core } = await standardCore();
    const tenant = await core.store.ensureTenant(TENANT_A, T0);
    const point = stateOf(core, 1).points.get(`${MARKET_2}/0`);
    if (!point) throw new Error("no point");
    // A point only version 1 holds, on a market whose summary is identical in both versions.
    await tenant.transaction((repositories) => repositories.projections.insertPoint(1, { ...point, tradeSequence: 7, volumeMicro: 3 }));

    const report = await core.replay.execute({ tenantId: TENANT_A });

    expect(report.differences).toEqual([MARKET_2]);
    expect(report.outcome).toBe("switched");
  });

  it("finds no difference when a live version and a rebuilt one agree, whatever order the events arrived in", async () => {
    const core = createCore();
    // The events of one market in the order the streams might deliver them: resolved-state facts out of order, trades 3, 1, 2.
    const bodies = [
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 3, yesPriceMicro: 500_000, costMicro: 3_000_000 }),
      marketClosedBody({ marketId: MARKET_1 }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, costMicro: 1_000_000 }),
      marketOpenedBody({ marketId: MARKET_1 }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 480_000, costMicro: 2_000_000 }),
    ];
    await consumeAll(core, bodies);
    const report = await core.replay.execute({ tenantId: TENANT_A, batchSize: 2 });
    expect(report).toMatchObject({ outcome: "switched", differences: [], eventsApplied: 5, summaries: 1, points: 4 });
    expectActiveEquals(core, bodies);
  });
});
