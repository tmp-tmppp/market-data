import { isProjectionEvent, readProjectionEvent } from "../domain/consumed.js";
import { parseTenantId } from "../domain/tenant.js";
import { TenantNotReady, ValidationFailed, guardDomain } from "./errors.js";
import { applyToVersion } from "./apply-event.js";
import type { ProjectionCheckpoint, TenantRepositories, TenantStore, UseCaseDeps } from "./ports.js";
import { DEFAULT_REPLAY_BATCH_SIZE, MAX_REPLAY_BATCH_SIZE, REPLAY_BATCH_TIME_BUDGET_MS, RETIRED_DELETE_BATCH_SIZE } from "./support.js";
import type { ReplayInput, ReplayOutcome, ReplayProjectionsUseCase, ReplayReport } from "./use-cases.js";

/** How many differing market ids the report lists (the rest are only "differences exist"). */
const MAX_REPORTED_DIFFERENCES = 100;

/** The version that was active before the one this run builds: the active one, or the one before ours when ours is active. */
function fromVersionOf(checkpoints: readonly ProjectionCheckpoint[], version: number): number {
  const active = checkpoints.find((checkpoint) => checkpoint.state === "active");
  return active !== undefined && active.version !== version ? active.version : version - 1;
}

type BatchStep =
  | { kind: "elsewhere"; fromVersion: number }
  | { kind: "complete" }
  | { kind: "batch"; applied: number; notProjected: number; unreadable: number };

type SwitchStep =
  | { kind: "elsewhere"; fromVersion: number }
  | { kind: "held" | "switched"; fromVersion: number; differences: string[]; summaries: number; points: number; unreadable: number; at: Date };

/**
 * DM-09, ADR-032, REQ-12 and Proposed ADR-058: rebuilds the projections of ONE tenant from consumed_events into a new
 * version while the live consumer keeps feeding, then switches every read to it atomically.
 *
 * 1. Cleanup (unless keepOld): the rows of every retired version are deleted, so an interrupted cleanup, or a run that
 *    kept its old version, is finished by the next run.
 * 2. Start (own short transaction): `startBuilding` locks consumed_events first, then resumes a building version or
 *    creates one with the high water mark = the highest position. Every row at or below it was committed when the replay
 *    started; every live transaction that appends later reads the building version and writes it too. A building version
 *    that counted unreadable rows (a held switch) is not continued but read again from the start with a new mark
 *    (`rescanned`): a rerun after a reader fix then applies the events the old reader could not read (ADR-058); a clean
 *    build resumes where it stopped.
 * 3. Batches (each its own transaction, the tenant's projection lock exclusive): the rows after `rebuiltThrough` up to the
 *    high water mark go through `applyToVersion`, the same code as the live consumer. A batch ends at `batchSize` rows or
 *    when REPLAY_BATCH_TIME_BUDGET_MS have passed since it took the lock (after the row in progress), because the batch
 *    holds back the live events of the tenant. `advance` takes the position of the last row READ: positions have gaps, so
 *    nothing is computed from position arithmetic. A stopped replay resumes at `rebuiltThrough`.
 * 4. Switch (own transaction): own version still building (else `finished_elsewhere`), the two versions compared
 *    (summaries and price points), and the GATE: stored rows that this reader could not read hold the switch (`held`)
 *    unless `allowUnreadable` (which switches with those events left out). Otherwise the building version becomes active and the old one retired in one commit; reads
 *    resolve the active version inside one statement, so they see the old version until the commit and the new one after
 *    it, never a half-built one.
 * 5. Cleanup again after a switch, unless keepOld or the versions differed (then the old version stays for comparison and
 *    the next run deletes it).
 */
export class ReplayProjections implements ReplayProjectionsUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: ReplayInput): Promise<ReplayReport> {
    const { store, clock, logger } = this.deps;
    const batchSize = input.batchSize ?? DEFAULT_REPLAY_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_REPLAY_BATCH_SIZE) {
      throw new ValidationFailed([{ field: "batchSize", message: `batchSize must be an integer from 1 to ${MAX_REPLAY_BATCH_SIZE}` }]);
    }
    const tenantId = guardDomain(() => parseTenantId(input.tenantId));
    const tenant = await store.forTenant(tenantId);
    if (tenant === null) throw new TenantNotReady();
    const startedAt = clock.now();
    const keepOld = input.keepOld ?? false;

    let retiredRowsDeleted = keepOld ? 0 : await this.deleteRetired(tenant);

    const { checkpoint, resumed, rescanned } = await tenant.transaction((repositories) => repositories.checkpoints.startBuilding(clock.now()));
    const version = checkpoint.version;
    if (checkpoint.highWaterPosition === null) throw new Error(`The building projection version ${version} has no high water mark`);
    const highWater = checkpoint.highWaterPosition;
    logger.info({ tenantId, version, highWaterPosition: highWater, resumed, rescanned, rebuiltThrough: checkpoint.rebuiltThrough }, "Projection replay started");

    let eventsApplied = 0;
    let eventsNotProjected = 0;
    let eventsUnreadable = checkpoint.unreadableEvents;
    let fromVersion = version - 1;
    const report = (outcome: ReplayOutcome, rest: Partial<ReplayReport> = {}): ReplayReport => ({
      tenantId,
      outcome,
      resumed,
      rescanned,
      fromVersion,
      toVersion: version,
      highWaterPosition: highWater,
      eventsApplied,
      eventsNotProjected,
      eventsUnreadable,
      summaries: 0,
      points: 0,
      differences: [],
      retiredRowsDeleted,
      startedAt,
      switchedAt: null,
      ...rest,
    });

    for (;;) {
      const step = await tenant.transaction((repositories) => this.batch(repositories, version, highWater, batchSize));
      if (step.kind === "elsewhere") {
        fromVersion = step.fromVersion;
        logger.info({ tenantId, version }, "Projection replay ended: another run switched or replaced this version");
        return report("finished_elsewhere");
      }
      if (step.kind === "complete") break;
      eventsApplied += step.applied;
      eventsNotProjected += step.notProjected;
      eventsUnreadable += step.unreadable;
    }

    const outcome = await tenant.transaction((repositories) => this.switchStep(repositories, version, input.allowUnreadable ?? false));
    fromVersion = outcome.fromVersion;
    if (outcome.kind === "elsewhere") {
      logger.info({ tenantId, version }, "Projection replay ended: another run switched or replaced this version");
      return report("finished_elsewhere");
    }
    eventsUnreadable = outcome.unreadable;
    const compared = { summaries: outcome.summaries, points: outcome.points, differences: outcome.differences };
    if (outcome.kind === "held") {
      logger.warn(
        { tenantId, version, unreadableEvents: outcome.unreadable },
        "Projection replay held: stored events of a projected type could not be read; fix the reader and run the replay again (it reads the stored events again from the start), or switch anyway with allowUnreadable (--allow-unreadable), which leaves those events out",
      );
      return report("held", compared);
    }
    // After a switch with differences the old version stays for comparison; the next run deletes it.
    if (!keepOld && outcome.differences.length === 0) retiredRowsDeleted += await this.deleteRetired(tenant);
    logger.info(
      { tenantId, fromVersion, toVersion: version, summaries: outcome.summaries, points: outcome.points, differences: outcome.differences.length, retiredRowsDeleted },
      "Projection replay switched",
    );
    return report("switched", { ...compared, switchedAt: outcome.at });
  }

  /** One batch: reads the next rows under the exclusive projection lock and applies them to the building version. */
  private async batch(repositories: TenantRepositories, version: number, highWater: number, batchSize: number): Promise<BatchStep> {
    const { clock, logger } = this.deps;
    const checkpoints = await repositories.checkpoints.lockForRebuild();
    const own = checkpoints.find((checkpoint) => checkpoint.version === version);
    // Another run switched this version (it is active now) or replaced it: nothing of this run is written.
    if (own === undefined || own.state !== "building") return { kind: "elsewhere", fromVersion: fromVersionOf(checkpoints, version) };
    if (own.rebuiltThrough >= highWater) return { kind: "complete" };

    const lockedAt = clock.now().getTime();
    const rows = await repositories.consumedEvents.read(own.rebuiltThrough, highWater, batchSize);
    let applied = 0;
    let notProjected = 0;
    let unreadable = 0;
    // No rows although the mark is not reached cannot happen (a row sits at the high water mark); if it ever did, every row
    // up to the mark has been read, so the run advances to it rather than loop.
    let lastRead = rows.length === 0 ? highWater : own.rebuiltThrough;
    for (const row of rows) {
      const read = readProjectionEvent(row.event);
      if (isProjectionEvent(read)) {
        await applyToVersion(repositories.projections, version, read, clock.now());
        applied += 1;
      } else if (read.kind === "unprojected" && read.cause === "other_type") {
        notProjected += 1;
      } else {
        // A row of a projection family that this reader cannot read (or, impossible for a stored row, an unattributable
        // one): counted, and it holds the switch (ADR-058).
        unreadable += 1;
        logger.warn({ eventId: row.eventId, position: row.position, version, reason: read.reason }, "A stored event could not be read by the replay");
      }
      lastRead = row.position;
      if (clock.now().getTime() - lockedAt >= REPLAY_BATCH_TIME_BUDGET_MS) break;
    }
    await repositories.checkpoints.advance(version, lastRead, unreadable);
    return { kind: "batch", applied, notProjected, unreadable };
  }

  /** The switch: compare, gate on unreadable rows, then retire the active version and activate this one. */
  private async switchStep(repositories: TenantRepositories, version: number, allowUnreadable: boolean): Promise<SwitchStep> {
    const { clock } = this.deps;
    const checkpoints = await repositories.checkpoints.lockForRebuild();
    const own = checkpoints.find((checkpoint) => checkpoint.version === version);
    if (own === undefined || own.state !== "building") return { kind: "elsewhere", fromVersion: fromVersionOf(checkpoints, version) };
    const active = checkpoints.find((checkpoint) => checkpoint.state === "active");
    if (active === undefined) throw new Error("The tenant has no active projection version");

    const differences = await repositories.projections.compareVersions(active.version, version, MAX_REPORTED_DIFFERENCES);
    const counts = await repositories.projections.countVersion(version);
    const at = clock.now();
    const result = { fromVersion: active.version, differences, summaries: counts.summaries, points: counts.points, unreadable: own.unreadableEvents, at };
    if (own.unreadableEvents > 0 && !allowUnreadable) return { kind: "held", ...result };
    await repositories.checkpoints.activate(version, at);
    return { kind: "switched", ...result };
  }

  /** Deletes the rows of every retired version, a bounded batch per transaction, until none are left. */
  private async deleteRetired(tenant: TenantStore): Promise<number> {
    let deleted = 0;
    const retired = (await tenant.repositories.checkpoints.list()).filter((checkpoint) => checkpoint.state === "retired");
    for (const checkpoint of retired) {
      for (;;) {
        const count = await tenant.transaction((repositories) => repositories.projections.deleteVersion(checkpoint.version, RETIRED_DELETE_BATCH_SIZE));
        deleted += count;
        if (count === 0) break;
      }
    }
    return deleted;
  }
}
