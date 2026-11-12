import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "../../src/adapters/postgres/postgres-store.js";
import { systemClock } from "../../src/adapters/system.js";
import { isProjectionEvent, readProjectionEvent } from "../../src/domain/consumed.js";
import { foldEvents, pointKey, projectionDifferences } from "../../src/domain/projection.js";
import type { ProjectionState } from "../../src/domain/projection.js";
import { GetMarket } from "../../src/usecases/get-market.js";
import { ListMarkets } from "../../src/usecases/list-markets.js";
import { ProvisionTenant } from "../../src/usecases/provision-tenant.js";
import { RecordProjectionEvent } from "../../src/usecases/record-projection-event.js";
import { ReplayProjections } from "../../src/usecases/replay-projections.js";
import type { ReplayReport } from "../../src/usecases/use-cases.js";
import { RecordingLogger, TENANT_A, TENANT_B, at, marketClosedBody, marketOpenedBody, marketResolvedBody, nextEventId, tenantCreatedBody, tradeExecutedBody } from "../support/fakes.js";
import { readTenantCreated } from "../../src/domain/tenant.js";

// Live consumption during a replay and the switch (DM-09, REQ-12, ADR-032, ADR-058), with the real use cases on a real
// PostgreSQL 18: two parallel "consumers" record events (lifecycle and trades of several markets, repeats of the same
// event, the same trade under another event id, out of order) while ReplayProjections rebuilds the tenant into a new
// version with a small batch size, and a poller reads the way the API does. Needs Docker: "npm run test:integration".

type Body = Record<string, unknown>;

const TRADE_COST_MICRO = 10_000_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let store: PostgresStore;
const logger = new RecordingLogger();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18").withDatabase("market_data").start();
  pool = createPool(container.getConnectionUri(), 16, logger);
  await runMigrations(pool, logger);
  store = new PostgresStore(pool, logger);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const deps = () => ({ store, clock: systemClock, logger });
const record = (body: Body) => {
  const event = readProjectionEvent(body);
  if (event.kind === "unattributable") throw new Error(`The test event is unattributable: ${event.reason}`);
  return new RecordProjectionEvent(deps()).execute({ event, raw: body });
};

/** A small deterministic generator, so a failure repeats. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

const marketOf = (tenantNumber: number, n: number): string => `00000000-0000-7000-8000-${String(tenantNumber * 1000 + n).padStart(12, "0")}`;

interface World {
  tenantId: string;
  /** Every distinct event once: what the active version must equal a fold of. */
  distinct: Body[];
  /** What the consumers are handed, shuffled: repeats of the same event and the same trade under another event id included. */
  deliveries: Body[];
}

/** `markets` markets of one tenant: opened, `trades` trades each, closed, resolved; plus repeats. */
function worldOf(tenantId: string, tenantNumber: number, markets: number, trades: number, seed: number): World {
  const next = random(seed);
  const distinct: Body[] = [];
  const repeats: Body[] = [];
  for (let m = 1; m <= markets; m += 1) {
    const marketId = marketOf(tenantNumber, m);
    distinct.push(marketOpenedBody({ marketId, tenantId, question: `Question ${String(m)}?`, openedAt: at(0), closeTime: at(2000) }));
    for (let sequence = 1; sequence <= trades; sequence += 1) {
      const trade = tradeExecutedBody({ marketId, tenantId, tradeSequence: sequence, yesPriceMicro: 400_000 + (((sequence * 7 + m) % 12) + 1) * 10_000, costMicro: TRADE_COST_MICRO, executedAt: at(sequence) });
      distinct.push(trade);
      // The same event delivered twice (a redelivery) and the same trade under a new event id (a repeated sequence).
      if (sequence % 9 === 0) repeats.push(trade);
      if (sequence % 11 === 0) repeats.push({ ...trade, id: nextEventId() });
    }
    distinct.push(marketClosedBody({ marketId, tenantId, version: 2, closedAt: at(100) }));
    distinct.push(marketResolvedBody({ marketId, tenantId, version: 3, outcome: m % 2 === 0 ? "YES" : "NO", resolvedAt: at(110) }));
  }
  return { tenantId, distinct, deliveries: shuffled([...distinct, ...repeats], next) };
}

/** The distinct events of a world as the projection the active version must hold. */
function expectedState(world: World): ProjectionState {
  const events = world.distinct.map((body) => readProjectionEvent(body)).filter(isProjectionEvent);
  expect(events).toHaveLength(world.distinct.length);
  return foldEvents(events, new Date());
}

async function provision(tenantId: string): Promise<void> {
  const read = readTenantCreated(tenantCreatedBody(tenantId));
  if (read.kind !== "tenant_created") throw new Error("The test TenantCreated was not read");
  await new ProvisionTenant(deps()).execute(read.notice);
}

interface Delivery {
  body: Body;
  result: string;
  doneAt: number;
}

/** One consumer: records its deliveries one after the other, as a JetStream consumer handles one message at a time. */
async function consumer(bodies: readonly Body[], done: Delivery[]): Promise<void> {
  for (const body of bodies) {
    const result = await record(body);
    done.push({ body, result, doneAt: Date.now() });
  }
}

/** Polls the way the API reads: through ListMarkets, and the checkpoints; remembers anything that must never happen. */
function startPoller(tenantId: string) {
  const list = new ListMarkets(deps());
  const seenTrades = new Map<string, number>();
  const problems: string[] = [];
  const activeVersions = new Set<number>();
  let polls = 0;
  let stopped = false;
  const loop = (async () => {
    const tenant = await store.forTenant(tenantId);
    if (tenant === null) throw new Error("The poller's tenant is not registered");
    while (!stopped) {
      const page = await list.execute({ actor: { userId: "poller", tenantId, role: "trader", correlationId: "poll" }, limit: 100 });
      for (const market of page.items) {
        const before = seenTrades.get(market.marketId) ?? 0;
        if (market.tradeCount < before) problems.push(`${market.marketId}: the trade count went down from ${String(before)} to ${String(market.tradeCount)}`);
        seenTrades.set(market.marketId, Math.max(before, market.tradeCount));
        if (market.volumeMicro !== market.tradeCount * TRADE_COST_MICRO) problems.push(`${market.marketId}: volume ${String(market.volumeMicro)} is not ${String(market.tradeCount)} trades`);
        if (market.tradeCount > market.lastTradeSequence) problems.push(`${market.marketId}: more trades than the last sequence`);
      }
      const checkpoints = await tenant.repositories.checkpoints.list();
      const active = checkpoints.filter((checkpoint) => checkpoint.state === "active");
      if (active.length !== 1) problems.push(`${String(active.length)} active versions at once`);
      for (const checkpoint of active) activeVersions.add(checkpoint.version);
      polls += 1;
      await sleep(2);
    }
  })();
  return {
    problems,
    activeVersions,
    polls: () => polls,
    seenTrades,
    stop: async (): Promise<void> => {
      stopped = true;
      await loop;
    },
  };
}

/** Every consumed event of the tenant that was stored, with the number of rows. */
async function consumedRows(tenantId: string) {
  const tenant = await store.forTenant(tenantId);
  if (tenant === null) throw new Error("not registered");
  return tenant.repositories.consumedEvents.read(0, Number.MAX_SAFE_INTEGER, 100_000);
}

async function activeState(tenantId: string): Promise<{ version: number; state: ProjectionState }> {
  const tenant = await store.forTenant(tenantId);
  if (tenant === null) throw new Error("not registered");
  const checkpoints = await tenant.repositories.checkpoints.list();
  const active = checkpoints.find((checkpoint) => checkpoint.state === "active");
  if (active === undefined) throw new Error("no active version");
  const rows = await tenant.repositories.projections.exportVersion(active.version);
  return {
    version: active.version,
    state: { summaries: new Map(rows.summaries.map((summary) => [summary.marketId, summary])), points: new Map(rows.points.map((point) => [pointKey(point.marketId, point.tradeSequence), point])) },
  };
}

describe("live consumption during a replay and the switch, on PostgreSQL", () => {
  it("loses and doubles no event, switches once, and no read ever sees a half-built version", async () => {
    const world = worldOf(TENANT_A, 1, 8, 30, 20261111);
    const other = worldOf(TENANT_B, 2, 3, 10, 7);
    await provision(TENANT_A);
    await provision(TENANT_B);
    const done: Delivery[] = [];

    // The history: 70 % of the deliveries were consumed before the replay starts; the rest arrives while it runs.
    const cut = Math.floor(world.deliveries.length * 0.7);
    await consumer([...world.deliveries.slice(0, cut), ...other.deliveries.slice(0, 15)], done);
    const live = [...world.deliveries.slice(cut), ...other.deliveries.slice(15)];

    const poller = startPoller(TENANT_A);
    const replay = new ReplayProjections(deps()).execute({ tenantId: TENANT_A, batchSize: 4 });
    // Two consumers, started with the replay: each takes every other live delivery.
    const lanes = [live.filter((_, index) => index % 2 === 0), live.filter((_, index) => index % 2 === 1)];
    const [report] = await Promise.all([replay, consumer(lanes[0] ?? [], done), consumer(lanes[1] ?? [], done)]);
    await sleep(20);
    await poller.stop();

    // The replay switched exactly once and found nothing to correct.
    expect(report).toMatchObject({ tenantId: TENANT_A, outcome: "switched", fromVersion: 1, toVersion: 2, differences: [], eventsUnreadable: 0 });
    // The consumers really ran during it: live events were recorded between its start and its switch.
    const during = done.filter((delivery) => delivery.doneAt >= report.startedAt.getTime() && delivery.doneAt <= (report.switchedAt as Date).getTime() + 5);
    expect(during.length).toBeGreaterThanOrEqual(10);

    // No event lost or doubled: whatever the repeats and the order, each event id was handled once and every further
    // delivery of it was a duplicate. (The same trade under another event id is its own event: "stale", a row of its own.)
    const handled = new Map<string, number>();
    for (const delivery of done) {
      if (delivery.result !== "duplicate") handled.set(String(delivery.body["id"]), (handled.get(String(delivery.body["id"])) ?? 0) + 1);
    }
    expect([...handled.values()].every((n) => n === 1)).toBe(true);
    const sent = new Set([...world.deliveries, ...other.deliveries].map((body) => String(body["id"])));
    expect(new Set(handled.keys())).toEqual(sent);
    expect(done.filter((delivery) => delivery.result === "stale").length).toBeGreaterThan(0);

    // consumed_events holds each event of the tenant once; the replay read every row that was there when it started.
    const rows = await consumedRows(TENANT_A);
    expect(rows.map((row) => row.eventId).sort()).toEqual([...new Set(world.deliveries.map((body) => String(body["id"])))].sort());
    expect(report.eventsApplied).toBe(rows.filter((row) => row.position <= report.highWaterPosition).length);
    // The active version equals the fold of everything that was sent and of everything that was stored.
    const active = await activeState(TENANT_A);
    expect(active.version).toBe(2);
    expect(projectionDifferences(active.state, expectedState(world))).toEqual([]);
    const fromRows = foldEvents(rows.map((row) => readProjectionEvent(row.event)).filter(isProjectionEvent), new Date());
    expect(projectionDifferences(active.state, fromRows)).toEqual([]);
    expect(active.state.summaries.size).toBe(8);
    expect(active.state.points.size).toBe(8 * 31);
    for (const summary of active.state.summaries.values()) expect(summary).toMatchObject({ tradeCount: 30, volumeMicro: 30 * TRADE_COST_MICRO, status: "resolved", version: 3 });

    // Version 1 is gone: its rows were deleted and the checkpoint stays as history.
    const tenant = await store.forTenant(TENANT_A);
    const checkpoints = (await tenant?.repositories.checkpoints.list()) ?? [];
    expect(checkpoints.map((checkpoint) => [checkpoint.version, checkpoint.state])).toEqual([[1, "retired"], [2, "active"]]);
    expect(await tenant?.repositories.projections.countVersion(1)).toEqual({ summaries: 0, points: 0 });

    // The poller read all along, saw the switch and never a trade count that went down, a half-built version or two active ones.
    expect(poller.problems).toEqual([]);
    expect(poller.polls()).toBeGreaterThanOrEqual(10);
    expect([...poller.activeVersions].sort()).toEqual([1, 2]);

    // Another tenant's events are untouched by the replay of this one.
    const otherActive = await activeState(TENANT_B);
    expect(otherActive.version).toBe(1);
    expect(projectionDifferences(otherActive.state, expectedState(other))).toEqual([]);
  }, 120_000);

  it("two replays of one tenant at once while events arrive: the same final state, one active version, nothing left building", async () => {
    const world = worldOf("00000000-0000-7000-8000-0000000000c1", 3, 6, 25, 99);
    const tenantId = world.tenantId;
    await provision(tenantId);
    const done: Delivery[] = [];
    const cut = Math.floor(world.deliveries.length * 0.6);
    await consumer(world.deliveries.slice(0, cut), done);
    const live = world.deliveries.slice(cut);

    const poller = startPoller(tenantId);
    const [first, second] = await Promise.all([
      new ReplayProjections(deps()).execute({ tenantId, batchSize: 3 }),
      new ReplayProjections(deps()).execute({ tenantId, batchSize: 3 }),
      consumer(live.filter((_, index) => index % 2 === 0), done),
      consumer(live.filter((_, index) => index % 2 === 1), done),
    ]);
    await poller.stop();
    const reports: ReplayReport[] = [first, second];

    for (const report of reports) expect(["switched", "finished_elsewhere"]).toContain(report.outcome);
    expect(reports.some((report) => report.outcome === "switched")).toBe(true);
    expect(reports.flatMap((report) => report.differences)).toEqual([]);

    const tenant = await store.forTenant(tenantId);
    const checkpoints = (await tenant?.repositories.checkpoints.list()) ?? [];
    expect(checkpoints.filter((checkpoint) => checkpoint.state === "active")).toHaveLength(1);
    expect(checkpoints.filter((checkpoint) => checkpoint.state === "building")).toHaveLength(0);
    for (const checkpoint of checkpoints.filter((row) => row.state === "retired")) expect(await tenant?.repositories.projections.countVersion(checkpoint.version)).toEqual({ summaries: 0, points: 0 });
    const active = await activeState(tenantId);
    expect(projectionDifferences(active.state, expectedState(world))).toEqual([]);
    expect(poller.problems).toEqual([]);
    for (const summary of active.state.summaries.values()) expect(summary).toMatchObject({ tradeCount: 25, volumeMicro: 25 * TRADE_COST_MICRO });
  }, 120_000);

  it("reads through GetMarket answer from the old version until the switch and from the new one after it, with the same values", async () => {
    const world = worldOf("00000000-0000-7000-8000-0000000000c2", 4, 2, 12, 5);
    const tenantId = world.tenantId;
    await provision(tenantId);
    const done: Delivery[] = [];
    await consumer(world.deliveries, done);
    const getMarket = new GetMarket(deps());
    const actor = { userId: "reader", tenantId, role: "trader" as const, correlationId: "read" };
    const marketId = marketOf(4, 1);
    const before = await getMarket.execute({ actor, marketId });
    const report = await new ReplayProjections(deps()).execute({ tenantId, batchSize: 5 });
    expect(report).toMatchObject({ outcome: "switched", differences: [], fromVersion: 1, toVersion: 2 });
    const after = await getMarket.execute({ actor, marketId });
    expect({ ...after, updatedAt: undefined }).toEqual({ ...before, updatedAt: undefined });
  }, 120_000);
});
