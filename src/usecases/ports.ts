import type { Bucket, Interval } from "../domain/history.js";
import type { MarketStatus, MarketSummary, PricePoint } from "../domain/projection.js";

// The ports of market-data: what the use cases need from the outside, implemented by the adapters (ADR-001). The
// PostgreSQL adapter keeps one schema per tenant (DM-01) and the shared tables in the schema "shared"; the memory
// adapter keeps the same data in maps and runs one transaction at a time.

/** The roles of a tenant member that may read market data (token contract v2: the group of the token's organization). */
export type MarketDataRole = "trader" | "tenant-admin";

/** A caller of the public API, as the web layer builds it from a verified token. */
export interface Actor {
  userId: string;
  /** The token's organization (the tenant id), lower case; never from the request. */
  tenantId: string;
  role: MarketDataRole;
  correlationId: string;
}

// ---- Projection versions (DM-09, ADR-032, Proposed ADR-058) ----

/**
 * "active": the version every read uses (exactly one). "building": the version a replay is filling (at most one); the
 * live consumer writes into it too. "retired": a version replaced by a rebuild; its rows are deleted after the switch.
 */
export type ProjectionVersionState = "building" | "active" | "retired";

/** One row of projection_checkpoints: a version of the projections (market_summaries and price_points together). */
export interface ProjectionCheckpoint {
  version: number;
  state: ProjectionVersionState;
  /**
   * A building version's target: the highest consumed_events position when the replay started. Every row up to it was
   * committed then (the start held LOCK consumed_events IN EXCLUSIVE MODE), and every later row is written by the live
   * consumer into this version too. Null for version 1 (created by the migration, filled live from the start).
   */
  highWaterPosition: number | null;
  /**
   * The replay's progress: every consumed_events row with position <= it has been read into this version. It is the
   * position of the last row a batch read (positions have gaps), never a count.
   */
  rebuiltThrough: number;
  /**
   * Stored rows of a projection family that the replay's reader could not read ("unreadable"), summed over every batch
   * since the build was last read from the start. While it is above 0 the switch is held unless the operator allows it
   * (ADR-058): such rows may have been applied by the active version under an older reader. A start of the same build
   * with the counter above 0 resets it and the progress (`startBuilding`: the build is read again, the reader may be fixed).
   */
  unreadableEvents: number;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

/** The versions a live event is written into: always the active one, and the building one while a replay runs. */
export interface ProjectionTargets {
  active: number;
  building: number | null;
}

export interface ProjectionCheckpointRepository {
  /**
   * Live consumer, called right AFTER consumedEvents.append in the same transaction and before any projection row is
   * touched: takes the tenant's projection lock in SHARED mode (held to the end of the transaction) and returns the
   * versions to write. Read after the append, so an event either has a position at or below a starting replay's high
   * water mark (the replay applies it) or sees the new building version (the live consumer applies it).
   */
  targets(): Promise<ProjectionTargets>;
  /**
   * First statement of a replay batch and of the switch: takes the tenant's projection lock in EXCLUSIVE mode (live
   * transactions of this tenant wait, and the batch waits for the ones in flight), then returns every checkpoint.
   */
  lockForRebuild(): Promise<ProjectionCheckpoint[]>;
  /** Every version, oldest first (outside a replay: no lock). */
  list(): Promise<ProjectionCheckpoint[]>;
  /**
   * Replay start, in its own short transaction. FIRST takes LOCK consumed_events IN EXCLUSIVE MODE (it waits for the
   * live transactions that inserted rows, and two starts of one tenant serialise on it), THEN reads the building version
   * and returns it when one exists (a replay that stopped, or one starting at the same moment, resumes it), else reads
   * max(position) as the high water mark (0 when empty) and inserts version max(version) + 1 as "building" with
   * rebuiltThrough 0. Checking before the lock would let two starts both insert a building version.
   *
   * A building version that has counted unreadable rows (unreadableEvents above 0: a held switch, or a build stopped after
   * such a row) is not continued but READ AGAIN: under the table lock it is reset to rebuiltThrough 0, unreadableEvents 0
   * and a new high water mark (the highest position now, safe because the lock waited for every inserting transaction),
   * and `rescanned` is true. The reader may
   * have been fixed since, and rows it could not read are neither applied nor remembered, so only a new read recovers
   * them; the new mark also reaches the unreadable rows the live consumer stored after the old one (it counts none). The
   * rows already in the version stay: the rules are idempotent and commute, so applying a row twice changes nothing. A
   * build with no unreadable row is continued where it stopped (`resumed`, not `rescanned`).
   */
  startBuilding(now: Date): Promise<{ checkpoint: ProjectionCheckpoint; resumed: boolean; rescanned: boolean }>;
  /**
   * Replay batch, its last statement: sets rebuiltThrough to the position of the last row the batch read and adds the
   * batch's unreadable rows to unreadableEvents.
   */
  advance(version: number, rebuiltThrough: number, unreadable: number): Promise<void>;
  /**
   * The switch (after lockForRebuild): the active version becomes "retired" (retiredAt), `version` becomes "active"
   * (activatedAt). Returns the retired version.
   */
  activate(version: number, now: Date): Promise<number>;
}

// ---- The replay source (DM-09) ----

/**
 * One stored event (table consumed_events): the whole CloudEvent as it arrived, with its position in this tenant. Every
 * consumed event with a usable envelope is stored, projected or not (readProjectionEvent: a projection event or
 * "unprojected"), so a later reader can replay what this one could not read (DM-09, ADR-058).
 */
export interface ConsumedEventRecord {
  /**
   * bigint identity: increasing in the order of insertion (not necessarily of commit; see
   * ProjectionCheckpoint.highWaterPosition). Positions have GAPS: a rolled-back transaction and an INSERT ... ON CONFLICT
   * DO NOTHING of a stored id use identity values up. Never compute counts or progress from position arithmetic.
   */
  position: number;
  eventId: string;
  /** The CloudEvent type as received (1..200 characters), any type of the two consumers. */
  eventType: string;
  /** The market of a projection event, else data.marketId when it is a UUID, else null. */
  marketId: string | null;
  /** The parsed CloudEvent exactly as consumed (jsonb); readProjectionEvent reads it again during a replay. */
  event: Record<string, unknown>;
  receivedAt: Date;
}

export interface ConsumedEventRepository {
  /** INSERT in the transaction of the event; the new position, or null when the event id is stored (UNIQUE). */
  append(record: Omit<ConsumedEventRecord, "position">): Promise<number | null>;
  /** Rows with after < position <= through, ascending, at most `limit`. */
  read(after: number, through: number, limit: number): Promise<ConsumedEventRecord[]>;
}

// ---- Projections: writes to one version ----

export interface ProjectionRepository {
  /** The summary of a market in `version`; `lock` = SELECT ... FOR UPDATE (taken before the point is inserted). */
  findSummary(version: number, marketId: string, options?: { lock?: boolean }): Promise<MarketSummary | null>;
  /** INSERT ... ON CONFLICT DO NOTHING: false when another transaction created the row first (find with lock and apply again). */
  insertSummary(version: number, summary: MarketSummary): Promise<boolean>;
  updateSummary(version: number, summary: MarketSummary): Promise<void>;
  /** INSERT ... ON CONFLICT (projection_version, market_id, trade_sequence) DO NOTHING: true when the point is new (DM-10). */
  insertPoint(version: number, point: PricePoint): Promise<boolean>;
  /** Replay report: rows of one version. */
  countVersion(version: number): Promise<{ summaries: number; points: number }>;
  /**
   * Replay report: market ids whose summary (updatedAt ignored) or any price point (time, price, volume, or a point that
   * exists in only one version) differs between two versions, sorted, at most `limit`.
   */
  compareVersions(a: number, b: number, limit: number): Promise<string[]>;
  /** Cleanup: deletes up to `limit` rows of a retired version (points first, then summaries); the number deleted. */
  deleteVersion(version: number, limit: number): Promise<number>;
  /** Every summary and point of one version, by market id and sequence (tests and small demos; unbounded). */
  exportVersion(version: number): Promise<{ summaries: MarketSummary[]; points: PricePoint[] }>;
}

// ---- The read model: always the active version ----

/**
 * The reads of the public API. Each method is ONE SQL statement that resolves the active version itself
 * (`projection_version = (SELECT version FROM projection_checkpoints WHERE state = 'active')`), so a read never mixes two
 * versions and never sees a building one, even while a switch commits.
 */
export interface ReadModelRepository {
  /** The summary in the active version (listed or not; the use case filters with isListed). */
  summary(marketId: string): Promise<MarketSummary | null>;
  /** Listed summaries (question known), newest first (market id descending: UUIDv7), status filter optional. */
  listSummaries(page: { status: MarketStatus | null; beforeId: string | null; limit: number }): Promise<MarketSummary[]>;
  /** The listed summaries among `marketIds` (any order; unknown ids are left out). */
  summariesOf(marketIds: readonly string[]): Promise<MarketSummary[]>;
  /** Whether the point of `tradeSequence` exists (DM-17: the caller's trade is in). */
  hasPoint(marketId: string, tradeSequence: number): Promise<boolean>;
  /**
   * Sparse buckets of the points with time in [from, to), ascending, at most `limit` (the use case asks for one more to
   * know whether a next page exists). Must equal bucketize() of those points (PostgreSQL: date_bin, see history.ts).
   */
  buckets(marketId: string, range: { interval: Interval; from: Date; to: Date; limit: number }): Promise<Bucket[]>;
  /** The latest point (by time, then sequence) with time < `before`; null when there is none. */
  lastPointBefore(marketId: string, before: Date): Promise<PricePoint | null>;
}

// ---- Shared tables (schema "shared") ----

export interface InboxEntry {
  /** One consumer per kind of event (ADR-053): "tenant-created", "market-events", "trade-events". */
  consumer: string;
  eventId: string;
  eventType: string;
  processedAt: Date;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING: true when new, false when processed before (REL-02, DM-06). */
  record(entry: InboxEntry): Promise<boolean>;
  purge(olderThan: Date): Promise<number>;
}

export interface TenantRegistry {
  /** As markets and trading: create the schema if missing, apply the tenant migrations, register; idempotent. */
  provision(tenantId: string, now: Date): Promise<void>;
  isRegistered(tenantId: string): Promise<boolean>;
  /** Every registered tenant id, sorted (the replay command, the parked command). */
  list(): Promise<string[]>;
}

/**
 * A consumed event that failed PARK_AFTER_DELIVERIES times in a row (table shared.parked_events, primary key
 * (consumer, stream_sequence)): parked and acked so it cannot hold back the others; `npm run parked` runs it again.
 */
export interface ParkedEvent {
  /** "tenant-created", "market-events" or "trade-events". */
  consumer: string;
  /** The JetStream stream sequence of the message. */
  streamSequence: number;
  subject: string;
  /** The raw message body as UTF-8 text. */
  payload: string;
  /** The last error (message and code), never a token. */
  reason: string;
  deliveries: number;
  parkedAt: Date;
}

export interface ParkedEventRepository {
  /** Upsert while the stored payload is the same message; a different message under that key rejects (never overwrites). */
  park(event: ParkedEvent): Promise<void>;
  /** Oldest first. */
  list(consumer: string | null, limit: number): Promise<ParkedEvent[]>;
  remove(consumer: string, streamSequence: number): Promise<void>;
}

export interface SharedRepositories {
  inbox: InboxRepository;
  tenants: TenantRegistry;
  parkedEvents: ParkedEventRepository;
}

/** The repositories of one tenant: its own schema's tables and the shared ones, in the same transaction. */
export interface TenantRepositories extends SharedRepositories {
  consumedEvents: ConsumedEventRepository;
  checkpoints: ProjectionCheckpointRepository;
  projections: ProjectionRepository;
  readModel: ReadModelRepository;
}

export interface TenantStore {
  readonly tenantId: string;
  /** Repositories outside a transaction: each call is on its own (the reads of the public API). */
  readonly repositories: TenantRepositories;
  /** Everything the callback does through the given repositories commits together or not at all. */
  transaction<T>(work: (repositories: TenantRepositories) => Promise<T>): Promise<T>;
}

export interface Store {
  readonly repositories: SharedRepositories;
  transaction<T>(work: (repositories: SharedRepositories) => Promise<T>): Promise<T>;
  /** The store of a registered tenant, or null while its TenantCreated has not been processed (TenantNotReady, 503). */
  forTenant(tenantId: string): Promise<TenantStore | null>;
  /**
   * The store of the tenant, provisioning its schema first when it is not registered yet (the TenantCreated work, under
   * the migrator's lock). Only for tenant ids from trusted publishers (markets' and trading's events), never from a user
   * token, so a tenant created before market-data's TENANTS consumer existed (TENANTS keeps 30 days by default) is never stuck.
   */
  ensureTenant(tenantId: string, now: Date): Promise<TenantStore>;
  ping(): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
}

/** The history limits that may change while the service runs (runtime configuration, ADR-037). */
export interface HistoryRules {
  /** HISTORY_MAX_POINTS: the most buckets one history range may span (HISTORY_MAX_POINTS_MIN .. HISTORY_MAX_POINTS_LIMIT). */
  maxPoints: number;
  /** HISTORY_ENABLED: false answers 503 history_paused (shed the heaviest read under load; the UI shows "chart unavailable"). */
  enabled: boolean;
}

export interface HistoryRulesSource {
  current(): HistoryRules;
}

/** What the use cases need. */
export interface UseCaseDeps {
  store: Store;
  clock: Clock;
  logger: Logger;
}

/**
 * What the projection consumer reports after each event, once its transaction has committed (the metrics; optional). A
 * rolled-back event is not reported: the broker redelivers it. `tradeSequenceGap` is set for a trade that changed the
 * active projection: the trades of the market with a lower sequence that the projection has not seen yet.
 */
export interface ProjectionObserver {
  recorded: (result: "applied" | "stale" | "unprojected" | "duplicate", tradeSequenceGap: number | null) => void;
}

/** The history use case also reads the runtime rules. */
export interface ReadDeps extends UseCaseDeps {
  rules: HistoryRulesSource;
}
