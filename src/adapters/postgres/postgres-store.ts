import pg from "pg";
import { INTERVALS } from "../../domain/history.js";
import type { Bucket } from "../../domain/history.js";
import type { MarketStatus, MarketSummary, PricePoint } from "../../domain/projection.js";
import { isTenantId, parseTenantId, tenantSchemaIdentifier, tenantSchemaName } from "../../domain/tenant.js";
import type { Outcome } from "../../domain/units.js";
import type {
  ConsumedEventRecord,
  ConsumedEventRepository,
  InboxRepository,
  Logger,
  ParkedEvent,
  ParkedEventRepository,
  ProjectionCheckpoint,
  ProjectionCheckpointRepository,
  ProjectionRepository,
  ProjectionVersionState,
  ReadModelRepository,
  SharedRepositories,
  Store,
  TenantRegistry,
  TenantRepositories,
  TenantStore,
} from "../../usecases/ports.js";
import { provisionTenantSchema } from "./migrate.js";

type Queryable = Pick<pg.Pool, "query">;

// The first of the two integers of the projection lock (PostgreSQL's two-int advisory key space): the second is
// hashtext(<tenant schema name>), so each tenant has its own lock. The migrator's key (migrate.ts) is a single bigint,
// a different key space. Live transactions take the lock in shared mode, replay batches and the switch in exclusive
// mode (ADR-058, spec "Projection versions and the replay").
export const PROJECTION_LOCK_CLASS = 19780;

/** Longest error text kept in a row: an error message is not allowed to grow a row without limit. */
const MAX_ERROR_LENGTH = 2000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

// Shared tables are always written with the prefix "shared."; the tables of a tenant with the quoted schema name that
// tenantSchemaIdentifier (domain/tenant.ts) makes from the validated tenant id, never from request text.

/**
 * bigint and numeric columns come back from pg as strings: a safe integer or a failure, never a silently rounded number.
 * (All quantities are micro-units that the domain keeps below 2^53, so a value outside that range is corruption.)
 */
function toNumber(value: string | number, what: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${what} is not a safe integer: ${String(value)}`);
  return result;
}

const toNullableNumber = (value: string | number | null, what: string): number | null => (value === null ? null : toNumber(value, what));

/** A value that is no UUID cannot be an id: callers answer "not found" instead of letting the driver raise a type error. */
const onlyUuids = (ids: readonly string[]): string[] => ids.filter((id) => UUID_PATTERN.test(id)).map((id) => id.toLowerCase());

// ---- Inbox -----------------------------------------------------------------------------------------------------------

function inboxRepository(db: Queryable): InboxRepository {
  return {
    async record(entry) {
      const result = await db.query(
        "INSERT INTO shared.inbox (consumer, event_id, event_type, processed_at) VALUES ($1, $2, $3, $4) ON CONFLICT (consumer, event_id) DO NOTHING",
        [entry.consumer, entry.eventId, entry.eventType, entry.processedAt],
      );
      return result.rowCount === 1;
    },
    async purge(olderThan) {
      const result = await db.query("DELETE FROM shared.inbox WHERE processed_at < $1", [olderThan]);
      return result.rowCount ?? 0;
    },
  };
}

// ---- Tenant registry -------------------------------------------------------------------------------------------------

/**
 * `provision` needs a connection that is inside a transaction (`inTransaction`): its advisory lock and its DDL belong to
 * that transaction. Over the pool it refuses, because each statement would run on another connection.
 */
function tenantRegistry(db: Queryable, inTransaction: boolean, logger: Logger): TenantRegistry {
  return {
    async provision(tenantId, now) {
      if (!inTransaction) throw new Error("A tenant schema is provisioned inside a transaction only");
      await provisionTenantSchema(db, tenantId, now, logger);
    },
    async isRegistered(tenantId) {
      if (!isTenantId(tenantId)) return false;
      const result = await db.query("SELECT 1 FROM shared.tenant_registry WHERE tenant_id = $1", [tenantId.toLowerCase()]);
      return (result.rowCount ?? 0) > 0;
    },
    async list() {
      const result = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM shared.tenant_registry ORDER BY tenant_id");
      return result.rows.map((row) => row.tenant_id);
    },
  };
}

// ---- Parked events ---------------------------------------------------------------------------------------------------

interface ParkedDbRow {
  consumer: string;
  stream_sequence: string;
  subject: string;
  payload: string;
  reason: string;
  deliveries: number;
  parked_at: Date;
}

const toParkedEvent = (row: ParkedDbRow): ParkedEvent => ({
  consumer: row.consumer,
  streamSequence: toNumber(row.stream_sequence, "stream_sequence"),
  subject: row.subject,
  payload: row.payload,
  reason: row.reason,
  deliveries: row.deliveries,
  parkedAt: row.parked_at,
});

function parkedEventRepository(db: Queryable): ParkedEventRepository {
  return {
    async park(event) {
      // The same message parked again (a crash between park and ack, a failed rerun) keeps its row with the new reason.
      // A different message under the same stream sequence (the stream was deleted and created again, so sequences
      // restart at 1) never replaces the parked one: the update does not match, nothing is written and the call fails,
      // so the message is not acknowledged and is delivered again.
      const result = await db.query(
        `INSERT INTO shared.parked_events (consumer, stream_sequence, subject, payload, reason, deliveries, parked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (consumer, stream_sequence)
         DO UPDATE SET reason = EXCLUDED.reason, deliveries = EXCLUDED.deliveries, parked_at = EXCLUDED.parked_at
         WHERE shared.parked_events.payload = EXCLUDED.payload`,
        [event.consumer, event.streamSequence, event.subject, event.payload, event.reason.slice(0, MAX_ERROR_LENGTH), event.deliveries, event.parkedAt],
      );
      if (result.rowCount === 0) throw new Error(`A different event is already parked under ${event.consumer} #${String(event.streamSequence)}; handle it first (npm run parked)`);
    },
    async list(consumer, limit) {
      const result = await db.query<ParkedDbRow>(
        `SELECT consumer, stream_sequence, subject, payload, reason, deliveries, parked_at
           FROM shared.parked_events
          WHERE ($1::text IS NULL OR consumer = $1)
          ORDER BY parked_at, consumer, stream_sequence
          LIMIT $2`,
        [consumer, limit],
      );
      return result.rows.map(toParkedEvent);
    },
    async remove(consumer, streamSequence) {
      await db.query("DELETE FROM shared.parked_events WHERE consumer = $1 AND stream_sequence = $2", [consumer, streamSequence]);
    },
  };
}

// ---- The tables of one tenant ----------------------------------------------------------------------------------------

interface Tables {
  /** The raw schema name (tenant_<32 hex>): the key of the projection lock. */
  schemaName: string;
  checkpoints: string;
  consumedEvents: string;
  summaries: string;
  points: string;
}

function tablesOf(tenantId: string): Tables {
  const schema = tenantSchemaIdentifier(tenantId);
  return {
    schemaName: tenantSchemaName(tenantId),
    checkpoints: `${schema}.projection_checkpoints`,
    consumedEvents: `${schema}.consumed_events`,
    summaries: `${schema}.market_summaries`,
    points: `${schema}.price_points`,
  };
}

/** Every read resolves the active version inside its own statement, so it never mixes two versions (spec "Projection versions"). */
const activeVersion = (tables: Tables): string => `(SELECT version FROM ${tables.checkpoints} WHERE state = 'active')`;

// ---- Projection checkpoints and the projection lock ------------------------------------------------------------------

interface CheckpointDbRow {
  version: number;
  state: ProjectionVersionState;
  high_water_position: string | null;
  rebuilt_through: string;
  unreadable_events: string;
  created_at: Date;
  activated_at: Date | null;
  retired_at: Date | null;
}

const CHECKPOINT_COLUMNS = "version, state, high_water_position, rebuilt_through, unreadable_events, created_at, activated_at, retired_at";

const toCheckpoint = (row: CheckpointDbRow): ProjectionCheckpoint => ({
  version: row.version,
  state: row.state,
  highWaterPosition: toNullableNumber(row.high_water_position, "high_water_position"),
  rebuiltThrough: toNumber(row.rebuilt_through, "rebuilt_through"),
  unreadableEvents: toNumber(row.unreadable_events, "unreadable_events"),
  createdAt: row.created_at,
  activatedAt: row.activated_at,
  retiredAt: row.retired_at,
});

/**
 * The tenant's projection lock, in its OWN statement: a statement's snapshot is taken before it waits for a lock, so the
 * checkpoints must be read by a later statement to see what the holder of the exclusive lock committed. The lock belongs
 * to the transaction, so these calls refuse to run outside one (each statement of the pool is a transaction of its own
 * and would release it at once).
 */
async function takeProjectionLock(db: Queryable, tables: Tables, mode: "shared" | "exclusive"): Promise<void> {
  const fn = mode === "shared" ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock";
  await db.query(`SELECT ${fn}($1::int, hashtext($2::text))`, [PROJECTION_LOCK_CLASS, tables.schemaName]);
}

function checkpointRepository(db: Queryable, inTransaction: boolean, tenantId: string): ProjectionCheckpointRepository {
  const tables = tablesOf(tenantId);
  const needTransaction = (what: string): void => {
    if (!inTransaction) throw new Error(`${what} runs inside a transaction only: its lock belongs to the transaction`);
  };
  return {
    async targets() {
      needTransaction("targets");
      await takeProjectionLock(db, tables, "shared");
      const result = await db.query<{ version: number; state: ProjectionVersionState }>(
        `SELECT version, state FROM ${tables.checkpoints} WHERE state IN ('active', 'building')`,
      );
      const active = result.rows.find((row) => row.state === "active");
      if (!active) throw new Error("The tenant has no active projection version");
      const building = result.rows.find((row) => row.state === "building");
      return { active: active.version, building: building?.version ?? null };
    },
    async lockForRebuild() {
      needTransaction("lockForRebuild");
      await takeProjectionLock(db, tables, "exclusive");
      const result = await db.query<CheckpointDbRow>(`SELECT ${CHECKPOINT_COLUMNS} FROM ${tables.checkpoints} ORDER BY version`);
      return result.rows.map(toCheckpoint);
    },
    async list() {
      const result = await db.query<CheckpointDbRow>(`SELECT ${CHECKPOINT_COLUMNS} FROM ${tables.checkpoints} ORDER BY version`);
      return result.rows.map(toCheckpoint);
    },
    async startBuilding(now) {
      needTransaction("startBuilding");
      // The table lock FIRST, in its own statement: it waits for the live transactions that have inserted a row, so every
      // row up to the high water mark is committed, and two starts of one tenant serialise here. Looking for a building
      // version before the lock would let two simultaneous starts both insert one (ADR-058).
      await db.query(`LOCK TABLE ${tables.consumedEvents} IN EXCLUSIVE MODE`);
      // A building version that counted unreadable rows (a held switch) is read again from the start: the reader may have
      // been fixed, and an unreadable row is neither applied nor remembered, so only a new read recovers it. The new high
      // water mark is safe for the same reason as a fresh one: the table lock waited for every transaction that inserted a
      // row, so every row up to max(position) is committed; it also reaches unreadable rows the live consumer stored after
      // the old mark (it counts none). The rows already in the version stay: the rules are idempotent and commute.
      const rescanned = await db.query<CheckpointDbRow>(
        `UPDATE ${tables.checkpoints}
            SET rebuilt_through = 0, unreadable_events = 0, high_water_position = (SELECT coalesce(max(position), 0) FROM ${tables.consumedEvents})
          WHERE state = 'building' AND unreadable_events > 0
          RETURNING ${CHECKPOINT_COLUMNS}`,
      );
      const reset = rescanned.rows[0];
      if (reset) return { checkpoint: toCheckpoint(reset), resumed: true, rescanned: true };
      const existing = await db.query<CheckpointDbRow>(`SELECT ${CHECKPOINT_COLUMNS} FROM ${tables.checkpoints} WHERE state = 'building'`);
      const found = existing.rows[0];
      if (found) return { checkpoint: toCheckpoint(found), resumed: true, rescanned: false };
      const inserted = await db.query<CheckpointDbRow>(
        `INSERT INTO ${tables.checkpoints} (version, state, high_water_position, rebuilt_through, unreadable_events, created_at)
         SELECT coalesce(max(version), 0) + 1, 'building', (SELECT coalesce(max(position), 0) FROM ${tables.consumedEvents}), 0, 0, $1::timestamptz
           FROM ${tables.checkpoints}
         RETURNING ${CHECKPOINT_COLUMNS}`,
        [now],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("The building projection version was not inserted");
      return { checkpoint: toCheckpoint(row), resumed: false, rescanned: false };
    },
    async advance(version, rebuiltThrough, unreadable) {
      const result = await db.query(
        `UPDATE ${tables.checkpoints} SET rebuilt_through = $2, unreadable_events = unreadable_events + $3 WHERE version = $1 AND state = 'building'`,
        [version, rebuiltThrough, unreadable],
      );
      if (result.rowCount !== 1) throw new Error(`Projection version ${String(version)} is not building and cannot advance`);
    },
    async activate(version, now) {
      // Two statements in this order: the partial unique index allows one active row, so the old one is retired first.
      const retired = await db.query<{ version: number }>(
        `UPDATE ${tables.checkpoints} SET state = 'retired', retired_at = $1 WHERE state = 'active' RETURNING version`,
        [now],
      );
      const old = retired.rows[0];
      if (retired.rowCount !== 1 || !old) throw new Error("The tenant has no single active projection version to retire");
      const activated = await db.query(`UPDATE ${tables.checkpoints} SET state = 'active', activated_at = $2 WHERE version = $1 AND state = 'building'`, [version, now]);
      if (activated.rowCount !== 1) throw new Error(`Projection version ${String(version)} is not building and cannot be activated`);
      return old.version;
    },
  };
}

// ---- consumed_events -------------------------------------------------------------------------------------------------

interface ConsumedDbRow {
  position: string;
  event_id: string;
  event_type: string;
  market_id: string | null;
  event: Record<string, unknown>;
  received_at: Date;
}

const toConsumedRecord = (row: ConsumedDbRow): ConsumedEventRecord => ({
  position: toNumber(row.position, "position"),
  eventId: row.event_id,
  eventType: row.event_type,
  marketId: row.market_id,
  event: row.event,
  receivedAt: row.received_at,
});

function consumedEventRepository(db: Queryable, tenantId: string): ConsumedEventRepository {
  const tables = tablesOf(tenantId);
  return {
    async append(record) {
      const result = await db.query<{ position: string }>(
        `INSERT INTO ${tables.consumedEvents} (event_id, event_type, market_id, event, received_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING position`,
        [record.eventId, record.eventType, record.marketId, JSON.stringify(record.event), record.receivedAt],
      );
      const row = result.rows[0];
      return row ? toNumber(row.position, "position") : null;
    },
    async read(after, through, limit) {
      const result = await db.query<ConsumedDbRow>(
        `SELECT position, event_id, event_type, market_id, event, received_at
           FROM ${tables.consumedEvents}
          WHERE position > $1 AND position <= $2
          ORDER BY position
          LIMIT $3`,
        [after, through, limit],
      );
      return result.rows.map(toConsumedRecord);
    },
  };
}

// ---- Summaries and price points --------------------------------------------------------------------------------------

interface SummaryDbRow {
  market_id: string;
  market_version: number;
  status: MarketStatus | null;
  question: string | null;
  close_time: Date | null;
  starting_price_yes_micro: number | null;
  opened_at: Date | null;
  closed_at: Date | null;
  resolved_at: Date | null;
  outcome: Outcome | null;
  last_price_yes_micro: number | null;
  last_trade_sequence: string;
  last_trade_at: Date | null;
  trade_count: string;
  volume_micro: string;
  updated_at: Date;
}

const SUMMARY_COLUMNS =
  "market_id, market_version, status, question, close_time, starting_price_yes_micro, opened_at, closed_at, resolved_at, outcome, last_price_yes_micro, last_trade_sequence, last_trade_at, trade_count, volume_micro, updated_at";

const toSummary = (row: SummaryDbRow): MarketSummary => ({
  marketId: row.market_id,
  version: row.market_version,
  status: row.status,
  question: row.question,
  closeTime: row.close_time,
  startingPriceYesMicro: row.starting_price_yes_micro,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  resolvedAt: row.resolved_at,
  outcome: row.outcome,
  lastPriceYesMicro: row.last_price_yes_micro,
  lastTradeSequence: toNumber(row.last_trade_sequence, "last_trade_sequence"),
  lastTradeAt: row.last_trade_at,
  tradeCount: toNumber(row.trade_count, "trade_count"),
  volumeMicro: toNumber(row.volume_micro, "volume_micro"),
  updatedAt: row.updated_at,
});

interface PointDbRow {
  market_id: string;
  trade_sequence: string;
  time: Date;
  price_yes_micro: number;
  volume_micro: string;
}

const POINT_COLUMNS = 'market_id, trade_sequence, "time", price_yes_micro, volume_micro';

const toPoint = (row: PointDbRow): PricePoint => ({
  marketId: row.market_id,
  tradeSequence: toNumber(row.trade_sequence, "trade_sequence"),
  time: row.time,
  priceYesMicro: row.price_yes_micro,
  volumeMicro: toNumber(row.volume_micro, "volume_micro"),
});

/** The columns of a summary that two versions are compared on: everything but the keys and updated_at. */
const COMPARED_SUMMARY_COLUMNS = [
  "market_version",
  "status",
  "question",
  "close_time",
  "starting_price_yes_micro",
  "opened_at",
  "closed_at",
  "resolved_at",
  "outcome",
  "last_price_yes_micro",
  "last_trade_sequence",
  "last_trade_at",
  "trade_count",
  "volume_micro",
];

const rowOf = (alias: string, columns: readonly string[]): string => `ROW(${columns.map((column) => `${alias}.${column}`).join(", ")})`;

function projectionRepository(db: Queryable, tenantId: string): ProjectionRepository {
  const tables = tablesOf(tenantId);
  const summaryParameters = (version: number, s: MarketSummary): unknown[] => [
    version,
    s.marketId,
    s.version,
    s.status,
    s.question,
    s.closeTime,
    s.startingPriceYesMicro,
    s.openedAt,
    s.closedAt,
    s.resolvedAt,
    s.outcome,
    s.lastPriceYesMicro,
    s.lastTradeSequence,
    s.lastTradeAt,
    s.tradeCount,
    s.volumeMicro,
    s.updatedAt,
  ];
  return {
    async findSummary(version, marketId, options = {}) {
      if (!UUID_PATTERN.test(marketId)) return null;
      const result = await db.query<SummaryDbRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM ${tables.summaries} WHERE projection_version = $1 AND market_id = $2${options.lock === true ? " FOR UPDATE" : ""}`,
        [version, marketId.toLowerCase()],
      );
      const row = result.rows[0];
      return row ? toSummary(row) : null;
    },
    async insertSummary(version, summary) {
      // DO NOTHING instead of a unique violation: a transaction that waited for the other one's commit gets "false" and reads again.
      const result = await db.query(
        `INSERT INTO ${tables.summaries} (projection_version, ${SUMMARY_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (projection_version, market_id) DO NOTHING`,
        summaryParameters(version, summary),
      );
      return result.rowCount === 1;
    },
    async updateSummary(version, summary) {
      const result = await db.query(
        `UPDATE ${tables.summaries}
            SET market_version = $3, status = $4, question = $5, close_time = $6, starting_price_yes_micro = $7, opened_at = $8,
                closed_at = $9, resolved_at = $10, outcome = $11, last_price_yes_micro = $12, last_trade_sequence = $13,
                last_trade_at = $14, trade_count = $15, volume_micro = $16, updated_at = $17
          WHERE projection_version = $1 AND market_id = $2`,
        summaryParameters(version, summary),
      );
      if (result.rowCount !== 1) throw new Error(`The summary of market ${summary.marketId} in projection version ${String(version)} does not exist`);
    },
    async insertPoint(version, point) {
      const result = await db.query(
        `INSERT INTO ${tables.points} (projection_version, market_id, trade_sequence, "time", price_yes_micro, volume_micro)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (projection_version, market_id, trade_sequence) DO NOTHING`,
        [version, point.marketId, point.tradeSequence, point.time, point.priceYesMicro, point.volumeMicro],
      );
      return result.rowCount === 1;
    },
    async countVersion(version) {
      const result = await db.query<{ summaries: string; points: string }>(
        `SELECT (SELECT count(*) FROM ${tables.summaries} WHERE projection_version = $1) AS summaries,
                (SELECT count(*) FROM ${tables.points} WHERE projection_version = $1) AS points`,
        [version],
      );
      const row = result.rows[0];
      if (!row) throw new Error("A count returned no row");
      return { summaries: toNumber(row.summaries, "summaries"), points: toNumber(row.points, "points") };
    },
    async compareVersions(a, b, limit) {
      // One statement. A FULL JOIN per table, so a row that exists in one version only is as different as a changed one;
      // IS DISTINCT FROM on the row values makes NULL equal NULL. updated_at is left out: it records when a row was
      // written, which differs between a replay and live.
      const result = await db.query<{ market_id: string }>(
        `SELECT market_id FROM (
           SELECT coalesce(x.market_id, y.market_id) AS market_id
             FROM (SELECT * FROM ${tables.summaries} WHERE projection_version = $1) x
             FULL JOIN (SELECT * FROM ${tables.summaries} WHERE projection_version = $2) y ON x.market_id = y.market_id
            WHERE ${rowOf("x", COMPARED_SUMMARY_COLUMNS)} IS DISTINCT FROM ${rowOf("y", COMPARED_SUMMARY_COLUMNS)}
           UNION
           SELECT coalesce(x.market_id, y.market_id)
             FROM (SELECT * FROM ${tables.points} WHERE projection_version = $1) x
             FULL JOIN (SELECT * FROM ${tables.points} WHERE projection_version = $2) y
               ON x.market_id = y.market_id AND x.trade_sequence = y.trade_sequence
            WHERE ${rowOf("x", ['"time"', "price_yes_micro", "volume_micro"])} IS DISTINCT FROM ${rowOf("y", ['"time"', "price_yes_micro", "volume_micro"])}
         ) differing
         ORDER BY market_id
         LIMIT $3`,
        [a, b, limit],
      );
      return result.rows.map((row) => row.market_id);
    },
    async deleteVersion(version, limit) {
      // The points first: their foreign key names the summaries, and the summaries are deleted only once no point is left
      // (a first statement that deleted fewer than `limit` rows has emptied the table of this version).
      const points = await db.query(`DELETE FROM ${tables.points} WHERE ctid = ANY (ARRAY(SELECT ctid FROM ${tables.points} WHERE projection_version = $1 LIMIT $2))`, [
        version,
        limit,
      ]);
      const deletedPoints = points.rowCount ?? 0;
      if (deletedPoints >= limit) return deletedPoints;
      const summaries = await db.query(
        `DELETE FROM ${tables.summaries} WHERE ctid = ANY (ARRAY(SELECT ctid FROM ${tables.summaries} WHERE projection_version = $1 LIMIT $2))`,
        [version, limit - deletedPoints],
      );
      return deletedPoints + (summaries.rowCount ?? 0);
    },
    async exportVersion(version) {
      const summaries = await db.query<SummaryDbRow>(`SELECT ${SUMMARY_COLUMNS} FROM ${tables.summaries} WHERE projection_version = $1 ORDER BY market_id`, [version]);
      const points = await db.query<PointDbRow>(`SELECT ${POINT_COLUMNS} FROM ${tables.points} WHERE projection_version = $1 ORDER BY market_id, trade_sequence`, [version]);
      return { summaries: summaries.rows.map(toSummary), points: points.rows.map(toPoint) };
    },
  };
}

// ---- The read model: always the active version -----------------------------------------------------------------------

interface BucketDbRow {
  start: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: string;
  trades: string;
}

function readModelRepository(db: Queryable, tenantId: string): ReadModelRepository {
  const tables = tablesOf(tenantId);
  const active = activeVersion(tables);
  return {
    async summary(marketId) {
      if (!UUID_PATTERN.test(marketId)) return null;
      const result = await db.query<SummaryDbRow>(`SELECT ${SUMMARY_COLUMNS} FROM ${tables.summaries} WHERE projection_version = ${active} AND market_id = $1`, [
        marketId.toLowerCase(),
      ]);
      const row = result.rows[0];
      return row ? toSummary(row) : null;
    },
    async listSummaries(page) {
      // Built per call instead of "$1 IS NULL OR ...": the partial indexes of the list are used only when the filter is
      // in the statement. Market ids (UUIDv7) sort newest first.
      const params: unknown[] = [];
      let where = `projection_version = ${active} AND question IS NOT NULL`;
      if (page.status !== null) {
        params.push(page.status);
        where += ` AND status = $${String(params.length)}`;
      }
      if (page.beforeId !== null) {
        params.push(page.beforeId.toLowerCase());
        where += ` AND market_id < $${String(params.length)}::uuid`;
      }
      params.push(page.limit);
      const result = await db.query<SummaryDbRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM ${tables.summaries} WHERE ${where} ORDER BY market_id DESC LIMIT $${String(params.length)}`,
        params,
      );
      return result.rows.map(toSummary);
    },
    async summariesOf(marketIds) {
      const ids = onlyUuids(marketIds);
      if (ids.length === 0) return [];
      const result = await db.query<SummaryDbRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM ${tables.summaries} WHERE projection_version = ${active} AND question IS NOT NULL AND market_id = ANY($1::uuid[])`,
        [ids],
      );
      return result.rows.map(toSummary);
    },
    async hasPoint(marketId, tradeSequence) {
      if (!UUID_PATTERN.test(marketId)) return false;
      const result = await db.query<{ found: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${tables.points} WHERE projection_version = ${active} AND market_id = $1 AND trade_sequence = $2) AS found`,
        [marketId.toLowerCase(), tradeSequence],
      );
      return result.rows[0]?.found === true;
    },
    async buckets(marketId, range) {
      if (!UUID_PATTERN.test(marketId)) return [];
      // date_bin aligns the buckets to the Unix epoch in UTC, as bucketStart() does (history.ts); the stride is whole seconds.
      const stride = `${String(INTERVALS[range.interval] / 1000)} seconds`;
      const result = await db.query<BucketDbRow>(
        `SELECT date_bin($2::interval, "time", TIMESTAMPTZ '1970-01-01 00:00:00+00') AS start,
                (array_agg(price_yes_micro ORDER BY trade_sequence))[1] AS open,
                max(price_yes_micro) AS high,
                min(price_yes_micro) AS low,
                (array_agg(price_yes_micro ORDER BY trade_sequence DESC))[1] AS close,
                sum(volume_micro) AS volume,
                count(*) FILTER (WHERE trade_sequence > 0) AS trades
           FROM ${tables.points}
          WHERE projection_version = ${active} AND market_id = $1 AND "time" >= $3 AND "time" < $4
          GROUP BY 1
          ORDER BY 1
          LIMIT $5`,
        [marketId.toLowerCase(), stride, range.from, range.to, range.limit],
      );
      return result.rows.map(
        (row): Bucket => ({
          start: row.start,
          openYesMicro: row.open,
          highYesMicro: row.high,
          lowYesMicro: row.low,
          closeYesMicro: row.close,
          volumeMicro: toNumber(row.volume, "volume"),
          trades: toNumber(row.trades, "trades"),
        }),
      );
    },
    async lastPointBefore(marketId, before) {
      if (!UUID_PATTERN.test(marketId)) return null;
      const result = await db.query<PointDbRow>(
        `SELECT ${POINT_COLUMNS} FROM ${tables.points}
          WHERE projection_version = ${active} AND market_id = $1 AND "time" < $2
          ORDER BY "time" DESC, trade_sequence DESC
          LIMIT 1`,
        [marketId.toLowerCase(), before],
      );
      const row = result.rows[0];
      return row ? toPoint(row) : null;
    },
  };
}

// ---- The store -------------------------------------------------------------------------------------------------------

/** The shared repositories over one connection (inside a transaction) or over the pool (each call on its own). */
export function sharedRepositoriesOver(db: Queryable, inTransaction: boolean, logger: Logger): SharedRepositories {
  return {
    inbox: inboxRepository(db),
    tenants: tenantRegistry(db, inTransaction, logger),
    parkedEvents: parkedEventRepository(db),
  };
}

function tenantRepositoriesOver(db: Queryable, inTransaction: boolean, tenantId: string, logger: Logger): TenantRepositories {
  return {
    ...sharedRepositoriesOver(db, inTransaction, logger),
    consumedEvents: consumedEventRepository(db, tenantId),
    checkpoints: checkpointRepository(db, inTransaction, tenantId),
    projections: projectionRepository(db, tenantId),
    readModel: readModelRepository(db, tenantId),
  };
}

export class PostgresStore implements Store {
  readonly repositories: SharedRepositories;
  /** Tenants known to be registered: a registration is never undone, so a positive answer is kept. */
  private readonly registered = new Set<string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger = silent,
  ) {
    this.repositories = sharedRepositoriesOver(pool, false, logger);
  }

  /** One transaction on one connection: BEGIN, the work, COMMIT; ROLLBACK when the work throws. */
  private async inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  transaction<T>(work: (repositories: SharedRepositories) => Promise<T>): Promise<T> {
    return this.inTransaction((client) => work(sharedRepositoriesOver(client, true, this.logger)));
  }

  private tenantStore(id: string): TenantStore {
    return {
      tenantId: id,
      repositories: tenantRepositoriesOver(this.pool, false, id, this.logger),
      transaction: (work) => this.inTransaction((client) => work(tenantRepositoriesOver(client, true, id, this.logger))),
    };
  }

  async forTenant(tenantId: string): Promise<TenantStore | null> {
    if (!isTenantId(tenantId)) return null;
    const id = tenantId.toLowerCase();
    if (!this.registered.has(id)) {
      if (!(await this.repositories.tenants.isRegistered(id))) return null;
      this.registered.add(id);
    }
    return this.tenantStore(id);
  }

  async ensureTenant(tenantId: string, now: Date): Promise<TenantStore> {
    const id = parseTenantId(tenantId);
    const existing = await this.forTenant(id);
    if (existing) return existing;
    // The same idempotent work as TenantCreated, under the migrator's advisory lock: schema, migrations, registry row.
    await this.inTransaction((client) => provisionTenantSchema(client, id, now, this.logger));
    this.registered.add(id);
    return this.tenantStore(id);
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}

/**
 * The connection pool. An idle connection that the server drops raises "error" on the pool; without a listener that
 * would end the process, so it is logged (when a logger is given) and the pool opens a new connection when needed.
 */
export function createPool(connectionString: string, max: number, logger: Logger = silent): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30_000 });
  pool.on("error", (error) => {
    logger.warn({ err: error }, "An idle database connection failed");
  });
  return pool;
}
