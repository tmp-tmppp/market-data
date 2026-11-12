import type { ConsumedEvent } from "../domain/consumed.js";
import type { Bucket, Interval } from "../domain/history.js";
import type { MarketStatus } from "../domain/projection.js";
import type { TenantCreatedNotice } from "../domain/tenant.js";
import type { Outcome } from "../domain/units.js";
import type { Actor } from "./ports.js";
import type { PageOf } from "./support.js";

// The use cases of market-data as interfaces: the web layer, the consumers and the commands depend on these, and the
// classes in src/usecases/*.ts implement them. Every input comes from a validated transport (the web layer has already
// refused platform admins, tokens without a tenant and tokens without a tenant role); the use cases check the rest.

/** A market as the public API shows it (contracts/openapi.yaml, schema Market); only listed summaries become one. */
export interface MarketView {
  marketId: string;
  question: string;
  status: MarketStatus;
  closeTime: Date;
  openedAt: Date;
  closedAt: Date | null;
  resolvedAt: Date | null;
  outcome: Outcome | null;
  startingPriceYesMicro: number;
  /** Null until the first trade. */
  lastPriceYesMicro: number | null;
  /** currentPriceYesMicro() of the domain: the final price once resolved, else the last trade's, else the starting price. */
  currentPriceYesMicro: number;
  volumeMicro: number;
  tradeCount: number;
  lastTradeSequence: number;
  lastTradeAt: Date | null;
  /** markets' version of the market (DM-04). */
  version: number;
  updatedAt: Date;
}

/**
 * GET /v1/market-data/markets. Either a page (`status`, `limit`, `cursor`) or one batch of ids (`ids`, DM-12: the
 * portfolio page asks for the prices of its positions in one call); both together is a ValidationFailed.
 */
export interface ListMarketsInput {
  actor: Actor;
  status?: MarketStatus;
  limit?: number;
  cursor?: string;
  /** The comma-separated `ids` query, split by the web layer; checked here (UUIDs, 1..MAX_IDS, duplicates collapsed). */
  ids?: readonly string[];
}

export interface ListMarketsUseCase {
  execute(input: ListMarketsInput): Promise<PageOf<MarketView>>;
}

export interface GetMarketInput {
  actor: Actor;
  marketId: string;
  /** DM-17: answer Updating (409) until the trade with this sequence is in the read model. */
  afterSequence?: number;
}

export interface GetMarketUseCase {
  execute(input: GetMarketInput): Promise<MarketView>;
}

export interface HistoryInput {
  actor: Actor;
  marketId: string;
  /** One of INTERVALS' keys; default DEFAULT_INTERVAL. */
  interval?: string;
  from?: Date;
  to?: Date;
  /** Buckets per page: 1..MAX_HISTORY_PAGE_SIZE, default DEFAULT_HISTORY_PAGE_SIZE. */
  limit?: number;
  cursor?: string;
  afterSequence?: number;
}

/** GET /v1/market-data/markets/{id}/history (contracts/openapi.yaml, schema History). */
export interface HistoryView {
  marketId: string;
  interval: Interval;
  /** The range (historyRange): `from` is a bucket start. */
  from: Date;
  to: Date;
  /** The YES price of the latest point before this page's first bucket start; null when there is none. */
  previousCloseYesMicro: number | null;
  /** Sparse, ascending. */
  buckets: Bucket[];
  nextCursor: string | null;
}

export interface GetHistoryUseCase {
  execute(input: HistoryInput): Promise<HistoryView>;
}

export type ProvisionResult = "provisioned" | "duplicate";

/** TenantCreated: creates and migrates the tenant's schema (as markets and trading), inbox in the same transaction. */
export interface ProvisionTenantUseCase {
  execute(notice: TenantCreatedNotice): Promise<ProvisionResult>;
}

/**
 * "applied": the event changed the active version (or filled facts); "stale": it was stored in consumed_events but
 * changed nothing (a repeated sequence, an older version with nothing to fill); "unprojected": stored in consumed_events
 * and not projected (another type, or one this reader cannot read: a later replay may project it); "duplicate": the
 * inbox or consumed_events had its id.
 */
export type RecordResult = "applied" | "stale" | "unprojected" | "duplicate";

export interface RecordProjectionEventInput {
  /** What readProjectionEvent read from `raw`: a projection event or an unprojected one (unattributable never comes here). */
  event: ConsumedEvent;
  /** The parsed CloudEvent as it arrived: stored unchanged in consumed_events, the replay source (DM-09). */
  raw: Record<string, unknown>;
}

/**
 * One consumed event from the MARKETS or the TRADING consumer, in one transaction of its tenant (ensureTenant): inbox,
 * consumed_events, then, for a projection event only, the projection lock (targets) and every target version. An
 * unprojected event takes no projection lock. See the layout for the order.
 */
export interface RecordProjectionEventUseCase {
  execute(input: RecordProjectionEventInput): Promise<RecordResult>;
}

export interface ReplayInput {
  tenantId: string;
  /** consumed_events rows per batch transaction: 1..MAX_REPLAY_BATCH_SIZE, default DEFAULT_REPLAY_BATCH_SIZE. */
  batchSize?: number;
  /**
   * Keep the rows of retired versions (default false: the rows of EVERY retired version are deleted before the build
   * and after the switch, the REQ-12 demo's "v1 emptied"; an interrupted cleanup is finished by the next run).
   */
  keepOld?: boolean;
  /**
   * Switch although the build met unreadable rows (default false: the switch is held and the building version stays; after
   * a reader fix a rerun reads it again from the start and applies the rows that can be read now). With the flag the
   * switch goes ahead and the rows that still cannot be read stay OUT of the new version; ADR-058.
   */
  allowUnreadable?: boolean;
}

/**
 * "switched": this run activated the rebuilt version. "held": the build is complete but unreadable rows held the switch
 * (allowUnreadable not given); the version stays building. "finished_elsewhere": a replay of the same tenant that ran at
 * the same time switched (or replaced) the version this run was building.
 */
export type ReplayOutcome = "switched" | "held" | "finished_elsewhere";

export interface ReplayReport {
  tenantId: string;
  outcome: ReplayOutcome;
  /** True when a building version of an earlier (or a simultaneous) replay was continued. */
  resumed: boolean;
  /**
   * True when that building version had met unreadable rows (a held switch): it was not continued but read again from the
   * start with a new high water mark, because the reader may have been fixed since. Implies `resumed`.
   */
  rescanned: boolean;
  /** The version that was active when the build was compared (retired when outcome is "switched"). */
  fromVersion: number;
  /** The version this run built. */
  toVersion: number;
  highWaterPosition: number;
  /** consumed_events rows this run applied to the new version (counted from the rows read, never from positions). */
  eventsApplied: number;
  /** Rows this run read of types this version does not project (MarketCreated and the like; normal). */
  eventsNotProjected: number;
  /** checkpoint.unreadableEvents: rows of the whole build that this reader could not read (normally 0; holds the switch). */
  eventsUnreadable: number;
  /** Rows of the new version when it was compared. */
  summaries: number;
  points: number;
  /** Market ids whose summary or price points differ between the active and the new version (normally none). */
  differences: string[];
  /**
   * Rows of retired versions deleted by this run (before the build and after the switch). After a switch with
   * differences the retired version's rows are kept for comparison; the next run deletes them.
   */
  retiredRowsDeleted: number;
  startedAt: Date;
  /** Null unless outcome is "switched". */
  switchedAt: Date | null;
}

/**
 * DM-09, REQ-12: rebuilds the projections of one tenant from consumed_events into a new version while the live
 * consumer keeps feeding, then switches every read to it atomically.
 */
export interface ReplayProjectionsUseCase {
  execute(input: ReplayInput): Promise<ReplayReport>;
}

/** What the public web layer calls. A GraphQL endpoint (REQ-17, not built) would call the same three. */
export interface MarketDataUseCases {
  listMarkets: ListMarketsUseCase;
  getMarket: GetMarketUseCase;
  getHistory: GetHistoryUseCase;
}

/** What the consumers (and the local events route) call. */
export interface ConsumerUseCases {
  provisionTenant: ProvisionTenantUseCase;
  recordProjectionEvent: RecordProjectionEventUseCase;
}
