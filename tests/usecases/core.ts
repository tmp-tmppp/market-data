import { expect } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { isProjectionEvent, readProjectionEvent } from "../../src/domain/consumed.js";
import { foldEvents, pointKey, projectionDifferences } from "../../src/domain/projection.js";
import type { ProjectionState } from "../../src/domain/projection.js";
import { GetHistory } from "../../src/usecases/get-history.js";
import type { ProjectionObserver } from "../../src/usecases/ports.js";
import { GetMarket } from "../../src/usecases/get-market.js";
import { ListMarkets } from "../../src/usecases/list-markets.js";
import { ProvisionTenant } from "../../src/usecases/provision-tenant.js";
import { RecordProjectionEvent } from "../../src/usecases/record-projection-event.js";
import { ReplayProjections } from "../../src/usecases/replay-projections.js";
import type { RecordResult } from "../../src/usecases/use-cases.js";
import { RecordingLogger, T0, TENANT_A, TestClock, TestRules, tenantCreatedBody } from "../support/fakes.js";
import { readTenantCreated } from "../../src/domain/tenant.js";

// The use cases of market-data over one MemoryStore, for the tests of the use cases (the integrator's full-stack harness
// is tests/support/harness.ts; this one has no web layer).

export function createCore(options: { observer?: ProjectionObserver } = {}) {
  const store = new MemoryStore();
  const clock = new TestClock();
  const logger = new RecordingLogger();
  const rules = new TestRules();
  const deps = { store, clock, logger };
  return {
    store,
    clock,
    logger,
    rules,
    provisionTenant: new ProvisionTenant(deps),
    recordProjectionEvent: new RecordProjectionEvent(options.observer ? { ...deps, observer: options.observer } : deps),
    listMarkets: new ListMarkets(deps),
    getMarket: new GetMarket(deps),
    getHistory: new GetHistory({ ...deps, rules }),
    replay: new ReplayProjections(deps),
  };
}

export type Core = ReturnType<typeof createCore>;

type Body = Record<string, unknown>;

/** What the consumer does with a message: read it, then record it (the body is stored as consumed). */
export async function consume(core: Core, body: Body): Promise<RecordResult> {
  const event = readProjectionEvent(body);
  if (event.kind === "unattributable") throw new Error(`The test event is unattributable: ${event.reason}`);
  return core.recordProjectionEvent.execute({ event, raw: body });
}

export async function consumeAll(core: Core, bodies: readonly Body[]): Promise<RecordResult[]> {
  const results: RecordResult[] = [];
  for (const body of bodies) results.push(await consume(core, body));
  return results;
}

/** TenantCreated through the real use case. */
export async function provision(core: Core, tenantId: string = TENANT_A): Promise<void> {
  const read = readTenantCreated(tenantCreatedBody(tenantId));
  if (read.kind !== "tenant_created") throw new Error("The test TenantCreated was not read");
  await core.provisionTenant.execute(read.notice);
}

/** The rows of one projection version as the domain folds events into them. */
export function stateOf(core: Core, version: number, tenantId: string = TENANT_A): ProjectionState {
  const data = core.store.snapshot().tenantData[tenantId];
  const rows = data?.versions[version];
  if (!rows) throw new Error(`The tenant ${tenantId} has no rows of version ${version}`);
  return {
    summaries: new Map(rows.summaries.map((summary) => [summary.marketId, summary])),
    points: new Map(rows.points.map((point) => [pointKey(point.marketId, point.tradeSequence), point])),
  };
}

export function checkpointsOf(core: Core, tenantId: string = TENANT_A) {
  const data = core.store.snapshot().tenantData[tenantId];
  if (!data) throw new Error(`The tenant ${tenantId} has no schema`);
  return data.checkpoints;
}

export function activeVersionOf(core: Core, tenantId: string = TENANT_A): number {
  const active = checkpointsOf(core, tenantId).find((checkpoint) => checkpoint.state === "active");
  if (!active) throw new Error("No active version");
  return active.version;
}

/** The number of rows (summaries and points) of a version. */
export function rowCount(core: Core, version: number, tenantId: string = TENANT_A): number {
  const state = stateOf(core, version, tenantId);
  return state.summaries.size + state.points.size;
}

/** The projection that folding `bodies` in the given order gives (unprojected ones are skipped, as the replay does). */
export function foldBodies(bodies: readonly Body[]): ProjectionState {
  return foldEvents(
    bodies.map((body) => readProjectionEvent(body)).filter(isProjectionEvent),
    T0,
  );
}

/** The active version equals the fold of `bodies`: the whole point of the replay and of the commuting rules. */
export function expectActiveEquals(core: Core, bodies: readonly Body[], tenantId: string = TENANT_A): void {
  const actual = stateOf(core, activeVersionOf(core, tenantId), tenantId);
  expect(projectionDifferences(actual, foldBodies(bodies))).toEqual([]);
}
