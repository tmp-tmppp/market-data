import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { bucketize } from "../../src/domain/history.js";
import { emptySummary } from "../../src/domain/projection.js";
import type { MarketSummary, PricePoint, ProjectionState } from "../../src/domain/projection.js";
import type { ConsumedEventRecord, TenantStore } from "../../src/usecases/ports.js";
import { foldBodies } from "../usecases/core.js";
import { MARKET_1, MARKET_2, MARKET_3, RecordingLogger, T0, TENANT_A, TENANT_B, at, marketClosedBody, marketOpenedBody, tradeExecutedBody } from "../support/fakes.js";

const NOW = at(5);

async function tenantOf(store: MemoryStore, tenantId: string = TENANT_A): Promise<TenantStore> {
  return store.ensureTenant(tenantId, NOW);
}

const record = (eventId: string, eventType = "si.chance.markets.MarketCreated.v1"): Omit<ConsumedEventRecord, "position"> => ({ eventId, eventType, marketId: null, event: { id: eventId }, receivedAt: NOW });

/** Loads the rows a fold produced into a version, points first as the use case does. */
async function load(tenant: TenantStore, version: number, state: ProjectionState): Promise<void> {
  await tenant.transaction(async (repositories) => {
    for (const point of state.points.values()) await repositories.projections.insertPoint(version, point);
    for (const summary of state.summaries.values()) await repositories.projections.insertSummary(version, summary);
  });
}

/** Three markets: 1 listed with trades, 2 listed and closed, 3 only seen through a trade (not listed). */
function threeMarkets(): ProjectionState {
  return foldBodies([
    marketOpenedBody({ marketId: MARKET_1 }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000 }),
    marketOpenedBody({ marketId: MARKET_2, question: "Will the second market close?" }),
    marketClosedBody({ marketId: MARKET_2 }),
    tradeExecutedBody({ marketId: MARKET_3, tradeSequence: 1, yesPriceMicro: 500_000 }),
  ]);
}

describe("tenants and the registry", () => {
  it("creates projection version 1 as active for a new tenant, as the migration does", async () => {
    const store = new MemoryStore();
    expect(await store.forTenant(TENANT_A)).toBeNull();
    await tenantOf(store);
    expect(await store.forTenant(TENANT_A)).not.toBeNull();
    expect(store.snapshot().tenantData[TENANT_A]?.checkpoints).toEqual([
      { version: 1, state: "active", highWaterPosition: null, rebuiltThrough: 0, unreadableEvents: 0, createdAt: NOW, activatedAt: NOW, retiredAt: null },
    ]);
    expect(store.snapshot().tenantData[TENANT_A]?.versions[1]).toEqual({ summaries: [], points: [] });
    await store.ping();
  });

  it("lists registered tenants sorted, and registers one tenant once", async () => {
    const store = new MemoryStore();
    await store.transaction(async (repositories) => {
      await repositories.tenants.provision(TENANT_B, NOW);
      await repositories.tenants.provision(TENANT_A, NOW);
      await repositories.tenants.provision(TENANT_A, at(9));
    });
    expect(await store.repositories.tenants.list()).toEqual([TENANT_A, TENANT_B]);
    expect(await store.repositories.tenants.isRegistered(TENANT_B)).toBe(true);
    expect(await store.repositories.tenants.isRegistered("018f3c1e-7a00-7000-8000-0000000000cc")).toBe(false);
    // The second provision of tenant A did not recreate its schema.
    expect(store.snapshot().tenantData[TENANT_A]?.checkpoints[0]?.createdAt).toEqual(NOW);
  });

  it("provisions an unknown tenant on first use only with autoProvision (local mode)", async () => {
    const logger = new RecordingLogger();
    const store = new MemoryStore({ autoProvision: true, logger });
    expect(await store.forTenant(TENANT_A)).not.toBeNull();
    expect(await store.forTenant(TENANT_A)).not.toBeNull();
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: "info", fields: { tenantId: TENANT_A } });
    expect(await new MemoryStore().forTenant(TENANT_A)).toBeNull();
  });

  it("keeps one tenant's data invisible to another", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store, TENANT_A);
    const b = await tenantOf(store, TENANT_B);
    await load(a, 1, threeMarkets());
    await a.transaction((repositories) => repositories.consumedEvents.append(record("e1")));
    expect(await a.repositories.readModel.summary(MARKET_1)).not.toBeNull();
    expect(await b.repositories.readModel.summary(MARKET_1)).toBeNull();
    expect(await b.repositories.readModel.listSummaries({ status: null, beforeId: null, limit: 10 })).toEqual([]);
    expect(await b.repositories.consumedEvents.read(0, 100, 10)).toEqual([]);
    expect((await b.repositories.projections.exportVersion(1)).summaries).toEqual([]);
  });
});

describe("consumed_events", () => {
  it("numbers the rows 1, 2, 3, refuses a stored event id and checks the type's length", async () => {
    const tenant = await tenantOf(new MemoryStore());
    const append = (eventId: string) => tenant.transaction((repositories) => repositories.consumedEvents.append(record(eventId)));
    expect(await append("e1")).toBe(1);
    expect(await append("e2")).toBe(2);
    expect(await append("e1")).toBeNull();
    expect(await append("e3")).toBe(3);
    await expect(tenant.transaction((repositories) => repositories.consumedEvents.append(record("e4", "")))).rejects.toThrow(/event_type/);
    await expect(tenant.transaction((repositories) => repositories.consumedEvents.append(record("e4", "t".repeat(201))))).rejects.toThrow(/event_type/);
    expect((await tenant.repositories.consumedEvents.read(0, 10, 10)).map((row) => row.position)).toEqual([1, 2, 3]);
  });

  it("reads rows after one position and through another, at most `limit`, as copies", async () => {
    const tenant = await tenantOf(new MemoryStore());
    for (const id of ["e1", "e2", "e3", "e4"]) await tenant.transaction((repositories) => repositories.consumedEvents.append(record(id)));
    const rows = await tenant.repositories.consumedEvents.read(1, 4, 2);
    expect(rows.map((row) => row.eventId)).toEqual(["e2", "e3"]);
    expect((await tenant.repositories.consumedEvents.read(2, 3, 10)).map((row) => row.position)).toEqual([3]);
    rows[0]!.event["id"] = "changed";
    expect((await tenant.repositories.consumedEvents.read(1, 4, 1))[0]?.event).toEqual({ id: "e2" });
  });

  it("stores a copy of the event, so a later change of the caller's object changes nothing stored", async () => {
    const tenant = await tenantOf(new MemoryStore());
    const raw = { id: "e1", data: { n: 1 } };
    await tenant.transaction((repositories) => repositories.consumedEvents.append({ ...record("e1"), event: raw }));
    raw.data.n = 2;
    expect((await tenant.repositories.consumedEvents.read(0, 5, 5))[0]?.event).toEqual({ id: "e1", data: { n: 1 } });
  });

  it("uses a position up when the transaction fails, and on request: positions have gaps", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    const append = (eventId: string) => tenant.transaction((repositories) => repositories.consumedEvents.append(record(eventId)));
    expect(await append("e1")).toBe(1);
    await expect(
      tenant.transaction(async (repositories) => {
        await repositories.consumedEvents.append(record("e2"));
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect((await tenant.repositories.consumedEvents.read(0, 10, 10)).map((row) => row.eventId)).toEqual(["e1"]);
    expect(await append("e2")).toBe(3);
    store.burnPositions(TENANT_A, 4);
    expect(await append("e3")).toBe(8);
    // A different tenant counts on its own.
    const other = await tenantOf(store, TENANT_B);
    expect(await other.transaction((repositories) => repositories.consumedEvents.append(record("e9")))).toBe(1);
  });
});

describe("projection versions", () => {
  it("starts a building version with the highest position as its high water mark and resumes it", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    const start = () => tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(10)));
    // An empty tenant: high water mark 0.
    const first = await start();
    expect(first.resumed).toBe(false);
    expect(first.rescanned).toBe(false);
    expect(first.checkpoint).toEqual({ version: 2, state: "building", highWaterPosition: 0, rebuiltThrough: 0, unreadableEvents: 0, createdAt: at(10), activatedAt: null, retiredAt: null });
    expect(await start()).toEqual({ checkpoint: first.checkpoint, resumed: true, rescanned: false });
    expect(await tenant.repositories.checkpoints.list()).toHaveLength(2);
  });

  it("resumes a clean building version where it stopped, but restarts one that met unreadable rows with a new high water mark", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    const checkpoints = tenant.repositories.checkpoints;
    await tenant.transaction((repositories) => repositories.consumedEvents.append(record("e1")));
    await tenant.transaction((repositories) => repositories.consumedEvents.append(record("e2")));
    await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(10)));
    await tenant.transaction((repositories) => repositories.checkpoints.advance(2, 1, 0));
    // No unreadable row: the build continues at its progress.
    const clean = await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(11)));
    expect(clean).toMatchObject({ resumed: true, rescanned: false, checkpoint: { highWaterPosition: 2, rebuiltThrough: 1, unreadableEvents: 0 } });

    // An unreadable row taints the build: the next start reads everything again, up to the highest position now.
    await tenant.transaction((repositories) => repositories.checkpoints.advance(2, 2, 1));
    await tenant.transaction((repositories) => repositories.consumedEvents.append(record("e3")));
    store.burnPositions(TENANT_A, 2);
    await tenant.transaction((repositories) => repositories.consumedEvents.append(record("e4")));
    const rescanned = await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(12)));
    expect(rescanned).toMatchObject({ resumed: true, rescanned: true, checkpoint: { version: 2, state: "building", highWaterPosition: 6, rebuiltThrough: 0, unreadableEvents: 0, createdAt: at(10) } });
    expect(await checkpoints.list()).toHaveLength(2);
    // The restart is a single event: the next start finds a clean build again.
    expect((await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(13)))).rescanned).toBe(false);
  });

  it("takes the high water mark from the rows, not from a counter: gaps in the positions", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    await tenant.transaction((repositories) => repositories.consumedEvents.append(record("e1")));
    store.burnPositions(TENANT_A, 5);
    await tenant.transaction((repositories) => repositories.consumedEvents.append(record("e2")));
    const { checkpoint } = await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(10)));
    expect(checkpoint.highWaterPosition).toBe(7);
    store.burnPositions(TENANT_A, 3);
    // A row burned after the last one is not a row: a resumed run keeps its mark.
    expect((await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(11)))).checkpoint.highWaterPosition).toBe(7);
  });

  it("targets the active version and the building one; advance adds unreadable rows; activate swaps the two", async () => {
    const tenant = await tenantOf(new MemoryStore());
    const checkpoints = tenant.repositories.checkpoints;
    expect(await checkpoints.targets()).toEqual({ active: 1, building: null });
    await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(10)));
    expect(await checkpoints.targets()).toEqual({ active: 1, building: 2 });

    await tenant.transaction((repositories) => repositories.checkpoints.advance(2, 4, 1));
    await tenant.transaction((repositories) => repositories.checkpoints.advance(2, 9, 2));
    expect((await checkpoints.list())[1]).toMatchObject({ version: 2, state: "building", rebuiltThrough: 9, unreadableEvents: 3 });
    await expect(tenant.transaction((repositories) => repositories.checkpoints.advance(1, 4, 0))).rejects.toThrow(/not building/);
    await expect(tenant.transaction((repositories) => repositories.checkpoints.advance(7, 4, 0))).rejects.toThrow(/no checkpoint/);

    const retired = await tenant.transaction((repositories) => repositories.checkpoints.activate(2, at(20)));
    expect(retired).toBe(1);
    const rows = await checkpoints.list();
    expect(rows[0]).toMatchObject({ version: 1, state: "retired", retiredAt: at(20) });
    expect(rows[1]).toMatchObject({ version: 2, state: "active", activatedAt: at(20), retiredAt: null });
    expect(await checkpoints.targets()).toEqual({ active: 2, building: null });
    await expect(tenant.transaction((repositories) => repositories.checkpoints.activate(2, at(21)))).rejects.toThrow(/not building/);
  });

  it("returns every checkpoint, oldest first, when taking the rebuild lock", async () => {
    const tenant = await tenantOf(new MemoryStore());
    await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(10)));
    const rows = await tenant.transaction((repositories) => repositories.checkpoints.lockForRebuild());
    expect(rows.map((row) => [row.version, row.state])).toEqual([
      [1, "active"],
      [2, "building"],
    ]);
  });
});

describe("projection rows and their constraints", () => {
  async function seeded() {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    const state = threeMarkets();
    await load(tenant, 1, state);
    return { store, tenant, state, summary: state.summaries.get(MARKET_1) as MarketSummary, point: state.points.get(`${MARKET_1}/1`) as PricePoint };
  }

  it("finds, inserts once, updates and counts summaries and points", async () => {
    const { tenant, summary, point } = await seeded();
    const projections = tenant.repositories.projections;
    expect(await projections.findSummary(1, MARKET_1)).toEqual(summary);
    expect(await projections.findSummary(1, MARKET_1, { lock: true })).toEqual(summary);
    expect(await projections.findSummary(1, "018f3c1e-7a00-7000-8000-0000000000ff")).toBeNull();
    expect(await tenant.transaction((repositories) => repositories.projections.insertSummary(1, summary))).toBe(false);
    expect(await tenant.transaction((repositories) => repositories.projections.insertPoint(1, point))).toBe(false);
    expect(await projections.countVersion(1)).toEqual({ summaries: 3, points: 4 });

    await tenant.transaction((repositories) => repositories.projections.updateSummary(1, { ...summary, volumeMicro: summary.volumeMicro + 1 }));
    expect((await projections.findSummary(1, MARKET_1))?.volumeMicro).toBe(summary.volumeMicro + 1);
    await expect(tenant.transaction((repositories) => repositories.projections.updateSummary(1, emptySummary("018f3c1e-7a00-7000-8000-0000000000ff", NOW)))).rejects.toThrow(/no summary/);
  });

  it("returns copies of the rows", async () => {
    const { tenant, summary } = await seeded();
    const found = await tenant.repositories.projections.findSummary(1, MARKET_1);
    found!.volumeMicro = 1;
    expect((await tenant.repositories.projections.findSummary(1, MARKET_1))?.volumeMicro).toBe(summary.volumeMicro);
  });

  it("enforces the CHECKs of market_summaries", async () => {
    const { tenant, summary } = await seeded();
    const insert = (row: MarketSummary) => tenant.transaction((repositories) => repositories.projections.insertSummary(1, { ...row, marketId: "018f3c1e-7a00-7000-8000-0000000000ee" }));
    await expect(insert({ ...summary, version: 0 })).rejects.toThrow(/status is set exactly when/);
    await expect(insert({ ...summary, outcome: "YES" })).rejects.toThrow(/outcome/);
    await expect(insert({ ...summary, tradeCount: 0 })).rejects.toThrow(/last price/);
    await expect(insert({ ...summary, lastTradeAt: null })).rejects.toThrow(/last trade time/);
    await expect(insert({ ...summary, tradeCount: 5 })).rejects.toThrow(/cannot exceed/);
    await expect(insert({ ...summary, closeTime: null })).rejects.toThrow(/opening facts/);
    await expect(insert({ ...summary, question: "q".repeat(201) })).rejects.toThrow(/question/);
    await expect(insert({ ...summary, startingPriceYesMicro: 405_000 })).rejects.toThrow(/grid/);
    await expect(insert({ ...summary, lastPriceYesMicro: 5 })).rejects.toThrow(/last_price/);
    await expect(insert({ ...summary, volumeMicro: -1 })).rejects.toThrow(/volume/);
    await expect(insert({ ...summary, version: -1 })).rejects.toThrow(/market_version/);
    await expect(insert({ ...summary, status: "paused" as never })).rejects.toThrow(/status must be/);
    await expect(insert({ ...summary, lastTradeSequence: -1 })).rejects.toThrow(/last_trade_sequence/);
    // 200 astral characters are 200 characters (code points), not 400.
    await expect(insert({ ...summary, question: "\u{1F600}".repeat(200) })).resolves.toBe(true);
  });

  it("enforces the CHECKs of price_points and the version's foreign key", async () => {
    const { tenant, point } = await seeded();
    const insert = (row: PricePoint, version = 1) => tenant.transaction((repositories) => repositories.projections.insertPoint(version, row));
    await expect(insert({ ...point, tradeSequence: 9, priceYesMicro: 5 })).rejects.toThrow(/price_yes_micro/);
    await expect(insert({ ...point, tradeSequence: 9, volumeMicro: -1 })).rejects.toThrow(/volume/);
    await expect(insert({ ...point, tradeSequence: 0, volumeMicro: 1, marketId: MARKET_2 })).rejects.toThrow(/opening point/);
    await expect(insert({ ...point, tradeSequence: -1 })).rejects.toThrow(/trade_sequence/);
    await expect(insert(point, 9)).rejects.toThrow(/no checkpoint/);
    // The price of a trade needs no grid (trading's contract allows any integer of the range).
    await expect(insert({ ...point, tradeSequence: 9, priceYesMicro: 555_000 })).resolves.toBe(true);
  });

  it("checks a point's summary at the commit: after the point is fine, never is not", async () => {
    const { store, tenant, point } = await seeded();
    const orphan = { ...point, marketId: "018f3c1e-7a00-7000-8000-0000000000ee" };
    await expect(tenant.transaction((repositories) => repositories.projections.insertPoint(1, orphan))).rejects.toThrow(/no summary/);
    expect(store.snapshot().tenantData[TENANT_A]?.versions[1]?.points.some((row) => row.marketId === orphan.marketId)).toBe(false);
    // The use case inserts the point first and the summary after it: the same transaction commits.
    const summary = { ...emptySummary(orphan.marketId, NOW), version: 1, status: "open" as const, question: "A question", closeTime: at(60), startingPriceYesMicro: 400_000, openedAt: T0 };
    await tenant.transaction(async (repositories) => {
      await repositories.projections.insertPoint(1, { ...orphan, tradeSequence: 0, volumeMicro: 0, time: T0 });
      await repositories.projections.insertSummary(1, summary);
    });
    expect(await tenant.repositories.projections.countVersion(1)).toEqual({ summaries: 4, points: 5 });
  });

  it("checks a write made outside a transaction at once (the foreign key has no commit to wait for)", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    const orphan: PricePoint = { marketId: MARKET_1, tradeSequence: 1, time: T0, priceYesMicro: 450_000, volumeMicro: 1 };
    await expect(tenant.repositories.projections.insertPoint(1, orphan)).rejects.toThrow(/no summary/);
  });

  it("compares two versions by summaries and by points, including a point that exists in one only", async () => {
    const { tenant, state, summary, point } = await seeded();
    await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(10)));
    await load(tenant, 2, state);
    const projections = tenant.repositories.projections;
    expect(await projections.compareVersions(1, 2, 10)).toEqual([]);

    // updatedAt is not content.
    await tenant.transaction((repositories) => repositories.projections.updateSummary(2, { ...summary, updatedAt: at(99) }));
    expect(await projections.compareVersions(1, 2, 10)).toEqual([]);

    await tenant.transaction((repositories) => repositories.projections.updateSummary(2, { ...summary, question: "Another question" }));
    expect(await projections.compareVersions(1, 2, 10)).toEqual([MARKET_1]);
    await tenant.transaction((repositories) => repositories.projections.updateSummary(2, summary));
    expect(await projections.compareVersions(1, 2, 10)).toEqual([]);

    // The summaries agree and one price point differs, or exists in one version only.
    await tenant.transaction((repositories) => repositories.projections.insertPoint(1, { ...point, tradeSequence: 5, marketId: MARKET_2 }));
    expect(await projections.compareVersions(1, 2, 10)).toEqual([MARKET_2]);
    expect(await projections.compareVersions(2, 1, 10)).toEqual([MARKET_2]);
    await tenant.transaction((repositories) => repositories.projections.insertPoint(2, { ...point, tradeSequence: 5, marketId: MARKET_2, volumeMicro: 7 }));
    expect(await projections.compareVersions(1, 2, 10)).toEqual([MARKET_2]);
    expect(await projections.compareVersions(1, 2, 0)).toEqual([]);
  });

  it("deletes a version's points first, then its summaries, at most `limit` rows per call, and exports sorted", async () => {
    const { tenant } = await seeded();
    const projections = tenant.repositories.projections;
    const exported = await projections.exportVersion(1);
    expect(exported.summaries.map((row) => row.marketId)).toEqual([MARKET_1, MARKET_2, MARKET_3]);
    expect(exported.points.map((row) => `${row.marketId.slice(-3)}/${String(row.tradeSequence)}`)).toEqual(["101/0", "101/1", "102/0", "103/1"]);

    expect(await tenant.transaction((repositories) => repositories.projections.deleteVersion(1, 3))).toBe(3);
    expect(await projections.countVersion(1)).toEqual({ summaries: 3, points: 1 });
    expect(await tenant.transaction((repositories) => repositories.projections.deleteVersion(1, 2))).toBe(2);
    expect(await projections.countVersion(1)).toEqual({ summaries: 2, points: 0 });
    expect(await tenant.transaction((repositories) => repositories.projections.deleteVersion(1, 100))).toBe(2);
    expect(await tenant.transaction((repositories) => repositories.projections.deleteVersion(1, 100))).toBe(0);
  });
});

describe("the read model", () => {
  it("serves the active version only: a building version is invisible until it is activated", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    await load(tenant, 1, threeMarkets());
    await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(at(10)));
    await load(tenant, 2, foldBodies([marketOpenedBody({ marketId: MARKET_3, question: "Only in the new version" })]));
    const readModel = tenant.repositories.readModel;
    expect(await readModel.summary(MARKET_3)).toMatchObject({ question: null });
    expect((await readModel.summariesOf([MARKET_1, MARKET_3])).map((row) => row.marketId)).toEqual([MARKET_1]);

    await tenant.transaction((repositories) => repositories.checkpoints.activate(2, at(20)));
    expect((await readModel.summary(MARKET_3))?.question).toBe("Only in the new version");
    expect(await readModel.summary(MARKET_1)).toBeNull();
    expect(await readModel.hasPoint(MARKET_1, 1)).toBe(false);
  });

  it("lists listed summaries newest first by market id, after a cursor, by status, at most `limit`", async () => {
    const tenant = await tenantOf(new MemoryStore());
    await load(tenant, 1, threeMarkets());
    const list = async (page: { status: "open" | "closed" | null; beforeId: string | null; limit: number }) => (await tenant.repositories.readModel.listSummaries(page)).map((row) => row.marketId);
    // MARKET_3 has a trade but no MarketOpened: not listed.
    expect(await list({ status: null, beforeId: null, limit: 10 })).toEqual([MARKET_2, MARKET_1]);
    expect(await list({ status: null, beforeId: null, limit: 1 })).toEqual([MARKET_2]);
    expect(await list({ status: null, beforeId: MARKET_2, limit: 10 })).toEqual([MARKET_1]);
    expect(await list({ status: "closed", beforeId: null, limit: 10 })).toEqual([MARKET_2]);
    expect(await list({ status: "open", beforeId: null, limit: 10 })).toEqual([MARKET_1]);
  });

  it("answers summariesOf for listed markets only, hasPoint, and the last point before a time (ties by sequence)", async () => {
    const tenant = await tenantOf(new MemoryStore());
    await load(tenant, 1, threeMarkets());
    const readModel = tenant.repositories.readModel;
    expect((await readModel.summariesOf([MARKET_2, MARKET_3, MARKET_1, "018f3c1e-7a00-7000-8000-0000000000ff"])).map((row) => row.marketId)).toEqual([MARKET_1, MARKET_2]);
    expect(await readModel.hasPoint(MARKET_1, 1)).toBe(true);
    expect(await readModel.hasPoint(MARKET_1, 2)).toBe(false);
    expect(await readModel.hasPoint(MARKET_1, 0)).toBe(true);

    // Two points at the same time: the higher sequence is the later one.
    await tenant.transaction(async (repositories) => {
      const time = at(30);
      await repositories.projections.insertPoint(1, { marketId: MARKET_1, tradeSequence: 2, time, priceYesMicro: 460_000, volumeMicro: 1 });
      await repositories.projections.insertPoint(1, { marketId: MARKET_1, tradeSequence: 3, time, priceYesMicro: 470_000, volumeMicro: 1 });
    });
    expect((await readModel.lastPointBefore(MARKET_1, at(31)))?.priceYesMicro).toBe(470_000);
    expect((await readModel.lastPointBefore(MARKET_1, at(30)))?.priceYesMicro).toBe(450_000);
    expect(await readModel.lastPointBefore(MARKET_1, T0)).toBeNull();
    expect(await readModel.lastPointBefore(MARKET_2, at(1000))).toMatchObject({ tradeSequence: 0 });
  });

  it("gives the buckets bucketize gives for the points in [from, to), sparse, at most `limit`", async () => {
    const tenant = await tenantOf(new MemoryStore());
    const bodies = [
      marketOpenedBody({ marketId: MARKET_1 }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, executedAt: at(10) }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 500_000, executedAt: at(20), costMicro: 3_000_000 }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 3, yesPriceMicro: 480_000, executedAt: at(65) }),
      tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 4, yesPriceMicro: 520_000, executedAt: at(200) }),
    ];
    const state = foldBodies(bodies);
    await load(tenant, 1, state);
    const readModel = tenant.repositories.readModel;
    const from = T0;
    const to = at(300);
    const expected = bucketize([...state.points.values()].filter((point) => point.time.getTime() >= from.getTime() && point.time.getTime() < to.getTime()), "1h");
    expect(expected).toHaveLength(3);
    expect(await readModel.buckets(MARKET_1, { interval: "1h", from, to, limit: 10 })).toEqual(expected);
    expect(await readModel.buckets(MARKET_1, { interval: "1h", from, to, limit: 2 })).toEqual(expected.slice(0, 2));
    expect(await readModel.buckets(MARKET_1, { interval: "1h", from: at(60), to: at(120), limit: 10 })).toEqual(bucketize([state.points.get(`${MARKET_1}/3`) as PricePoint], "1h"));
    expect(await readModel.buckets(MARKET_2, { interval: "1h", from, to, limit: 10 })).toEqual([]);
  });
});

describe("transactions and the shared tables", () => {
  it("leaves nothing of a failed transaction: not the inbox entry, not the rows", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    await expect(
      tenant.transaction(async (repositories) => {
        await repositories.inbox.record({ consumer: "market-events", eventId: "e1", eventType: "t", processedAt: NOW });
        await repositories.consumedEvents.append(record("e1"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.snapshot().inbox).toEqual([]);
    expect(store.snapshot().tenantData[TENANT_A]?.consumedEvents).toEqual([]);
    // The store still works after a failed transaction.
    expect(await tenant.transaction((repositories) => repositories.inbox.record({ consumer: "market-events", eventId: "e1", eventType: "t", processedAt: NOW }))).toBe(true);
  });

  it("records an inbox entry once per consumer and event id and purges old ones", async () => {
    const store = new MemoryStore();
    const inbox = store.repositories.inbox;
    const entry = (consumer: string, eventId: string, processedAt: Date) => ({ consumer, eventId, eventType: "t", processedAt });
    expect(await inbox.record(entry("market-events", "e1", at(0)))).toBe(true);
    expect(await inbox.record(entry("market-events", "e1", at(1)))).toBe(false);
    expect(await inbox.record(entry("trade-events", "e1", at(2)))).toBe(true);
    expect(await inbox.purge(at(1))).toBe(1);
    expect(store.snapshot().inbox.map((row) => row.consumer)).toEqual(["trade-events"]);
  });

  it("parks an event, updates the same message, refuses a different one under the key, lists oldest first and removes", async () => {
    const store = new MemoryStore();
    const parked = store.repositories.parkedEvents;
    const event = (consumer: string, streamSequence: number, payload: string, at_: Date) => ({ consumer, streamSequence, subject: "chance.markets.x", payload, reason: "boom", deliveries: 20, parkedAt: at_ });
    await parked.park(event("market-events", 7, "{}", at(2)));
    await parked.park(event("trade-events", 3, "{}", at(1)));
    await parked.park({ ...event("market-events", 7, "{}", at(5)), reason: "again", deliveries: 21 });
    await expect(parked.park(event("market-events", 7, "{other}", at(6)))).rejects.toThrow(/already parked/);
    expect((await parked.list(null, 10)).map((row) => [row.consumer, row.streamSequence, row.reason])).toEqual([
      ["trade-events", 3, "boom"],
      ["market-events", 7, "again"],
    ]);
    expect(await parked.list("market-events", 10)).toHaveLength(1);
    expect(await parked.list(null, 1)).toHaveLength(1);
    await parked.remove("market-events", 7);
    expect(store.snapshot().parked).toHaveLength(1);
  });

  it("hands out a snapshot that is a copy", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    await load(tenant, 1, threeMarkets());
    const snapshot = store.snapshot();
    snapshot.tenantData[TENANT_A]!.versions[1]!.summaries.length = 0;
    snapshot.tenants.push("x");
    expect(store.snapshot().tenantData[TENANT_A]?.versions[1]?.summaries).toHaveLength(3);
    expect(store.snapshot().tenants).toEqual([TENANT_A]);
  });
});

describe("test hooks", () => {
  it("lets an operation hook fail the transaction at a chosen step", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    const seen: string[] = [];
    store.hooks.onOperation = (operation, tenantId) => {
      seen.push(`${operation}@${tenantId === null ? "shared" : "tenant"}`);
      if (operation === "consumedEvents.append") throw new Error("injected");
    };
    await expect(
      tenant.transaction(async (repositories) => {
        await repositories.inbox.record({ consumer: "c", eventId: "e1", eventType: "t", processedAt: NOW });
        await repositories.consumedEvents.append(record("e1"));
      }),
    ).rejects.toThrow("injected");
    // The inbox is a shared table (no tenant); consumed_events belongs to the tenant's schema.
    expect(seen).toEqual(["inbox.record@shared", "consumedEvents.append@tenant"]);
    expect(store.snapshot().inbox).toEqual([]);
  });

  it("calls the commit hook after a commit, outside the queue, with the operations of the transaction", async () => {
    const store = new MemoryStore();
    const tenant = await tenantOf(store);
    const commits: Array<{ tenantId: string | null; operations: readonly string[] }> = [];
    let fired = false;
    store.hooks.afterCommit = async (commit) => {
      commits.push(commit);
      if (!fired) {
        fired = true;
        // The hook may use the store: this is how a test plays a live event between two replay batches.
        await tenant.transaction((repositories) => repositories.consumedEvents.append(record("from-hook")));
      }
    };
    await tenant.transaction((repositories) => repositories.consumedEvents.append(record("e1")));
    expect(commits.map((commit) => commit.operations)).toEqual([["consumedEvents.append"], ["consumedEvents.append"]]);
    expect(commits[0]?.tenantId).toBe(TENANT_A);
    expect((await tenant.repositories.consumedEvents.read(0, 10, 10)).map((row) => row.eventId)).toEqual(["e1", "from-hook"]);

    commits.length = 0;
    await expect(
      tenant.transaction(async () => {
        await Promise.resolve();
        throw new Error("no commit");
      }),
    ).rejects.toThrow("no commit");
    expect(commits).toEqual([]);
    await store.transaction((repositories) => repositories.inbox.purge(NOW));
    expect(commits).toEqual([{ tenantId: null, operations: ["inbox.purge"] }]);
  });
});
