import { describe, expect, it } from "vitest";
import type { ProjectionEvent } from "../../src/domain/consumed.js";
import { applyToProjection, emptyProjection, foldEvents, pointKey, projectionDifferences } from "../../src/domain/projection.js";
import type { MarketSummary, PricePoint, ProjectionState } from "../../src/domain/projection.js";
import { applyToVersion } from "../../src/usecases/apply-event.js";
import type { ProjectionRepository } from "../../src/usecases/ports.js";
import { MARKET_1, at, marketClosedBody, marketOpenedBody, projectionEvent, tradeExecutedBody } from "../support/fakes.js";

const NOW = at(1000);

/** A ProjectionRepository over in-memory versions; `beforeInsertSummary` lets a test play a concurrent transaction. */
class VersionsFake implements ProjectionRepository {
  readonly versions = new Map<number, ProjectionState>();
  beforeInsertSummary: ((version: number, summary: MarketSummary) => void) | null = null;
  readonly calls: string[] = [];

  state(version: number): ProjectionState {
    let state = this.versions.get(version);
    if (!state) {
      state = emptyProjection();
      this.versions.set(version, state);
    }
    return state;
  }
  findSummary(version: number, marketId: string, options?: { lock?: boolean }): Promise<MarketSummary | null> {
    this.calls.push(`find${options?.lock ? ":lock" : ""}`);
    return Promise.resolve(this.state(version).summaries.get(marketId) ?? null);
  }
  insertSummary(version: number, summary: MarketSummary): Promise<boolean> {
    this.calls.push("insertSummary");
    const hook = this.beforeInsertSummary;
    this.beforeInsertSummary = null;
    hook?.(version, summary);
    const summaries = this.state(version).summaries;
    if (summaries.has(summary.marketId)) return Promise.resolve(false);
    summaries.set(summary.marketId, summary);
    return Promise.resolve(true);
  }
  updateSummary(version: number, summary: MarketSummary): Promise<void> {
    this.calls.push("updateSummary");
    this.state(version).summaries.set(summary.marketId, summary);
    return Promise.resolve();
  }
  insertPoint(version: number, point: PricePoint): Promise<boolean> {
    this.calls.push("insertPoint");
    const points = this.state(version).points;
    const key = pointKey(point.marketId, point.tradeSequence);
    if (points.has(key)) return Promise.resolve(false);
    points.set(key, point);
    return Promise.resolve(true);
  }
  countVersion(): Promise<{ summaries: number; points: number }> {
    return Promise.reject(new Error("not used"));
  }
  compareVersions(): Promise<string[]> {
    return Promise.reject(new Error("not used"));
  }
  deleteVersion(): Promise<number> {
    return Promise.reject(new Error("not used"));
  }
  exportVersion(): Promise<{ summaries: MarketSummary[]; points: PricePoint[] }> {
    return Promise.reject(new Error("not used"));
  }
}

const opened = projectionEvent(marketOpenedBody());
const trade = (sequence: number, price: number): ProjectionEvent => projectionEvent(tradeExecutedBody({ tradeSequence: sequence, yesPriceMicro: price }));

describe("applyToVersion", () => {
  it("locks the summary first, then stores the point, then writes the summary, and matches the fold", async () => {
    const repo = new VersionsFake();
    const events = [trade(2, 520_000), opened, trade(1, 450_000), trade(2, 520_000), projectionEvent(marketClosedBody())];
    const kinds = [];
    for (const event of events) kinds.push(await applyToVersion(repo, 1, event, NOW));
    expect(kinds).toEqual(["applied", "applied", "applied", "stale", "applied"]);
    expect(repo.calls.slice(0, 3)).toEqual(["find:lock", "insertPoint", "insertSummary"]);
    expect(projectionDifferences(repo.state(1), foldEvents(events, NOW))).toEqual([]);
  });

  it("applies the event again to a summary another transaction created first", async () => {
    const repo = new VersionsFake();
    // While this trade inserts the new market's summary, a MarketOpened of the same market commits first.
    repo.beforeInsertSummary = (version) => {
      applyToProjection(repo.state(version), opened, NOW);
    };
    expect(await applyToVersion(repo, 1, trade(1, 450_000), NOW)).toBe("applied");
    expect(repo.calls).toEqual(["find:lock", "insertPoint", "insertSummary", "find:lock", "updateSummary"]);
    expect(projectionDifferences(repo.state(1), foldEvents([opened, trade(1, 450_000)], NOW))).toEqual([]);
  });

  it("keeps versions apart", async () => {
    const repo = new VersionsFake();
    await applyToVersion(repo, 1, opened, NOW);
    await applyToVersion(repo, 2, trade(1, 450_000), NOW);
    expect(repo.state(1).summaries.get(MARKET_1)?.tradeCount).toBe(0);
    expect(repo.state(2).summaries.get(MARKET_1)?.question).toBeNull();
  });

  it("reports an invariant broken by stored data as an internal error", async () => {
    const repo = new VersionsFake();
    await applyToVersion(repo, 1, opened, NOW);
    const summary = repo.state(1).summaries.get(MARKET_1);
    if (!summary) throw new Error("missing");
    repo.state(1).summaries.set(MARKET_1, { ...summary, volumeMicro: Number.MAX_SAFE_INTEGER });
    await expect(applyToVersion(repo, 1, trade(1, 450_000), NOW)).rejects.toThrow(/amount_out_of_range/);
  });
});
