import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIRS, listTenantSchemas, migrateTenantSchema, runMigrations } from "../../src/adapters/postgres/migrate.js";
import { PROJECTION_LOCK_CLASS, PostgresStore, createPool } from "../../src/adapters/postgres/postgres-store.js";
import { bucketize, INTERVALS } from "../../src/domain/history.js";
import type { Interval } from "../../src/domain/history.js";
import { emptySummary, foldEvents, pointKey, projectionDifferences } from "../../src/domain/projection.js";
import type { MarketSummary, PricePoint, ProjectionState } from "../../src/domain/projection.js";
import { tenantSchemaIdentifier, tenantSchemaName } from "../../src/domain/tenant.js";
import type { ProjectionEvent } from "../../src/domain/consumed.js";
import type { ConsumedEventRecord, ParkedEvent, TenantRepositories, TenantStore } from "../../src/usecases/ports.js";
import { applyToVersion } from "../../src/usecases/apply-event.js";
import { MARKET_1, MARKET_2, MARKET_3, RecordingLogger, T0, at, marketClosedBody, marketOpenedBody, marketResolvedBody, projectionEvent, tradeExecutedBody } from "../support/fakes.js";

// These tests need a running Docker daemon: "npm run test:integration". They are not part of "npm test". One PostgreSQL 18
// container serves the whole file; every test that needs rows uses a tenant (schema) of its own, so tests never see each
// other's data.

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let store: PostgresStore;
let extraDir: string;
const logger = new RecordingLogger();
const now = new Date("2026-11-01T12:00:00.000Z");
const tenantIds = Array.from({ length: 40 }, (_, index) => `00000000-0000-7000-8000-0000000000${(index + 1).toString(16).padStart(2, "0")}`);
const T = (n: number): string => tenantIds[n - 1] as string;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18").withDatabase("market_data").start();
  pool = createPool(container.getConnectionUri(), 16, logger);
  extraDir = await mkdtemp(join(tmpdir(), "market-data-migrations-"));
  store = new PostgresStore(pool, logger);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (extraDir) await rm(extraDir, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitFor: the condition did not become true in time");
    await sleep(20);
  }
}

const tenantStore = (tenantId: string): Promise<TenantStore> => store.ensureTenant(tenantId, now);
const schemaOf = (tenantId: string): string => tenantSchemaIdentifier(tenantId);

/** "23514:market_summaries_status_values": the SQLSTATE and the constraint a statement violated, or "none". */
const violation = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    return `${code ?? "no code"}:${constraint ?? ""}`;
  }
  return "none";
};

const failureOf = async (promise: Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("The statement did not fail");
};

const marketId = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

// ---- Raw rows, to reach the constraints without the domain in between --------------------------------------------------

const SUMMARY_DEFAULTS: Record<string, unknown> = {
  projection_version: 1,
  market_id: marketId(900),
  market_version: 1,
  status: "open",
  question: "Will it work?",
  close_time: at(600),
  starting_price_yes_micro: 400_000,
  opened_at: T0,
  closed_at: null,
  resolved_at: null,
  outcome: null,
  last_price_yes_micro: null,
  last_trade_sequence: 0,
  last_trade_at: null,
  trade_count: 0,
  volume_micro: 0,
  updated_at: T0,
};

let rawCounter = 1000;
function insertRawSummary(tenantId: string, overrides: Record<string, unknown>): Promise<unknown> {
  rawCounter += 1;
  const row = { ...SUMMARY_DEFAULTS, market_id: marketId(rawCounter), ...overrides };
  const columns = Object.keys(row);
  return pool.query(`INSERT INTO ${schemaOf(tenantId)}.market_summaries (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${String(i + 1)}`).join(", ")})`, Object.values(row));
}

const POINT_DEFAULTS: Record<string, unknown> = { projection_version: 1, market_id: marketId(900), trade_sequence: 1, time: at(1), price_yes_micro: 450_000, volume_micro: 1_000_000 };

function insertRawPoint(tenantId: string, overrides: Record<string, unknown>, client: Pick<pg.Pool, "query"> = pool): Promise<unknown> {
  const row = { ...POINT_DEFAULTS, ...overrides };
  const columns = Object.keys(row).map((name) => (name === "time" ? '"time"' : name));
  return client.query(`INSERT INTO ${schemaOf(tenantId)}.price_points (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${String(i + 1)}`).join(", ")})`, Object.values(row));
}

function insertRawCheckpoint(tenantId: string, overrides: Record<string, unknown>): Promise<unknown> {
  const row = { version: 50, state: "retired", high_water_position: null, rebuilt_through: 0, unreadable_events: 0, created_at: T0, activated_at: T0, retired_at: T0, ...overrides };
  const columns = Object.keys(row);
  return pool.query(`INSERT INTO ${schemaOf(tenantId)}.projection_checkpoints (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${String(i + 1)}`).join(", ")})`, Object.values(row));
}

const consumedRecord = (n: number, overrides: Partial<Omit<ConsumedEventRecord, "position">> = {}): Omit<ConsumedEventRecord, "position"> => ({
  eventId: `00000000-0000-7000-8000-${String(n + 50_000).padStart(12, "0")}`,
  eventType: "si.chance.markets.MarketClosed.v1",
  marketId: MARKET_1,
  event: { id: String(n), type: "si.chance.markets.MarketClosed.v1" },
  receivedAt: now,
  ...overrides,
});

async function applyLive(tenant: TenantStore, version: number, event: ProjectionEvent): Promise<void> {
  await tenant.transaction(async (r) => {
    await applyToVersion(r.projections, version, event, now);
  });
}

const toState = (exported: { summaries: MarketSummary[]; points: PricePoint[] }): ProjectionState => ({
  summaries: new Map(exported.summaries.map((summary) => [summary.marketId, summary])),
  points: new Map(exported.points.map((point) => [pointKey(point.marketId, point.tradeSequence), point])),
});

function summaryOf(id: string, overrides: Partial<MarketSummary> = {}): MarketSummary {
  return {
    ...emptySummary(id, now),
    version: 1,
    status: "open",
    question: `Question of ${id}?`,
    closeTime: at(600),
    startingPriceYesMicro: 400_000,
    openedAt: T0,
    ...overrides,
  };
}

const point = (id: string, tradeSequence: number, time: Date, priceYesMicro: number, volumeMicro: number): PricePoint => ({ marketId: id, tradeSequence, time, priceYesMicro, volumeMicro });

// ---- Migrations ------------------------------------------------------------------------------------------------------

describe("migrations", () => {
  it("creates the shared tables and a schema with the tenant tables for every tenant, and a rerun applies nothing", async () => {
    const first = await runMigrations(pool, logger);
    expect(first.shared).toEqual(["001_init.sql"]);

    await tenantStore(T(1));
    await tenantStore(T(2));

    const tables = async (schema: string): Promise<string[]> =>
      (await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name", [schema])).rows.map(
        (row) => row.table_name,
      );
    expect(await tables("shared")).toEqual(["inbox", "parked_events", "schema_migrations", "tenant_registry"]);
    for (const tenant of [T(1), T(2)]) {
      expect(await tables(tenantSchemaName(tenant))).toEqual(["consumed_events", "market_summaries", "price_points", "projection_checkpoints", "schema_migrations"]);
    }
    expect(await listTenantSchemas(pool)).toEqual([tenantSchemaName(T(1)), tenantSchemaName(T(2))]);

    expect(await runMigrations(pool, logger)).toEqual({ shared: [], tenants: {} });
  });

  it("gives every tenant projection version 1, active, with no high water mark", async () => {
    const tenant = await tenantStore(T(3));

    const versions = await tenant.repositories.checkpoints.list();

    expect(versions).toEqual([{ version: 1, state: "active", highWaterPosition: null, rebuiltThrough: 0, unreadableEvents: 0, createdAt: expect.any(Date) as Date, activatedAt: expect.any(Date) as Date, retiredAt: null }]);
  });

  it("applies a later tenant file to every registered schema at startup, once, and refuses a file that was changed after it ran", async () => {
    const sharedDir = join(extraDir, "shared");
    const tenantDir = join(extraDir, "tenant");
    await mkdir(sharedDir, { recursive: true });
    await mkdir(tenantDir, { recursive: true });
    await copyFile(fileURLToPath(new URL("001_init.sql", MIGRATIONS_DIRS.shared)), join(sharedDir, "001_init.sql"));
    for (const file of ["001_init.sql", "002_invalid_outcome.sql"]) await copyFile(fileURLToPath(new URL(file, MIGRATIONS_DIRS.tenant)), join(tenantDir, file));
    await writeFile(join(tenantDir, "003_marker.sql"), "CREATE TABLE migration_marker (id integer PRIMARY KEY);\n");
    const directories = { shared: pathToFileURL(`${sharedDir}/`), tenant: pathToFileURL(`${tenantDir}/`) };

    const report = await runMigrations(pool, logger, directories);
    expect(Object.keys(report.tenants).sort()).toEqual([tenantSchemaName(T(1)), tenantSchemaName(T(2)), tenantSchemaName(T(3))]);
    expect(Object.values(report.tenants).every((files) => files.length === 1 && files[0] === "003_marker.sql")).toBe(true);
    expect(await runMigrations(pool, logger, directories)).toEqual({ shared: [], tenants: {} });

    await writeFile(join(tenantDir, "001_init.sql"), "-- changed after it was applied\n");
    await expect(runMigrations(pool, logger, directories)).rejects.toThrow("was changed after it was applied");
  });

  it("migrateTenantSchema (the repair tool) brings one schema up to date in a transaction of its own and registers the tenant", async () => {
    expect(await migrateTenantSchema(pool, T(4), now, logger)).toEqual(["001_init.sql", "002_invalid_outcome.sql"]);
    expect(await migrateTenantSchema(pool, T(4), now, logger)).toEqual([]);
    expect(await store.repositories.tenants.isRegistered(T(4))).toBe(true);
  });

  it("ensureTenant is idempotent and safe to call from several connections at once; forTenant knows only registered tenants", async () => {
    const results = await Promise.all([store.ensureTenant(T(5), now), store.ensureTenant(T(5), now), store.ensureTenant(T(5), now)]);

    expect(results.map((result) => result.tenantId)).toEqual([T(5), T(5), T(5)]);
    expect(await store.forTenant(T(5))).not.toBeNull();
    expect(await store.forTenant(T(6))).toBeNull();
    expect(await store.forTenant("not-a-uuid")).toBeNull();
    expect(await store.repositories.tenants.isRegistered(T(5))).toBe(true);
    expect(await store.repositories.tenants.isRegistered("not-a-uuid")).toBe(false);
    expect((await store.repositories.tenants.list()).includes(T(5))).toBe(true);
  });

  it("refuses to provision a schema outside a transaction, and the projection locks too", async () => {
    const tenant = await tenantStore(T(5));

    await expect(store.repositories.tenants.provision(T(7), now)).rejects.toThrow("inside a transaction");
    await expect(tenant.repositories.checkpoints.targets()).rejects.toThrow("inside a transaction");
    await expect(tenant.repositories.checkpoints.lockForRebuild()).rejects.toThrow("inside a transaction");
    await expect(tenant.repositories.checkpoints.startBuilding(now)).rejects.toThrow("inside a transaction");
  });
});

// ---- The constraints (DM-10, DM-09) ------------------------------------------------------------------------------------

describe("market_summaries constraints", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["a version that has no checkpoint", { projection_version: 99 }, "23503:market_summaries_version_fkey"],
    ["a market version below 0 with a status", { market_version: -1 }, "23514:market_summaries_market_version_nonnegative"],
    ["a status outside the three", { status: "paused" }, "23514:market_summaries_status_values"],
    ["an empty question", { question: "" }, "23514:market_summaries_question_length"],
    ["a question of 201 characters", { question: "q".repeat(201) }, "23514:market_summaries_question_length"],
    ["a starting price off the grid", { starting_price_yes_micro: 400_001 }, "23514:market_summaries_starting_price_grid"],
    ["a starting price below 0.01", { starting_price_yes_micro: 5000 }, "23514:market_summaries_starting_price_grid"],
    ["a starting price of 1.00", { starting_price_yes_micro: 1_000_000 }, "23514:market_summaries_starting_price_grid"],
    ["an outcome that is neither YES, NO nor INVALID", { status: "resolved", market_version: 3, outcome: "MAYBE", resolved_at: T0 }, "23514:market_summaries_outcome_values"],
    ["a last price of 9 999", { last_price_yes_micro: 9999, trade_count: 1, last_trade_sequence: 1, last_trade_at: T0 }, "23514:market_summaries_last_price_range"],
    ["a last price of 990 001", { last_price_yes_micro: 990_001, trade_count: 1, last_trade_sequence: 1, last_trade_at: T0 }, "23514:market_summaries_last_price_range"],
    ["a negative volume", { volume_micro: -1 }, "23514:market_summaries_volume_nonnegative"],
    ["a negative trade count", { trade_count: -1, last_trade_sequence: 1, last_price_yes_micro: 500_000, last_trade_at: T0 }, "23514:market_summaries_trade_count_nonnegative"],
    // The other checks of a negative sequence hold too (count and time follow it), so only the first by name is reported.
    ["a negative highest trade sequence", { trade_count: -1, last_trade_sequence: -1, last_price_yes_micro: 500_000, last_trade_at: T0 }, "23514:market_summaries_last_trade_sequence_nonnegative"],
    ["a status on version 0", { market_version: 0 }, "23514:market_summaries_status_matches_version"],
    ["no status on version 1", { status: null }, "23514:market_summaries_status_matches_version"],
    ["an outcome on an open market", { outcome: "YES" }, "23514:market_summaries_outcome_matches_status"],
    ["a resolved market with no outcome", { status: "resolved", market_version: 3, resolved_at: T0 }, "23514:market_summaries_outcome_matches_status"],
    ["a trade count without a last price", { trade_count: 1, last_trade_sequence: 1, last_trade_at: T0 }, "23514:market_summaries_last_price_matches_count"],
    ["a last price without trades", { last_price_yes_micro: 500_000 }, "23514:market_summaries_last_price_matches_count"],
    ["a last trade sequence without a time", { last_trade_sequence: 3 }, "23514:market_summaries_last_trade_time_matches_sequence"],
    ["a last trade time without a sequence", { last_trade_at: T0 }, "23514:market_summaries_last_trade_time_matches_sequence"],
    ["more trades than the highest sequence", { trade_count: 3, last_trade_sequence: 2, last_price_yes_micro: 500_000, last_trade_at: T0 }, "23514:market_summaries_count_within_sequence"],
    ["a question without the opening facts", { close_time: null }, "23514:market_summaries_opening_facts_together"],
  ])("refuses %s", async (_name, overrides, expected) => {
    const tenant = await tenantStore(T(8));

    expect(await violation(insertRawSummary(tenant.tenantId, overrides))).toBe(expected);
  });

  it("accepts the rows the domain produces: an empty summary, a trade price off the grid, 200 astral characters", async () => {
    const tenant = await tenantStore(T(8));
    const astral = "😀".repeat(200);

    expect(await violation(insertRawSummary(T(8), { market_version: 0, status: null, question: null, close_time: null, starting_price_yes_micro: null, opened_at: null }))).toBe("none");
    expect(await violation(insertRawSummary(T(8), { last_price_yes_micro: 555_000, trade_count: 1, last_trade_sequence: 1, last_trade_at: T0 }))).toBe("none");
    // UC-16 (tenant migration 002): INVALID is the third outcome of a resolved market.
    expect(await violation(insertRawSummary(T(8), { market_id: marketId(88), status: "resolved", market_version: 3, outcome: "INVALID", resolved_at: T0 }))).toBe("none");
    expect(await tenant.transaction((r) => r.projections.insertSummary(1, summaryOf(MARKET_3, { question: astral })))).toBe(true);

    const stored = await tenant.repositories.projections.findSummary(1, MARKET_3);
    expect(stored?.question).toBe(astral);
    const length = await pool.query<{ n: number }>(`SELECT char_length(question) AS n FROM ${schemaOf(T(8))}.market_summaries WHERE market_id = $1`, [MARKET_3]);
    expect(length.rows[0]?.n).toBe(200);
  });

  it("keeps one summary per version and market", async () => {
    const tenant = await tenantStore(T(8));
    await insertRawSummary(T(8), { market_id: marketId(3000) });

    expect(await violation(insertRawSummary(T(8), { market_id: marketId(3000) }))).toBe("23505:market_summaries_pkey");
    expect(await tenant.transaction((r) => r.projections.insertSummary(1, summaryOf(marketId(3000))))).toBe(false);
  });
});

describe("price_points constraints", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["a sequence below 0", { trade_sequence: -1, volume_micro: 0 }, "23514:price_points_sequence_nonnegative"],
    ["a price of 9 999", { price_yes_micro: 9999 }, "23514:price_points_price_range"],
    ["a price of 990 001", { price_yes_micro: 990_001 }, "23514:price_points_price_range"],
    ["a negative volume", { volume_micro: -1 }, "23514:price_points_volume_nonnegative"],
    ["volume on the opening point", { trade_sequence: 0, volume_micro: 5 }, "23514:price_points_opening_has_no_volume"],
  ])("refuses %s", async (_name, overrides, expected) => {
    const tenant = await tenantStore(T(9));
    await tenant.transaction((r) => r.projections.insertSummary(1, summaryOf(marketId(900))).then(() => undefined));

    expect(await violation(insertRawPoint(T(9), overrides))).toBe(expected);
  });

  it("keeps one point per version, market and sequence, and checks the summary only at commit (deferred foreign key)", async () => {
    const tenant = await tenantStore(T(9));
    await tenant.transaction((r) => r.projections.insertSummary(1, summaryOf(marketId(900))).then(() => undefined));
    await insertRawPoint(T(9), { trade_sequence: 5, price_yes_micro: 555_000 });

    expect(await violation(insertRawPoint(T(9), { trade_sequence: 5 }))).toBe("23505:price_points_pkey");

    // A point whose summary does not exist is accepted by the statement and refused when the transaction commits.
    const lonely = await pool.connect();
    try {
      await lonely.query("BEGIN");
      await insertRawPoint(T(9), { market_id: marketId(902) }, lonely);
      expect(await violation(lonely.query("COMMIT"))).toBe("23503:price_points_summary_fkey");
    } finally {
      await lonely.query("ROLLBACK").catch(() => undefined);
      lonely.release();
    }
  });

  it("accepts the point of a summary that arrives later in the same transaction", async () => {
    const tenant = await tenantStore(T(9));

    await tenant.transaction(async (r) => {
      expect(await r.projections.insertPoint(1, point(marketId(903), 1, at(1), 555_000, 1_000_000))).toBe(true);
      expect(await r.projections.insertPoint(1, point(marketId(903), 1, at(1), 555_000, 1_000_000))).toBe(false);
      await r.projections.insertSummary(1, summaryOf(marketId(903)));
    });

    expect((await tenant.repositories.projections.exportVersion(1)).points.filter((p) => p.marketId === marketId(903))).toHaveLength(1);
  });
});

describe("projection_checkpoints constraints", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["version 0", { version: 0 }, "23514:projection_checkpoints_version_positive"],
    ["a state outside the three", { state: "archived", retired_at: null }, "23514:projection_checkpoints_state_values"],
    ["a negative high water mark", { high_water_position: -1 }, "23514:projection_checkpoints_high_water_nonnegative"],
    ["a negative progress", { rebuilt_through: -1 }, "23514:projection_checkpoints_rebuilt_through_nonnegative"],
    ["a negative unreadable count", { unreadable_events: -1 }, "23514:projection_checkpoints_unreadable_nonnegative"],
    ["a building version that was activated", { state: "building", retired_at: null }, "23514:projection_checkpoints_activated_unless_building"],
    ["an active version that was never activated", { state: "active", activated_at: null, retired_at: null }, "23514:projection_checkpoints_activated_unless_building"],
    ["a retired version without a retirement time", { state: "retired", retired_at: null }, "23514:projection_checkpoints_retired_has_time"],
    ["an active version with a retirement time", { state: "active" }, "23514:projection_checkpoints_retired_has_time"],
  ])("refuses %s", async (_name, overrides, expected) => {
    const tenant = await tenantStore(T(10));

    expect(await violation(insertRawCheckpoint(tenant.tenantId, overrides))).toBe(expected);
  });

  it("allows exactly one active and at most one building version", async () => {
    await tenantStore(T(10));

    expect(await violation(insertRawCheckpoint(T(10), { version: 51, state: "active", retired_at: null }))).toBe("23505:projection_checkpoints_one_active");
    expect(await violation(insertRawCheckpoint(T(10), { version: 52, state: "building", activated_at: null, retired_at: null, high_water_position: 0 }))).toBe("none");
    expect(await violation(insertRawCheckpoint(T(10), { version: 53, state: "building", activated_at: null, retired_at: null, high_water_position: 0 }))).toBe("23505:projection_checkpoints_one_building");
  });
});

describe("consumed_events", () => {
  it("stores every event once: positions increase, a stored id returns null, the event comes back as it went in", async () => {
    const tenant = await tenantStore(T(11));
    const { consumedEvents } = tenant.repositories;

    const first = await consumedEvents.append(consumedRecord(1));
    const second = await consumedEvents.append(consumedRecord(2, { marketId: null, eventType: "si.chance.markets.MarketCreated.v1", event: { nested: { values: [1, "two", null] } } }));
    const repeated = await consumedEvents.append(consumedRecord(1));

    expect(first).not.toBeNull();
    expect(second).toBeGreaterThan(first as number);
    expect(repeated).toBeNull();
    const rows = await consumedEvents.read(0, 1000, 10);
    expect(rows.map((row) => row.position)).toEqual([first, second]);
    expect(rows[1]).toMatchObject({ marketId: null, eventType: "si.chance.markets.MarketCreated.v1", event: { nested: { values: [1, "two", null] } }, receivedAt: now });
  });

  it("reads the rows after a position, up to a position, at most a limit", async () => {
    const tenant = await tenantStore(T(11));
    const { consumedEvents } = tenant.repositories;
    for (let n = 10; n < 16; n += 1) await consumedEvents.append(consumedRecord(n));
    const all = await consumedEvents.read(0, 10_000, 100);
    const positions = all.map((row) => row.position);

    expect((await consumedEvents.read(positions[1] as number, positions[4] as number, 100)).map((row) => row.position)).toEqual(positions.slice(2, 5));
    expect((await consumedEvents.read(0, 10_000, 2)).map((row) => row.position)).toEqual(positions.slice(0, 2));
    expect(await consumedEvents.read(positions.at(-1) as number, 10_000, 5)).toEqual([]);
  });

  it.each<[string, Partial<Omit<ConsumedEventRecord, "position">>, string]>([
    ["an empty event type", { eventType: "" }, "23514:consumed_events_event_type_length"],
    ["an event type of 201 characters", { eventType: "t".repeat(201) }, "23514:consumed_events_event_type_length"],
    ["an event that is not a JSON object", { event: [1, 2] as unknown as Record<string, unknown> }, "23514:consumed_events_event_object"],
  ])("refuses %s", async (_name, overrides, expected) => {
    const tenant = await tenantStore(T(11));

    expect(await violation(tenant.repositories.consumedEvents.append(consumedRecord(100, overrides)))).toBe(expected);
  });

  it("accepts an event type of 200 characters and an event id twice only through ON CONFLICT (a raw duplicate is a unique violation)", async () => {
    const tenant = await tenantStore(T(11));

    expect(await violation(tenant.repositories.consumedEvents.append(consumedRecord(101, { eventType: "t".repeat(200) })))).toBe("none");
    expect(
      await violation(
        pool.query(`INSERT INTO ${schemaOf(T(11))}.consumed_events (event_id, event_type, event, received_at) VALUES ($1, 'x', '{}', $2)`, [consumedRecord(101).eventId, now]),
      ),
    ).toBe("23505:consumed_events_event_id_key");
  });

  it("is append-only: UPDATE, DELETE and TRUNCATE are refused", async () => {
    const tenant = await tenantStore(T(11));
    await tenant.repositories.consumedEvents.append(consumedRecord(102));
    const table = `${schemaOf(T(11))}.consumed_events`;

    for (const statement of [`UPDATE ${table} SET event_type = 'x'`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
      const failure = await failureOf(pool.query(statement));
      expect(failure.code).toBe("23001");
      expect(failure.message).toContain("consumed_events is append-only");
    }
  });

  it("leaves a gap when a transaction rolls back, and a replay still reads every committed row", async () => {
    const tenant = await tenantStore(T(12));
    const first = await tenant.repositories.consumedEvents.append(consumedRecord(200));
    await expect(
      tenant.transaction(async (r) => {
        await r.consumedEvents.append(consumedRecord(201));
        throw new Error("nak after the append");
      }),
    ).rejects.toThrow("nak after the append");
    const third = await tenant.repositories.consumedEvents.append(consumedRecord(202));

    expect(third).toBeGreaterThan((first as number) + 1);
    const { checkpoint } = await tenant.transaction((r) => r.checkpoints.startBuilding(now));
    expect(checkpoint.highWaterPosition).toBe(third);
    const rows = await tenant.repositories.consumedEvents.read(0, checkpoint.highWaterPosition as number, 100);
    expect(rows.map((row) => row.eventId)).toEqual([consumedRecord(200).eventId, consumedRecord(202).eventId]);
  });
});

// ---- The projection repositories -------------------------------------------------------------------------------------

describe("projection repositories", () => {
  it("round-trips a summary with dates and large sums, updates it, and refuses to update a missing one", async () => {
    const tenant = await tenantStore(T(13));
    const summary = summaryOf(marketId(10), { lastPriceYesMicro: 555_000, lastTradeSequence: 4, lastTradeAt: at(9), tradeCount: 3, volumeMicro: 9_000_000_000_000, updatedAt: at(10) });

    expect(await tenant.transaction((r) => r.projections.insertSummary(1, summary))).toBe(true);
    expect(await tenant.repositories.projections.findSummary(1, marketId(10))).toEqual(summary);
    expect(await tenant.repositories.projections.findSummary(2, marketId(10))).toBeNull();
    expect(await tenant.repositories.projections.findSummary(1, "not-a-uuid")).toBeNull();

    const closed = { ...summary, version: 2, status: "closed" as const, closedAt: at(30), updatedAt: at(31) };
    await tenant.transaction((r) => r.projections.updateSummary(1, closed));
    expect(await tenant.repositories.projections.findSummary(1, marketId(10))).toEqual(closed);
    await expect(tenant.transaction((r) => r.projections.updateSummary(1, summaryOf(marketId(11))))).rejects.toThrow("does not exist");
  });

  it("refuses a bigint outside the safe integer range instead of rounding it", async () => {
    const tenant = await tenantStore(T(13));
    await insertRawSummary(T(13), { market_id: marketId(13), volume_micro: "9007199254740993" });

    await expect(tenant.repositories.projections.findSummary(1, marketId(13))).rejects.toThrow("not a safe integer");
  });

  it("locks the summary row with FOR UPDATE: a second writer waits for the first to commit", async () => {
    const tenant = await tenantStore(T(13));
    await tenant.transaction((r) => r.projections.insertSummary(1, summaryOf(marketId(12))).then(() => undefined));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const first = tenant.transaction(async (r) => {
      await r.projections.findSummary(1, marketId(12), { lock: true });
      held = true;
      await gate;
    });
    await waitFor(() => held);

    let secondDone = false;
    const second = tenant.transaction((r) => r.projections.findSummary(1, marketId(12), { lock: true })).then(() => {
      secondDone = true;
    });
    await sleep(300);
    expect(secondDone).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
  });

  it("a tenant's rows are invisible to another tenant", async () => {
    const a = await tenantStore(T(14));
    const b = await tenantStore(T(15));
    await a.transaction((r) => r.projections.insertSummary(1, summaryOf(marketId(20))).then(() => undefined));

    expect(await a.repositories.readModel.summary(marketId(20))).not.toBeNull();
    expect(await b.repositories.readModel.summary(marketId(20))).toBeNull();
    expect(await b.repositories.readModel.summariesOf([marketId(20)])).toEqual([]);
  });

  it("applies a shuffled list of events to a version exactly as foldEvents does (the same handlers, any order, repeats)", async () => {
    const prices = [450_000, 555_000, 500_000, 610_000, 400_000, 520_000];
    const bodies = [
      marketOpenedBody({ marketId: MARKET_1, version: 1 }),
      marketClosedBody({ marketId: MARKET_1, version: 2 }),
      marketResolvedBody({ marketId: MARKET_1, version: 3, outcome: "NO" }),
      ...prices.map((price, index) => tradeExecutedBody({ marketId: MARKET_1, tradeSequence: index + 1, yesPriceMicro: price, costMicro: (index + 1) * 1_000_000 })),
      marketOpenedBody({ marketId: MARKET_2, version: 1, question: "😀".repeat(200), startingPrice: 0.55 }),
      ...[1, 2, 3].map((n) => tradeExecutedBody({ marketId: MARKET_2, tradeSequence: n, yesPriceMicro: 500_000 + n * 10_000 })),
      tradeExecutedBody({ marketId: MARKET_3, tradeSequence: 2, yesPriceMicro: 430_000 }),
      // UC-16: a market resolved INVALID keeps its last price.
      marketOpenedBody({ marketId: marketId(77), version: 1 }),
      tradeExecutedBody({ marketId: marketId(77), tradeSequence: 1, yesPriceMicro: 640_000 }),
      marketResolvedBody({ marketId: marketId(77), version: 3, outcome: "INVALID" }),
    ];
    const events = bodies.map((body) => projectionEvent(body));
    const withRepeat = [...events, events[5] as ProjectionEvent, events[1] as ProjectionEvent];
    const expected = foldEvents(withRepeat, now);

    for (const [index, seed] of [1, 2, 3].entries()) {
      const tenant = await tenantStore(T(30 + index));
      const order = shuffled(withRepeat, seed);
      for (const event of order) await applyLive(tenant, 1, event);

      expect(projectionDifferences(toState(await tenant.repositories.projections.exportVersion(1)), expected)).toEqual([]);
    }
  });

  it("serves the listed markets newest first, by status, in pages, and leaves an unlisted market out", async () => {
    const tenant = await tenantStore(T(17));
    const ids = [30, 31, 32, 33, 34].map(marketId);
    await tenant.transaction(async (r) => {
      for (const [index, id] of ids.entries()) {
        await r.projections.insertSummary(1, summaryOf(id, index % 2 === 0 ? {} : { status: "closed", version: 2, closedAt: at(5) }));
      }
      await r.projections.insertSummary(1, emptySummary(marketId(35), now));
    });
    const { readModel } = tenant.repositories;

    const firstPage = await readModel.listSummaries({ status: null, beforeId: null, limit: 3 });
    expect(firstPage.map((s) => s.marketId)).toEqual([ids[4], ids[3], ids[2]]);
    const secondPage = await readModel.listSummaries({ status: null, beforeId: ids[2] as string, limit: 3 });
    expect(secondPage.map((s) => s.marketId)).toEqual([ids[1], ids[0]]);
    expect((await readModel.listSummaries({ status: "closed", beforeId: null, limit: 10 })).map((s) => s.marketId)).toEqual([ids[3], ids[1]]);
    expect((await readModel.listSummaries({ status: "resolved", beforeId: null, limit: 10 })).length).toBe(0);

    const some = await readModel.summariesOf([ids[1] as string, "not-a-uuid", marketId(35), marketId(99), ids[3] as string]);
    expect(some.map((s) => s.marketId).sort()).toEqual([ids[1], ids[3]]);
    expect(await readModel.summariesOf(["not-a-uuid"])).toEqual([]);
    expect(await readModel.summary(marketId(35))).not.toBeNull();
  });

  it("answers hasPoint and lastPointBefore by time, then sequence, and gives nothing for an id that is no UUID", async () => {
    const tenant = await tenantStore(T(17));
    const id = marketId(40);
    await tenant.transaction(async (r) => {
      await r.projections.insertSummary(1, summaryOf(id));
      await r.projections.insertPoint(1, point(id, 0, at(0), 400_000, 0));
      await r.projections.insertPoint(1, point(id, 1, at(5), 410_000, 1_000_000));
      await r.projections.insertPoint(1, point(id, 2, at(5), 420_000, 1_000_000));
    });
    const { readModel } = tenant.repositories;

    expect(await readModel.hasPoint(id, 2)).toBe(true);
    expect(await readModel.hasPoint(id, 3)).toBe(false);
    expect(await readModel.hasPoint("not-a-uuid", 1)).toBe(false);
    expect((await readModel.lastPointBefore(id, at(6)))?.tradeSequence).toBe(2);
    expect((await readModel.lastPointBefore(id, at(5)))?.tradeSequence).toBe(0);
    expect(await readModel.lastPointBefore(id, at(0))).toBeNull();
    expect(await readModel.lastPointBefore("not-a-uuid", at(6))).toBeNull();
    expect(await readModel.buckets("not-a-uuid", { interval: "1h", from: at(0), to: at(60), limit: 10 })).toEqual([]);
  });

  it("groups the price series in SQL into the same buckets as bucketize, for every interval, edge and page limit", async () => {
    const tenant = await tenantStore(T(18));
    const id = marketId(50);
    const day = new Date("2026-11-01T00:00:00.000Z").getTime();
    const times = [
      day, // opening point on a day boundary
      day + 59_999, // last millisecond of the first minute
      day + 60_000, // first millisecond of the second minute
      day + 4 * 60_000 + 59_999,
      day + 5 * 60_000,
      day + 14 * 60_000 + 59_999,
      day + 15 * 60_000,
      day + 3_599_999,
      day + 3_600_000,
      day + 4 * 3_600_000 - 1,
      day + 4 * 3_600_000,
      day + 86_400_000 - 1, // last millisecond of the day
      day + 86_400_000, // first millisecond of the next day
      day + 86_400_000 + 3_000,
    ];
    const prices = [400_000, 410_000, 405_000, 450_000, 380_000, 390_000, 520_000, 515_000, 530_000, 10_000, 990_000, 555_000, 600_000, 590_000];
    const points: PricePoint[] = times.map((time, index) => point(id, index, new Date(time), prices[index] as number, index === 0 ? 0 : 4_000_000_000_000));
    // Inside one bucket the trade sequence orders the points, not the time: sequence 15 lies in time between 12 and 13.
    points.push(point(id, 15, new Date(day + 86_400_000 + 1_000), 575_000, 1_000_000));
    await tenant.transaction(async (r) => {
      await r.projections.insertSummary(1, summaryOf(id, { openedAt: new Date(day) }));
      for (const p of points) await r.projections.insertPoint(1, p);
    });

    const ranges = [
      { from: new Date(day - 86_400_000), to: new Date(day + 3 * 86_400_000) },
      { from: new Date(day + 60_000), to: new Date(day + 4 * 3_600_000) },
      { from: new Date(day + 5 * 60_000), to: new Date(day + 5 * 60_000 + 1) },
    ];
    for (const interval of Object.keys(INTERVALS) as Interval[]) {
      for (const range of ranges) {
        const inRange = points.filter((p) => p.time >= range.from && p.time < range.to);
        const expected = bucketize(inRange, interval);

        expect(await tenant.repositories.readModel.buckets(id, { interval, ...range, limit: 1000 })).toEqual(expected);
        expect(await tenant.repositories.readModel.buckets(id, { interval, ...range, limit: 2 })).toEqual(expected.slice(0, 2));
      }
    }
    // A sum of several 4 * 10^12 volumes stays an exact integer; the first 1d bucket has trades 1.. 11 and the opening point.
    const [firstDay] = await tenant.repositories.readModel.buckets(id, { interval: "1d", from: new Date(day), to: new Date(day + 86_400_000), limit: 10 });
    expect(firstDay).toMatchObject({ openYesMicro: 400_000, closeYesMicro: 555_000, highYesMicro: 990_000, lowYesMicro: 10_000, trades: 11, volumeMicro: 44_000_000_000_000 });
  });
});

function shuffled<T>(items: readonly T[], seed: number): T[] {
  // mulberry32: a small seeded generator, so a failing order can be run again.
  let state = seed;
  const random = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }
  return result;
}

// ---- Projection versions: start, switch, cleanup ----------------------------------------------------------------------

describe("projection versions", () => {
  it("starts a building version at the high water mark, and a second start resumes it", async () => {
    const tenant = await tenantStore(T(19));
    await tenant.repositories.consumedEvents.append(consumedRecord(300));
    const last = (await tenant.repositories.consumedEvents.append(consumedRecord(301))) as number;

    const started = await tenant.transaction((r) => r.checkpoints.startBuilding(now));
    const again = await tenant.transaction((r) => r.checkpoints.startBuilding(at(5)));

    expect(started.resumed).toBe(false);
    expect(started.rescanned).toBe(false);
    expect(started.checkpoint).toMatchObject({ version: 2, state: "building", highWaterPosition: last, rebuiltThrough: 0, unreadableEvents: 0, createdAt: now, activatedAt: null, retiredAt: null });
    expect(again.resumed).toBe(true);
    expect(again.rescanned).toBe(false);
    expect(again.checkpoint).toEqual(started.checkpoint);
    expect((await tenant.repositories.checkpoints.list()).map((c) => [c.version, c.state])).toEqual([
      [1, "active"],
      [2, "building"],
    ]);
  });

  it("a start continues a clean building version at its progress, and reads one that met unreadable rows again with a new high water mark", async () => {
    const tenant = await tenantStore(T(25));
    await tenant.repositories.consumedEvents.append(consumedRecord(600));
    const first = (await tenant.repositories.consumedEvents.append(consumedRecord(601))) as number;
    await tenant.transaction((r) => r.checkpoints.startBuilding(now));
    await tenant.transaction((r) => r.checkpoints.advance(2, first - 1, 0));

    const clean = await tenant.transaction((r) => r.checkpoints.startBuilding(at(1)));
    expect(clean).toMatchObject({ resumed: true, rescanned: false, checkpoint: { highWaterPosition: first, rebuiltThrough: first - 1, unreadableEvents: 0 } });

    // A row stored after the mark, and one unreadable row counted: the next start resets progress and counter, raises the mark.
    await tenant.transaction((r) => r.checkpoints.advance(2, first, 1));
    const later = (await tenant.repositories.consumedEvents.append(consumedRecord(602))) as number;
    const rescanned = await tenant.transaction((r) => r.checkpoints.startBuilding(at(2)));

    expect(rescanned).toMatchObject({ resumed: true, rescanned: true, checkpoint: { version: 2, state: "building", highWaterPosition: later, rebuiltThrough: 0, unreadableEvents: 0, createdAt: now } });
    expect((await tenant.repositories.checkpoints.list()).map((c) => [c.version, c.state, c.rebuiltThrough, c.unreadableEvents])).toEqual([
      [1, "active", 0, 0],
      [2, "building", 0, 0],
    ]);
    expect((await tenant.transaction((r) => r.checkpoints.startBuilding(at(3)))).rescanned).toBe(false);
  });

  it("two simultaneous starts of a tainted building version both resume it and neither fails", async () => {
    const tenant = await tenantStore(T(26));
    const row = (await tenant.repositories.consumedEvents.append(consumedRecord(610))) as number;
    await tenant.transaction((r) => r.checkpoints.startBuilding(now));
    await tenant.transaction((r) => r.checkpoints.advance(2, row, 2));

    const results = await Promise.all(Array.from({ length: 3 }, () => tenant.transaction((r) => r.checkpoints.startBuilding(now))));

    expect(new Set(results.map((result) => result.checkpoint.version))).toEqual(new Set([2]));
    expect(results.every((result) => result.resumed)).toBe(true);
    expect((await tenant.repositories.checkpoints.list()).filter((c) => c.state === "building")).toHaveLength(1);
  });

  it("starts at high water 0 on an empty tenant", async () => {
    const tenant = await tenantStore(T(20));

    const { checkpoint } = await tenant.transaction((r) => r.checkpoints.startBuilding(now));

    expect(checkpoint).toMatchObject({ version: 2, highWaterPosition: 0 });
  });

  it("two simultaneous starts of one tenant return the same version, exactly one of them new, and neither fails", async () => {
    const tenant = await tenantStore(T(21));
    await tenant.repositories.consumedEvents.append(consumedRecord(400));

    const results = await Promise.all(Array.from({ length: 4 }, () => tenant.transaction((r) => r.checkpoints.startBuilding(now))));

    expect(new Set(results.map((result) => result.checkpoint.version))).toEqual(new Set([2]));
    expect(results.filter((result) => !result.resumed)).toHaveLength(1);
    expect((await tenant.repositories.checkpoints.list()).filter((c) => c.state === "building")).toHaveLength(1);
  });

  it("a start waits for a live transaction that has inserted a row and not committed, and the row is at or below the high water mark", async () => {
    const tenant = await tenantStore(T(22));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let livePosition: number | null = null;
    const live = tenant.transaction(async (r) => {
      livePosition = await r.consumedEvents.append(consumedRecord(500));
      await gate;
      return livePosition as number;
    });
    await waitFor(() => livePosition !== null);

    let started = false;
    const start = tenant.transaction((r) => r.checkpoints.startBuilding(now)).then((result) => {
      started = true;
      return result;
    });
    await sleep(400);
    expect(started).toBe(false);

    release();
    const [position, result] = await Promise.all([live, start]);
    expect(result.checkpoint.highWaterPosition).toBeGreaterThanOrEqual(position);
    expect((await tenant.repositories.consumedEvents.read(0, result.checkpoint.highWaterPosition as number, 10)).map((row) => row.position)).toContain(position);
  });

  it("the projection lock: live transactions share it, a replay batch excludes them, and the lock is per tenant", async () => {
    const a = await tenantStore(T(23));
    const b = await tenantStore(T(24));
    const hold = (tenant: TenantStore, work: (r: TenantRepositories) => Promise<unknown>) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = false;
      const done = tenant.transaction(async (r) => {
        await work(r);
        locked = true;
        await gate;
      });
      return { release, done, isLocked: () => locked };
    };

    // Two live transactions of the same tenant hold the shared lock together.
    const live1 = hold(a, (r) => r.checkpoints.targets());
    const live2 = hold(a, (r) => r.checkpoints.targets());
    await waitFor(() => live1.isLocked() && live2.isLocked());

    // A replay batch waits for both; a live transaction behind it waits for the batch.
    const batch = hold(a, (r) => r.checkpoints.lockForRebuild());
    await sleep(300);
    expect(batch.isLocked()).toBe(false);
    live1.release();
    live2.release();
    await Promise.all([live1.done, live2.done]);
    await waitFor(() => batch.isLocked());

    const behind = hold(a, (r) => r.checkpoints.targets());
    const otherTenant = hold(b, (r) => r.checkpoints.targets());
    await waitFor(() => otherTenant.isLocked());
    await sleep(300);
    expect(behind.isLocked()).toBe(false);

    batch.release();
    await batch.done;
    await waitFor(() => behind.isLocked());
    behind.release();
    otherTenant.release();
    await Promise.all([behind.done, otherTenant.done]);
    expect(PROJECTION_LOCK_CLASS).toBe(19780);
  });

  it("targets() gives the active version, and the building one while a replay runs", async () => {
    const tenant = await tenantStore(T(19));

    expect(await tenant.transaction((r) => r.checkpoints.targets())).toEqual({ active: 1, building: 2 });
    const fresh = await tenantStore(T(1));
    expect(await fresh.transaction((r) => r.checkpoints.targets())).toEqual({ active: 1, building: null });
  });

  it("advance records the progress and adds the unreadable rows; it refuses a version that is not building", async () => {
    const tenant = await tenantStore(T(2));
    await tenant.transaction((r) => r.checkpoints.startBuilding(now));

    await tenant.transaction((r) => r.checkpoints.advance(2, 17, 1));
    await tenant.transaction((r) => r.checkpoints.advance(2, 23, 2));

    expect((await tenant.repositories.checkpoints.list()).find((c) => c.version === 2)).toMatchObject({ rebuiltThrough: 23, unreadableEvents: 3 });
    await expect(tenant.transaction((r) => r.checkpoints.advance(1, 5, 0))).rejects.toThrow("not building");
  });

  it("reads never see a building version; the switch retires the active one and activates the new one in one commit", async () => {
    const tenant = await tenantStore(T(3));
    const id = marketId(60);
    await tenant.transaction(async (r) => {
      await r.projections.insertSummary(1, summaryOf(id, { volumeMicro: 1_000_000 }));
      await r.projections.insertPoint(1, point(id, 0, T0, 400_000, 0));
    });
    await tenant.transaction((r) => r.checkpoints.startBuilding(now));
    await tenant.transaction(async (r) => {
      await r.projections.insertSummary(2, summaryOf(id, { volumeMicro: 2_000_000 }));
      await r.projections.insertPoint(2, point(id, 0, T0, 400_000, 0));
    });

    expect((await tenant.repositories.readModel.summary(id))?.volumeMicro).toBe(1_000_000);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let switched = false;
    const switching = tenant.transaction(async (r) => {
      await r.checkpoints.lockForRebuild();
      expect(await r.checkpoints.activate(2, at(20))).toBe(1);
      switched = true;
      await gate;
    });
    await waitFor(() => switched);
    // The switch is not committed: every read still answers from version 1.
    expect((await tenant.repositories.readModel.summary(id))?.volumeMicro).toBe(1_000_000);
    expect(await tenant.repositories.readModel.hasPoint(id, 0)).toBe(true);

    release();
    await switching;
    expect((await tenant.repositories.readModel.summary(id))?.volumeMicro).toBe(2_000_000);
    expect(await tenant.repositories.checkpoints.list()).toMatchObject([
      { version: 1, state: "retired", retiredAt: at(20) },
      { version: 2, state: "active", activatedAt: at(20), retiredAt: null },
    ]);
    expect(await tenant.transaction((r) => r.checkpoints.targets())).toEqual({ active: 2, building: null });
  });

  it("refuses to activate a version that is not building", async () => {
    const tenant = await tenantStore(T(4));

    await expect(tenant.transaction((r) => r.checkpoints.activate(7, now))).rejects.toThrow("not building");
    // The failed switch rolled back with its transaction: version 1 is still the active one.
    expect((await tenant.repositories.checkpoints.list()).map((c) => [c.version, c.state])).toEqual([[1, "active"]]);
  });

  it("counts a version and finds the markets whose summary or points differ between two versions, ignoring updated_at", async () => {
    const tenant = await tenantStore(T(5));
    const [same, summaryDiffers, pointDiffers, onlyInOld, onlyInNew, extraPoint] = [70, 71, 72, 73, 74, 75].map(marketId) as [string, string, string, string, string, string];
    await tenant.transaction((r) => r.checkpoints.startBuilding(now));
    await tenant.transaction(async (r) => {
      // Three markets that agree in both versions (updated_at differs: it is ignored), one point apart in each version.
      for (const [version, updatedAt] of [[1, at(1)], [2, at(99)]] as const) {
        await r.projections.insertSummary(version, summaryOf(same, { updatedAt }));
        await r.projections.insertPoint(version, point(same, 1, at(2), 450_000, 1_000_000));
        await r.projections.insertSummary(version, summaryOf(pointDiffers, { updatedAt }));
        await r.projections.insertSummary(version, summaryOf(extraPoint, { updatedAt }));
      }
      await r.projections.insertSummary(1, summaryOf(summaryDiffers, { volumeMicro: 1 }));
      await r.projections.insertSummary(2, summaryOf(summaryDiffers, { volumeMicro: 2 }));
      await r.projections.insertPoint(1, point(pointDiffers, 1, at(2), 450_000, 1_000_000));
      await r.projections.insertPoint(2, point(pointDiffers, 1, at(2), 460_000, 1_000_000));
      await r.projections.insertPoint(2, point(extraPoint, 3, at(3), 500_000, 1_000_000));
      await r.projections.insertSummary(1, summaryOf(onlyInOld));
      await r.projections.insertSummary(2, summaryOf(onlyInNew));
    });
    const { projections } = tenant.repositories;
    const differing = [summaryDiffers, pointDiffers, onlyInOld, onlyInNew, extraPoint].sort();

    expect(await projections.countVersion(1)).toEqual({ summaries: 5, points: 2 });
    expect(await projections.countVersion(2)).toEqual({ summaries: 5, points: 3 });
    expect(await projections.compareVersions(1, 2, 100)).toEqual(differing);
    expect(await projections.compareVersions(1, 2, 2)).toEqual(differing.slice(0, 2));
    expect(await projections.compareVersions(1, 1, 100)).toEqual([]);
    expect(await projections.compareVersions(2, 99, 100)).toEqual([same, summaryDiffers, pointDiffers, onlyInNew, extraPoint].sort());
  });

  it("deletes a version in batches, points first, and leaves the other versions alone", async () => {
    const tenant = await tenantStore(T(6));
    const ids = [80, 81, 82].map(marketId);
    await tenant.transaction((r) => r.checkpoints.startBuilding(now));
    await tenant.transaction(async (r) => {
      for (const id of ids) {
        await r.projections.insertSummary(1, summaryOf(id));
        await r.projections.insertPoint(1, point(id, 0, T0, 400_000, 0));
        await r.projections.insertPoint(1, point(id, 1, at(1), 410_000, 1_000_000));
        await r.projections.insertSummary(2, summaryOf(id));
        await r.projections.insertPoint(2, point(id, 0, T0, 400_000, 0));
      }
    });
    const { projections } = tenant.repositories;

    const deleted: number[] = [];
    for (;;) {
      const count = await tenant.transaction((r) => r.projections.deleteVersion(1, 4));
      deleted.push(count);
      if (count === 0) break;
    }

    // 4 points; the last 2 points and 2 summaries; the last summary; nothing left.
    expect(deleted).toEqual([4, 4, 1, 0]);
    expect(await projections.countVersion(1)).toEqual({ summaries: 0, points: 0 });
    expect(await projections.countVersion(2)).toEqual({ summaries: 3, points: 3 });
  });

  it("exports a version ordered by market and sequence", async () => {
    const tenant = await tenantStore(T(7));
    const [a, b] = [90, 91].map(marketId) as [string, string];
    await tenant.transaction(async (r) => {
      await r.projections.insertSummary(1, summaryOf(b));
      await r.projections.insertSummary(1, summaryOf(a));
      await r.projections.insertPoint(1, point(b, 1, at(1), 410_000, 1));
      await r.projections.insertPoint(1, point(a, 2, at(2), 420_000, 1));
      await r.projections.insertPoint(1, point(a, 1, at(1), 410_000, 1));
    });

    const exported = await tenant.repositories.projections.exportVersion(1);

    expect(exported.summaries.map((s) => s.marketId)).toEqual([a, b]);
    expect(exported.points.map((p) => [p.marketId, p.tradeSequence])).toEqual([
      [a, 1],
      [a, 2],
      [b, 1],
    ]);
  });
});

// ---- Shared tables: inbox and parked events ----------------------------------------------------------------------------

describe("the inbox", () => {
  it("records an event once per consumer, and purges the entries older than a time", async () => {
    const { inbox } = store.repositories;
    const entry = { consumer: "market-events", eventId: "00000000-0000-7000-8000-00000000f001", eventType: "si.chance.markets.MarketClosed.v1", processedAt: at(0) };

    expect(await inbox.record(entry)).toBe(true);
    expect(await inbox.record(entry)).toBe(false);
    expect(await inbox.record({ ...entry, consumer: "trade-events" })).toBe(true);
    expect(await inbox.record({ ...entry, eventId: "00000000-0000-7000-8000-00000000f002", processedAt: at(5000) })).toBe(true);

    expect(await inbox.purge(at(100))).toBe(2);
    expect(await inbox.purge(at(100))).toBe(0);
  });

  it("commits the inbox entry with the tenant's rows and rolls both back together", async () => {
    const tenant = await tenantStore(T(8));
    const entry = { consumer: "trade-events", eventId: "00000000-0000-7000-8000-00000000f003", eventType: "si.chance.trading.TradeExecuted.v1", processedAt: at(0) };

    await expect(
      tenant.transaction(async (r) => {
        expect(await r.inbox.record(entry)).toBe(true);
        await r.consumedEvents.append(consumedRecord(600));
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(await store.repositories.inbox.record(entry)).toBe(true);
    expect((await tenant.repositories.consumedEvents.read(0, 100_000, 100)).some((row) => row.eventId === consumedRecord(600).eventId)).toBe(false);
  });
});

describe("parked events", () => {
  const parked = (overrides: Partial<ParkedEvent> = {}): ParkedEvent => ({
    consumer: "market-events",
    streamSequence: 7,
    subject: "chance.markets.MarketClosed.x",
    payload: '{"a":1}',
    reason: "first failure",
    deliveries: 20,
    parkedAt: at(1),
    ...overrides,
  });

  it("parks a message, updates the reason of the same message, and never overwrites a different one under the same sequence", async () => {
    const { parkedEvents } = store.repositories;
    await parkedEvents.park(parked());
    await parkedEvents.park(parked({ reason: "second failure", deliveries: 21, parkedAt: at(2) }));

    expect(await parkedEvents.list("market-events", 10)).toEqual([parked({ reason: "second failure", deliveries: 21, parkedAt: at(2) })]);
    await expect(parkedEvents.park(parked({ payload: '{"b":2}' }))).rejects.toThrow("A different event is already parked");
    expect((await parkedEvents.list("market-events", 10))[0]?.payload).toBe('{"a":1}');
  });

  it("lists the oldest first, one consumer or all, and removes one", async () => {
    const { parkedEvents } = store.repositories;
    await parkedEvents.park(parked({ consumer: "trade-events", streamSequence: 3, parkedAt: at(0) }));
    await parkedEvents.park(parked({ streamSequence: 8, parkedAt: at(3), payload: "text that is not JSON" }));

    expect((await parkedEvents.list(null, 10)).map((p) => [p.consumer, p.streamSequence])).toEqual([
      ["trade-events", 3],
      ["market-events", 7],
      ["market-events", 8],
    ]);
    expect((await parkedEvents.list("trade-events", 10)).map((p) => p.streamSequence)).toEqual([3]);
    expect(await parkedEvents.list(null, 1)).toHaveLength(1);

    await parkedEvents.remove("market-events", 8);
    expect((await parkedEvents.list("market-events", 10)).map((p) => p.streamSequence)).toEqual([7]);
  });

  it("keeps the table's own checks: a stream sequence below 1 and zero deliveries are refused", async () => {
    expect(await violation(store.repositories.parkedEvents.park(parked({ streamSequence: 0 })))).toBe("23514:parked_events_stream_sequence_positive");
    expect(await violation(store.repositories.parkedEvents.park(parked({ streamSequence: 9, deliveries: 0 })))).toBe("23514:parked_events_deliveries_positive");
  });
});
