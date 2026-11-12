import { describe, expect, it } from "vitest";
import { EXIT_FAILED, EXIT_HELD, REPLAY_OPTIONS, replayCommandOf, runReplay } from "../src/replay-run.js";
import type { ReplayCommand } from "../src/replay-run.js";
import { parseArgs } from "node:util";
import { MARKET_1, MARKET_2, TENANT_A, TENANT_B, at, marketOpenedBody, tradeExecutedBody } from "./support/fakes.js";
import { createCore, provisionTenants, record } from "./support/harness.js";
import type { Core } from "./support/harness.js";

// `npm run replay`: the options and the loop over the tenants, on the memory store (the command itself is a thin wrapper).

const command = (overrides: Partial<ReplayCommand> = {}): ReplayCommand => ({ tenant: null, batchSize: undefined, keepOld: false, allowUnreadable: false, status: false, ...overrides });

function run(core: Core, options: ReplayCommand) {
  const printed: string[] = [];
  const notes: string[] = [];
  const done = runReplay({ store: core.store, replay: core.useCases.replayProjections, print: (line) => printed.push(line), note: (line) => notes.push(line) }, options);
  return { done, lines: () => printed.map((line) => JSON.parse(line) as Record<string, any>), notes };
}

async function seeded(): Promise<Core> {
  const core = createCore();
  await provisionTenants(core);
  await record(core, marketOpenedBody({ marketId: MARKET_1, openedAt: at(0) }));
  await record(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000 }));
  await record(core, marketOpenedBody({ marketId: MARKET_2, tenantId: TENANT_B, openedAt: at(0) }));
  return core;
}

describe("the options of the replay command", () => {
  const options = (argv: string[]) => parseArgs({ args: argv, options: REPLAY_OPTIONS, strict: true }).values;

  it("defaults to every tenant, a full replay and the use case's own batch size", () => {
    expect(replayCommandOf(options([]))).toEqual({ tenant: null, batchSize: undefined, keepOld: false, allowUnreadable: false, status: false });
  });

  it("reads every option", () => {
    const parsed = replayCommandOf(options(["--tenant", ` ${TENANT_A} `, "--batch-size", "250", "--keep-old", "--allow-unreadable", "--status"]));
    expect(parsed).toEqual({ tenant: TENANT_A, batchSize: 250, keepOld: true, allowUnreadable: true, status: true });
  });

  it.each(["0", "1001", "abc", "5.5", "-3", "", "1e2"])("refuses the batch size %j with the range in the message", (value) => {
    const parsed = replayCommandOf(options([`--batch-size=${value}`]));
    expect(typeof parsed).toBe("string");
    expect(parsed).toContain("from 1 to 1000");
  });

  it("accepts the limits 1 and 1000 and refuses an unknown option", () => {
    expect(replayCommandOf(options(["--batch-size", "1"]))).toMatchObject({ batchSize: 1 });
    expect(replayCommandOf(options(["--batch-size", "1000"]))).toMatchObject({ batchSize: 1000 });
    expect(() => options(["--rebuild"])).toThrow();
  });
});

describe("runReplay", () => {
  it("replays every registered tenant, prints one JSON line of the report each and exits 0 when all switched", async () => {
    const core = await seeded();
    const { done, lines } = run(core, command());
    expect(await done).toBe(0);
    expect(lines()).toEqual([
      expect.objectContaining({ tenantId: TENANT_A, outcome: "switched", fromVersion: 1, toVersion: 2, summaries: 1, points: 2, differences: [] }),
      expect.objectContaining({ tenantId: TENANT_B, outcome: "switched", fromVersion: 1, toVersion: 2, summaries: 1, points: 1, differences: [] }),
    ]);
    expect(lines()[0]).toHaveProperty("switchedAt", expect.any(String) as string);
  });

  it("replays only the tenant named and passes the options on", async () => {
    const core = await seeded();
    const { done, lines } = run(core, command({ tenant: TENANT_A, keepOld: true, batchSize: 1 }));
    expect(await done).toBe(0);
    expect(lines().map((report) => report["tenantId"])).toEqual([TENANT_A]);
    expect(lines()[0]).toMatchObject({ retiredRowsDeleted: 0 });
    // keepOld: version 1 still has its rows, version 2 is active.
    const rows = core.store.snapshot().tenantData[TENANT_A]?.versions[1];
    expect(rows?.summaries).toHaveLength(1);
    expect(core.store.snapshot().tenantData[TENANT_B]?.checkpoints.map((checkpoint) => checkpoint.state)).toEqual(["active"]);
  });

  it("says so when no tenant is registered and exits 0", async () => {
    const core = createCore();
    const { done, lines, notes } = run(core, command());
    expect(await done).toBe(0);
    expect(lines()).toEqual([]);
    expect(notes).toEqual(["No tenant is registered."]);
  });

  it("reports a tenant that fails and still replays the others, with exit 1", async () => {
    const core = await seeded();
    const unknown = "018f3c1e-7a00-7000-8000-0000000000cc";
    const listed = core.store.repositories.tenants.list.bind(core.store.repositories.tenants);
    core.store.repositories.tenants.list = async () => [unknown, ...(await listed())];
    const { done, lines } = run(core, command());
    expect(await done).toBe(EXIT_FAILED);
    const reports = lines();
    expect(reports[0]).toEqual({ tenantId: unknown, outcome: "failed", error: expect.any(String) as string, code: "tenant_not_ready" });
    expect(reports.slice(1).map((report) => report["outcome"])).toEqual(["switched", "switched"]);
  });

  it("exits 2 when none failed but a tenant is held by an unreadable stored event, and 0 with --allow-unreadable", async () => {
    const core = await seeded();
    await record(core, { ...tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 460_000 }), type: "si.chance.trading.TradeExecuted.v2" });
    const held = run(core, command({ tenant: TENANT_A }));
    expect(await held.done).toBe(EXIT_HELD);
    expect(held.lines()[0]).toMatchObject({ outcome: "held", eventsUnreadable: 1, switchedAt: null });
    const forced = run(core, command({ tenant: TENANT_A, allowUnreadable: true }));
    expect(await forced.done).toBe(0);
    expect(forced.lines()[0]).toMatchObject({ outcome: "switched", resumed: true });
  });

  it("a failure outweighs a held tenant in the exit code", async () => {
    const core = await seeded();
    await record(core, { ...tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 460_000 }), type: "si.chance.trading.TradeExecuted.v2" });
    const listed = core.store.repositories.tenants.list.bind(core.store.repositories.tenants);
    core.store.repositories.tenants.list = async () => [...(await listed()), "018f3c1e-7a00-7000-8000-0000000000cc"];
    const { done } = run(core, command());
    expect(await done).toBe(EXIT_FAILED);
  });

  it("refuses a batch size outside 1..1000 as a failure of the tenant, naming the field", async () => {
    const core = await seeded();
    const { done, lines } = run(core, command({ tenant: TENANT_A, batchSize: 5000 }));
    expect(await done).toBe(EXIT_FAILED);
    expect(lines()[0]).toMatchObject({ outcome: "failed", code: "validation_failed", fields: [expect.objectContaining({ field: "batchSize" })] });
  });

  describe("--status", () => {
    it("prints the checkpoints with the row counts of every version and changes nothing", async () => {
      const core = await seeded();
      const before = JSON.stringify(core.store.snapshot());
      const { done, lines } = run(core, command({ status: true }));
      expect(await done).toBe(0);
      expect(JSON.stringify(core.store.snapshot())).toBe(before);
      expect(lines()).toHaveLength(2);
      expect(lines()[0]).toMatchObject({ tenantId: TENANT_A, versions: [{ version: 1, state: "active", summaries: 1, points: 2, unreadableEvents: 0, retiredAt: null }] });
    });

    it("shows the retired version emptied and the new one built after a replay", async () => {
      const core = await seeded();
      expect(await run(core, command({ tenant: TENANT_A })).done).toBe(0);
      const status = run(core, command({ tenant: TENANT_A, status: true }));
      expect(await status.done).toBe(0);
      expect(status.lines()[0]?.["versions"]).toEqual([
        expect.objectContaining({ version: 1, state: "retired", summaries: 0, points: 0 }),
        expect.objectContaining({ version: 2, state: "active", summaries: 1, points: 2 }),
      ]);
    });

    it("reports a tenant that is not registered and exits 1", async () => {
      const core = createCore();
      const { done, lines } = run(core, command({ status: true, tenant: TENANT_A }));
      expect(await done).toBe(EXIT_FAILED);
      expect(lines()[0]).toMatchObject({ tenantId: TENANT_A, outcome: "failed" });
    });
  });
});
