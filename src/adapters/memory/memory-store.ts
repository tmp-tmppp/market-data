import { EVENT_TYPE_MAX_LENGTH, QUESTION_MAX_LENGTH, questionLength } from "../../domain/consumed.js";
import { bucketize } from "../../domain/history.js";
import { emptyProjection, isListed, isMarketStatus, pointKey, projectionDifferences } from "../../domain/projection.js";
import type { MarketSummary, PricePoint, ProjectionState } from "../../domain/projection.js";
import { isMicroQuantity, isOutcome, isPriceMicro, isYesPriceMicro } from "../../domain/units.js";
import type {
  ConsumedEventRecord,
  InboxEntry,
  Logger,
  ParkedEvent,
  ProjectionCheckpoint,
  ProjectionCheckpointRepository,
  ConsumedEventRepository,
  ProjectionRepository,
  ReadModelRepository,
  SharedRepositories,
  Store,
  TenantRepositories,
  TenantStore,
} from "../../usecases/ports.js";

// The in-memory store of market-data: for unit tests and for local runs without a database (APP_ENV=local). It keeps the
// same data as the PostgreSQL schema (DM-01: one set of tables per tenant) and enforces what the schema's constraints
// enforce, so a use case that breaks one fails here first: the CHECKs of market_summaries, price_points and
// projection_checkpoints, the unique event id of consumed_events and the deferred foreign key of a price point.

/** The tables of one tenant's schema. Projection versions are kept in the shape the domain folds events into. */
interface TenantData {
  consumedEvents: ConsumedEventRecord[];
  checkpoints: ProjectionCheckpoint[];
  versions: Map<number, ProjectionState>;
}

interface State {
  tenants: string[];
  inbox: InboxEntry[];
  parked: ParkedEvent[];
  tenantData: Record<string, TenantData>;
}

/** A deep copy of everything the store holds, as the PostgreSQL tables would, for assertions in tests. */
export interface MemorySnapshot {
  /** The tenant registry. */
  tenants: string[];
  /** shared.inbox. */
  inbox: InboxEntry[];
  /** shared.parked_events. */
  parked: ParkedEvent[];
  tenantData: Record<
    string,
    {
      consumedEvents: ConsumedEventRecord[];
      checkpoints: ProjectionCheckpoint[];
      /** By projection version: the rows of market_summaries and price_points, sorted by market id and sequence. */
      versions: Record<number, { summaries: MarketSummary[]; points: PricePoint[] }>;
    }
  >;
}

/**
 * Test hooks. A test sets them on `store.hooks` to play what real concurrency does: change the clock inside a replay
 * batch, fail a transaction at a chosen step, or record a live event between two replay batches.
 */
export interface MemoryHooks {
  /**
   * Called before every repository operation, also inside a transaction, with a name such as "consumedEvents.read" or
   * "checkpoints.advance" and the tenant (null for the shared tables). Synchronous: it must not use the store (the
   * transaction owns it); it may advance a clock, or throw to fail the operation and so the whole transaction.
   */
  onOperation?: (operation: string, tenantId: string | null) => void;
  /**
   * Called after a transaction committed, outside the store's queue, so the hook may use the store: this is "between two
   * batches" of a replay. `operations` are the repository operations the transaction ran, in order.
   */
  afterCommit?: (commit: { tenantId: string | null; operations: readonly string[] }) => Promise<void> | void;
}

/** How a repository reaches the data and runs one operation: on the live data (queued) or on a transaction's draft. */
interface Access {
  state: () => State;
  run: <T>(operation: () => T) => Promise<T>;
  observe: (operation: string, tenantId: string | null) => void;
  /** Checks PostgreSQL defers to the commit (the price point's foreign key); outside a transaction they run at once. */
  deferred: (check: () => void) => void;
  /** The next consumed_events position of the tenant (an identity: used up even when the transaction rolls back). */
  nextPosition: (tenantId: string) => number;
}

const emptyState = (): State => ({ tenants: [], inbox: [], parked: [], tenantData: {} });

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function tenantData(state: State, tenantId: string): TenantData {
  const data = state.tenantData[tenantId];
  if (!data) throw new Error(`The tenant ${tenantId} has no schema`);
  return data;
}

/** What the migration does for a new tenant: projection version 1 is created active, filled live from the start. */
function newTenantData(now: Date): TenantData {
  const first: ProjectionCheckpoint = { version: 1, state: "active", highWaterPosition: null, rebuiltThrough: 0, unreadableEvents: 0, createdAt: new Date(now), activatedAt: new Date(now), retiredAt: null };
  return { consumedEvents: [], checkpoints: [first], versions: new Map([[1, emptyProjection()]]) };
}

function sharedRepositories({ state, run, observe }: Access): SharedRepositories {
  const op = <T>(name: string, operation: () => T): Promise<T> =>
    run(() => {
      observe(name, null);
      return operation();
    });
  return {
    inbox: {
      // INSERT ... ON CONFLICT DO NOTHING: the primary key is (consumer, event id).
      record: (entry) =>
        op("inbox.record", () => {
          const rows = state().inbox;
          if (rows.some((row) => row.consumer === entry.consumer && row.eventId === entry.eventId)) return false;
          rows.push({ ...entry });
          return true;
        }),
      purge: (olderThan) =>
        op("inbox.purge", () => {
          const rows = state().inbox;
          const kept = rows.filter((row) => row.processedAt.getTime() >= olderThan.getTime());
          const purged = rows.length - kept.length;
          rows.splice(0, rows.length, ...kept);
          return purged;
        }),
    },
    tenants: {
      provision: (tenantId, now) =>
        op("tenants.provision", () => {
          const current = state();
          if (!current.tenants.includes(tenantId)) current.tenants.push(tenantId);
          current.tenantData[tenantId] ??= newTenantData(now);
        }),
      isRegistered: (tenantId) => op("tenants.isRegistered", () => state().tenants.includes(tenantId)),
      list: () => op("tenants.list", () => [...state().tenants].sort(compare)),
    },
    parkedEvents: {
      // INSERT ... ON CONFLICT (consumer, stream_sequence) DO UPDATE reason, deliveries, parked_at WHERE the payload is
      // the same; a different message under that key fails and changes nothing.
      park: (event) =>
        op("parkedEvents.park", () => {
          const rows = state().parked;
          const index = rows.findIndex((row) => row.consumer === event.consumer && row.streamSequence === event.streamSequence);
          const existing = rows[index];
          if (existing === undefined) rows.push({ ...event });
          else if (existing.payload !== event.payload) throw new Error(`A different event is already parked under ${event.consumer} #${String(event.streamSequence)}; handle it first (npm run parked)`);
          else rows[index] = { ...existing, reason: event.reason, deliveries: event.deliveries, parkedAt: event.parkedAt };
        }),
      list: (consumer, limit) =>
        op("parkedEvents.list", () =>
          state()
            .parked.filter((row) => consumer === null || row.consumer === consumer)
            .sort((a, b) => a.parkedAt.getTime() - b.parkedAt.getTime() || a.streamSequence - b.streamSequence)
            .slice(0, limit)
            .map((row) => structuredClone(row)),
        ),
      remove: (consumer, streamSequence) =>
        op("parkedEvents.remove", () => {
          const rows = state().parked;
          const kept = rows.filter((row) => !(row.consumer === consumer && row.streamSequence === streamSequence));
          rows.splice(0, rows.length, ...kept);
        }),
    },
  };
}

function consumedEventRepository(tenantId: string, { state, run, observe, nextPosition }: Access): ConsumedEventRepository {
  const op = <T>(name: string, operation: () => T): Promise<T> =>
    run(() => {
      observe(name, tenantId);
      return operation();
    });
  return {
    append: (record) =>
      op("consumedEvents.append", () => {
        // The CHECK of event_type and the UNIQUE event id (INSERT ... ON CONFLICT DO NOTHING RETURNING position).
        if (record.eventType.length < 1 || record.eventType.length > EVENT_TYPE_MAX_LENGTH) throw new Error(`consumed_events: event_type must have 1 to ${EVENT_TYPE_MAX_LENGTH} characters`);
        const rows = tenantData(state(), tenantId).consumedEvents;
        if (rows.some((row) => row.eventId === record.eventId)) return null;
        // PostgreSQL's identity also moves on for a conflicting insert; this store lets only a rolled-back transaction (or
        // burnPositions) leave a gap, which is all the replay has to cope with.
        const position = nextPosition(tenantId);
        rows.push({ ...structuredClone(record), position });
        return position;
      }),
    read: (after, through, limit) =>
      op("consumedEvents.read", () =>
        structuredClone(
          tenantData(state(), tenantId)
            .consumedEvents.filter((row) => row.position > after && row.position <= through)
            .sort((a, b) => a.position - b.position)
            .slice(0, limit),
        ),
      ),
  };
}

function checkpointRepository(tenantId: string, { state, run, observe }: Access): ProjectionCheckpointRepository {
  const op = <T>(name: string, operation: () => T): Promise<T> =>
    run(() => {
      observe(name, tenantId);
      return operation();
    });
  const own = (): TenantData => tenantData(state(), tenantId);
  const ordered = (): ProjectionCheckpoint[] => [...own().checkpoints].sort((a, b) => a.version - b.version).map((row) => structuredClone(row));
  const find = (version: number): ProjectionCheckpoint => {
    const row = own().checkpoints.find((candidate) => candidate.version === version);
    if (!row) throw new Error(`Projection version ${version} has no checkpoint`);
    return row;
  };
  return {
    // One transaction runs at a time, so the "shared lock" is free here; the versions are read after the append, as the port says.
    targets: () =>
      op("checkpoints.targets", () => {
        const rows = own().checkpoints;
        const active = rows.find((row) => row.state === "active");
        if (!active) throw new Error("The tenant has no active projection version");
        return { active: active.version, building: rows.find((row) => row.state === "building")?.version ?? null };
      }),
    lockForRebuild: () => op("checkpoints.lockForRebuild", ordered),
    list: () => op("checkpoints.list", ordered),
    startBuilding: (now) =>
      op("checkpoints.startBuilding", () => {
        const data = own();
        const highestPosition = (): number => data.consumedEvents.reduce((max, row) => Math.max(max, row.position), 0);
        const building = data.checkpoints.find((row) => row.state === "building");
        if (building) {
          // A build that met unreadable rows is read again from the start with a new mark (the port says why); the rows
          // already in the version stay, applying them twice changes nothing.
          const rescanned = building.unreadableEvents > 0;
          if (rescanned) {
            building.rebuiltThrough = 0;
            building.unreadableEvents = 0;
            building.highWaterPosition = highestPosition();
          }
          return { checkpoint: structuredClone(building), resumed: true, rescanned };
        }
        const highWater = highestPosition();
        const version = data.checkpoints.reduce((max, row) => Math.max(max, row.version), 0) + 1;
        const created: ProjectionCheckpoint = { version, state: "building", highWaterPosition: highWater, rebuiltThrough: 0, unreadableEvents: 0, createdAt: new Date(now), activatedAt: null, retiredAt: null };
        data.checkpoints.push(created);
        data.versions.set(version, emptyProjection());
        return { checkpoint: structuredClone(created), resumed: false, rescanned: false };
      }),
    advance: (version, rebuiltThrough, unreadable) =>
      op("checkpoints.advance", () => {
        const row = find(version);
        if (row.state !== "building") throw new Error(`Projection version ${version} is ${row.state}, not building`);
        if (!Number.isSafeInteger(rebuiltThrough) || rebuiltThrough < 0 || !Number.isSafeInteger(unreadable) || unreadable < 0) throw new Error("advance: the position and the count must be non-negative integers");
        row.rebuiltThrough = rebuiltThrough;
        row.unreadableEvents += unreadable;
      }),
    activate: (version, now) =>
      op("checkpoints.activate", () => {
        const rows = own().checkpoints;
        const next = find(version);
        const active = rows.find((row) => row.state === "active");
        if (next.state !== "building") throw new Error(`Projection version ${version} is ${next.state}, not building`);
        if (!active) throw new Error("The tenant has no active projection version");
        // Two statements in this order (retire, then activate): the unique partial index allows one active row.
        active.state = "retired";
        active.retiredAt = new Date(now);
        next.state = "active";
        next.activatedAt = new Date(now);
        return active.version;
      }),
  };
}

/** The CHECKs of market_summaries. */
function checkSummary(summary: MarketSummary): void {
  const fail = (what: string): never => {
    throw new Error(`market_summaries ${summary.marketId}: ${what}`);
  };
  if (!Number.isSafeInteger(summary.version) || summary.version < 0) fail("market_version must be 0 or more");
  if (summary.status !== null && !isMarketStatus(summary.status)) fail("status must be open, closed or resolved");
  if (summary.outcome !== null && !isOutcome(summary.outcome)) fail("outcome must be YES, NO or INVALID");
  if (summary.question !== null && (questionLength(summary.question) < 1 || questionLength(summary.question) > QUESTION_MAX_LENGTH)) fail("question must have 1 to 200 characters");
  if (summary.startingPriceYesMicro !== null && !isPriceMicro(summary.startingPriceYesMicro)) fail("starting_price_yes_micro is not on the grid");
  if (summary.lastPriceYesMicro !== null && !isYesPriceMicro(summary.lastPriceYesMicro)) fail("last_price_yes_micro must be 10000 to 990000");
  if (!Number.isSafeInteger(summary.lastTradeSequence) || summary.lastTradeSequence < 0) fail("last_trade_sequence must be 0 or more");
  if (!isMicroQuantity(summary.tradeCount) || !isMicroQuantity(summary.volumeMicro)) fail("trade_count and volume_micro must be 0 or more");
  if ((summary.version === 0) !== (summary.status === null)) fail("a status is set exactly when the version is above 0");
  if ((summary.outcome !== null) !== (summary.status === "resolved")) fail("an outcome is set exactly when the market is resolved");
  if ((summary.tradeCount === 0) !== (summary.lastPriceYesMicro === null)) fail("a last price is set exactly when a trade was seen");
  if ((summary.lastTradeSequence === 0) !== (summary.lastTradeAt === null)) fail("a last trade time is set exactly when a trade was seen");
  if (summary.tradeCount > summary.lastTradeSequence) fail("trade_count cannot exceed last_trade_sequence");
  if (summary.question !== null && (summary.closeTime === null || summary.startingPriceYesMicro === null || summary.openedAt === null)) fail("a question needs the opening facts");
}

/** The CHECKs of price_points. */
function checkPoint(point: PricePoint): void {
  const fail = (what: string): never => {
    throw new Error(`price_points ${point.marketId}/${point.tradeSequence}: ${what}`);
  };
  if (!Number.isSafeInteger(point.tradeSequence) || point.tradeSequence < 0) fail("trade_sequence must be 0 or more");
  if (!isYesPriceMicro(point.priceYesMicro)) fail("price_yes_micro must be 10000 to 990000");
  if (!isMicroQuantity(point.volumeMicro)) fail("volume_micro must be 0 or more");
  if (point.tradeSequence === 0 && point.volumeMicro !== 0) fail("the opening point has no volume");
}

function projectionRepository(tenantId: string, { state, run, observe, deferred }: Access): ProjectionRepository {
  const op = <T>(name: string, operation: () => T): Promise<T> =>
    run(() => {
      observe(name, tenantId);
      return operation();
    });
  /** The rows of a version; the version must have a checkpoint (the foreign key of every projection row). */
  const rows = (version: number): ProjectionState => {
    const data = tenantData(state(), tenantId);
    if (!data.checkpoints.some((row) => row.version === version)) throw new Error(`Projection version ${version} has no checkpoint`);
    // Created together with the checkpoint (provisioning, startBuilding): a checkpoint without rows is a bug of this store.
    const projection = data.versions.get(version);
    if (!projection) throw new Error(`Projection version ${version} has a checkpoint but no rows table`);
    return projection;
  };
  return {
    findSummary: (version, marketId) => op("projections.findSummary", () => structuredClone(rows(version).summaries.get(marketId) ?? null)),
    insertSummary: (version, summary) =>
      op("projections.insertSummary", () => {
        checkSummary(summary);
        const summaries = rows(version).summaries;
        if (summaries.has(summary.marketId)) return false;
        summaries.set(summary.marketId, structuredClone(summary));
        return true;
      }),
    updateSummary: (version, summary) =>
      op("projections.updateSummary", () => {
        checkSummary(summary);
        const summaries = rows(version).summaries;
        if (!summaries.has(summary.marketId)) throw new Error(`The market ${summary.marketId} has no summary in version ${version} to update`);
        summaries.set(summary.marketId, structuredClone(summary));
      }),
    insertPoint: (version, point) =>
      op("projections.insertPoint", () => {
        checkPoint(point);
        const projection = rows(version);
        const key = pointKey(point.marketId, point.tradeSequence);
        if (projection.points.has(key)) return false;
        projection.points.set(key, structuredClone(point));
        // FOREIGN KEY (projection_version, market_id) ... DEFERRABLE INITIALLY DEFERRED: checked at the commit.
        deferred(() => {
          if (!rows(version).summaries.has(point.marketId)) throw new Error(`price_points: the market ${point.marketId} has no summary in version ${version} at the commit`);
        });
        return true;
      }),
    countVersion: (version) =>
      op("projections.countVersion", () => {
        const projection = rows(version);
        return { summaries: projection.summaries.size, points: projection.points.size };
      }),
    compareVersions: (a, b, limit) => op("projections.compareVersions", () => projectionDifferences(rows(a), rows(b)).slice(0, limit)),
    deleteVersion: (version, limit) =>
      op("projections.deleteVersion", () => {
        const projection = rows(version);
        let deleted = 0;
        // Points first, then summaries (the foreign key), at most `limit` rows in all.
        for (const key of [...projection.points.keys()]) {
          if (deleted >= limit) return deleted;
          projection.points.delete(key);
          deleted += 1;
        }
        for (const key of [...projection.summaries.keys()]) {
          if (deleted >= limit) return deleted;
          projection.summaries.delete(key);
          deleted += 1;
        }
        return deleted;
      }),
    exportVersion: (version) =>
      op("projections.exportVersion", () => {
        const projection = rows(version);
        return {
          summaries: [...projection.summaries.values()].sort((a, b) => compare(a.marketId, b.marketId)).map((row) => structuredClone(row)),
          points: [...projection.points.values()].sort((a, b) => compare(a.marketId, b.marketId) || a.tradeSequence - b.tradeSequence).map((row) => structuredClone(row)),
        };
      }),
  };
}

function readModelRepository(tenantId: string, { state, run, observe }: Access): ReadModelRepository {
  const op = <T>(name: string, operation: () => T): Promise<T> =>
    run(() => {
      observe(name, tenantId);
      return operation();
    });
  /**
   * The active version, resolved inside the one call: a read never mixes two versions and never sees a building one.
   * Nothing here awaits between resolving the version and reading it.
   */
  const active = (): ProjectionState => {
    const data = tenantData(state(), tenantId);
    const checkpoint = data.checkpoints.find((row) => row.state === "active");
    const projection = checkpoint === undefined ? undefined : data.versions.get(checkpoint.version);
    if (!projection) throw new Error("The tenant has no active projection version");
    return projection;
  };
  const pointsOf = (marketId: string): PricePoint[] => [...active().points.values()].filter((point) => point.marketId === marketId);
  return {
    summary: (marketId) => op("readModel.summary", () => structuredClone(active().summaries.get(marketId) ?? null)),
    // Listed summaries only, market id descending (lower-case UUID text sorts as the uuid bytes do), after `beforeId`.
    listSummaries: (page) =>
      op("readModel.listSummaries", () =>
        [...active().summaries.values()]
          .filter((row) => isListed(row) && (page.status === null || row.status === page.status) && (page.beforeId === null || row.marketId < page.beforeId))
          .sort((a, b) => compare(b.marketId, a.marketId))
          .slice(0, page.limit)
          .map((row) => structuredClone(row)),
      ),
    summariesOf: (marketIds) =>
      op("readModel.summariesOf", () => {
        const wanted = new Set(marketIds);
        return [...active().summaries.values()]
          .filter((row) => wanted.has(row.marketId) && isListed(row))
          .sort((a, b) => compare(a.marketId, b.marketId))
          .map((row) => structuredClone(row));
      }),
    hasPoint: (marketId, tradeSequence) => op("readModel.hasPoint", () => active().points.has(pointKey(marketId, tradeSequence))),
    buckets: (marketId, range) =>
      op("readModel.buckets", () => {
        const inRange = pointsOf(marketId).filter((point) => point.time.getTime() >= range.from.getTime() && point.time.getTime() < range.to.getTime());
        return structuredClone(bucketize(inRange, range.interval).slice(0, range.limit));
      }),
    lastPointBefore: (marketId, before) =>
      op("readModel.lastPointBefore", () => {
        const earlier = pointsOf(marketId)
          .filter((point) => point.time.getTime() < before.getTime())
          .sort((a, b) => b.time.getTime() - a.time.getTime() || b.tradeSequence - a.tradeSequence);
        return structuredClone(earlier[0] ?? null);
      }),
  };
}

function tenantRepositories(tenantId: string, access: Access): TenantRepositories {
  return {
    ...sharedRepositories(access),
    consumedEvents: consumedEventRepository(tenantId, access),
    checkpoints: checkpointRepository(tenantId, access),
    projections: projectionRepository(tenantId, access),
    readModel: readModelRepository(tenantId, access),
  };
}

/**
 * In-memory store for unit tests and for local runs without a database. A transaction works on a copy of the data and
 * replaces it on success, so a failed transaction leaves nothing behind (its inbox entry, consumed event and projection
 * rows vanish together); transactions run one by one, and a call outside a transaction waits for the one in progress. Do
 * not call a repository method of the store itself from inside a transaction callback: use the callback's own
 * repositories, or the call waits for the transaction that waits for it. Writes belong in transactions; a call outside
 * one changes the live data at once, with no rollback.
 *
 * The projection lock of PostgreSQL needs no work here: one transaction runs at a time, which is the strongest case of
 * "the live consumer and a replay batch exclude each other". The interleavings that matter (a live event between two
 * batches, a batch that ends at its time budget, a rolled-back transaction that leaves a gap in the positions) are
 * played through `hooks` and `burnPositions`.
 *
 * With `autoProvision` (local runs only, APP_ENV=local) a tenant is registered on its first use, so that local
 * development needs no TenantCreated event; the default is off, and an unknown tenant answers null (HTTP 503).
 */
export class MemoryStore implements Store {
  private state: State = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly autoProvision: boolean;
  private readonly logger: Logger | undefined;
  /** The identity counters of consumed_events.position, outside the transactional state: a rollback does not return a value. */
  private readonly positions = new Map<string, number>();
  readonly hooks: MemoryHooks = {};

  constructor(options: { autoProvision?: boolean; logger?: Logger } = {}) {
    this.autoProvision = options.autoProvision ?? false;
    this.logger = options.logger;
  }

  private readonly live: Access = {
    state: () => this.state,
    run: (operation) => this.exclusive(operation),
    observe: (operation, tenantId) => this.hooks.onOperation?.(operation, tenantId),
    deferred: (check) => {
      check();
    },
    nextPosition: (tenantId) => this.takePosition(tenantId),
  };

  readonly repositories: SharedRepositories = sharedRepositories(this.live);

  transaction<T>(work: (repositories: SharedRepositories) => Promise<T>): Promise<T> {
    return this.inTransaction(null, (access) => work(sharedRepositories(access)));
  }

  async forTenant(tenantId: string): Promise<TenantStore | null> {
    const registered = await this.exclusive(() => {
      if (this.state.tenants.includes(tenantId)) return true;
      if (!this.autoProvision) return false;
      this.provisionNow(tenantId, new Date());
      return "provisioned" as const;
    });
    if (registered === false) return null;
    if (registered === "provisioned") this.logger?.info({ tenantId }, "APP_ENV=local: tenant provisioned on first use");
    return this.tenantStore(tenantId);
  }

  async ensureTenant(tenantId: string, now: Date = new Date()): Promise<TenantStore> {
    await this.exclusive(() => this.provisionNow(tenantId, now));
    return this.tenantStore(tenantId);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  /** A deep copy of everything stored, for assertions in tests. */
  snapshot(): MemorySnapshot {
    const tenantDataCopy: MemorySnapshot["tenantData"] = {};
    for (const [tenantId, data] of Object.entries(this.state.tenantData)) {
      const versions: Record<number, { summaries: MarketSummary[]; points: PricePoint[] }> = {};
      for (const [version, projection] of data.versions) {
        versions[version] = {
          summaries: [...projection.summaries.values()].sort((a, b) => compare(a.marketId, b.marketId)).map((row) => structuredClone(row)),
          points: [...projection.points.values()].sort((a, b) => compare(a.marketId, b.marketId) || a.tradeSequence - b.tradeSequence).map((row) => structuredClone(row)),
        };
      }
      tenantDataCopy[tenantId] = {
        consumedEvents: structuredClone(data.consumedEvents),
        checkpoints: structuredClone([...data.checkpoints].sort((a, b) => a.version - b.version)),
        versions,
      };
    }
    return structuredClone({ tenants: this.state.tenants, inbox: this.state.inbox, parked: this.state.parked, tenantData: tenantDataCopy });
  }

  /** Test hook: uses `count` positions of the tenant up, as rolled-back inserts do in PostgreSQL (positions have gaps). */
  burnPositions(tenantId: string, count = 1): void {
    this.positions.set(tenantId, (this.positions.get(tenantId) ?? 0) + count);
  }

  private takePosition(tenantId: string): number {
    const next = (this.positions.get(tenantId) ?? 0) + 1;
    this.positions.set(tenantId, next);
    return next;
  }

  private provisionNow(tenantId: string, now: Date): void {
    if (!this.state.tenants.includes(tenantId)) this.state.tenants.push(tenantId);
    this.state.tenantData[tenantId] ??= newTenantData(now);
  }

  private tenantStore(tenantId: string): TenantStore {
    return {
      tenantId,
      repositories: tenantRepositories(tenantId, this.live),
      transaction: (work) => this.inTransaction(tenantId, (access) => work(tenantRepositories(tenantId, access))),
    };
  }

  private inTransaction<T>(tenantId: string | null, work: (access: Access) => Promise<T>): Promise<T> {
    const operations: string[] = [];
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const checks: Array<() => void> = [];
      // Inside a transaction an operation runs at once (the queue is already ours); a throw becomes a rejection.
      const result = await work({
        state: () => draft,
        run: <R>(operation: () => R) => new Promise<R>((resolve) => resolve(operation())),
        observe: (operation, tenant) => {
          operations.push(operation);
          this.hooks.onOperation?.(operation, tenant);
        },
        deferred: (check) => {
          checks.push(check);
        },
        nextPosition: (tenant) => this.takePosition(tenant),
      });
      for (const check of checks) check();
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run.then(async (result) => {
      await this.hooks.afterCommit?.({ tenantId, operations });
      return result;
    });
  }

  private exclusive<T>(operation: () => T): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
