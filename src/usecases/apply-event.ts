import type { ProjectionEvent } from "../domain/consumed.js";
import { effectOf, emptySummary } from "../domain/projection.js";
import type { ApplyKind, MarketSummary } from "../domain/projection.js";
import { guardDomain } from "./errors.js";
import type { ProjectionRepository } from "./ports.js";

/**
 * Applies one projection event to one projection version, inside the caller's transaction. The live consumer
 * (RecordProjectionEvent: the active version, then the building one) and the replay (ReplayProjections: the building
 * version) both call exactly this (ADR-032: the same handlers), so a rebuilt version equals a live one.
 *
 * Row order, the same in every transaction: the market's summary row (locked), then its price point, then the summary
 * write. A summary that does not exist yet is inserted with ON CONFLICT DO NOTHING; when another transaction created it
 * first (a lifecycle event and a trade of a new market at once), the row is read again with its lock and the event
 * applied to it, with the same answer about the point. The rules commute (domain/projection.ts), so this re-apply is
 * correct whatever the other transaction did. Returns what the event did to this version; `onWritten` (the live consumer's
 * metrics) gets the summary that was written, when one was.
 */
export async function applyToVersion(
  projections: ProjectionRepository,
  version: number,
  event: ProjectionEvent,
  now: Date,
  onWritten?: (summary: MarketSummary) => void,
): Promise<ApplyKind> {
  const effect = effectOf(event, now);
  const existing = await projections.findSummary(version, effect.marketId, { lock: true });
  const inserted = effect.point === null ? false : await projections.insertPoint(version, effect.point);
  const applied = guardDomain(() => effect.apply(existing ?? emptySummary(effect.marketId, now), inserted));
  if (!applied.changed) return applied.kind;
  if (existing !== null) {
    await projections.updateSummary(version, applied.summary);
    onWritten?.(applied.summary);
    return applied.kind;
  }
  if (await projections.insertSummary(version, applied.summary)) {
    onWritten?.(applied.summary);
    return applied.kind;
  }
  const current = await projections.findSummary(version, effect.marketId, { lock: true });
  if (current === null) throw new Error(`The summary of market ${effect.marketId} in projection version ${version} was neither inserted nor found`);
  const again = guardDomain(() => effect.apply(current, inserted));
  if (again.changed) {
    await projections.updateSummary(version, again.summary);
    onWritten?.(again.summary);
  }
  return again.kind;
}
