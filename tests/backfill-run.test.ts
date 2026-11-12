import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_LINE_LENGTH, MAX_PRINTED_PROBLEMS, classifyLine, readLines, runBackfill } from "../src/backfill-run.js";
import { MARKET_1, MARKET_2, TENANT_A, TENANT_B, at, marketClosedBody, marketOpenedBody, marketResolvedBody, tenantCreatedBody, tradeExecutedBody } from "./support/fakes.js";
import { asTrader, createHarness, createCore, get } from "./support/harness.js";
import type { Core } from "./support/harness.js";

// `npm run backfill`: the loop over the lines of a file, on the memory store (the command itself only opens the file).

const text = (body: unknown): string => JSON.stringify(body);

async function* linesOf(lines: readonly string[]): AsyncGenerator<string> {
  for (const line of lines) {
    await Promise.resolve();
    yield line;
  }
}

async function run(core: Core, lines: readonly string[], dryRun = false) {
  const printed: string[] = [];
  const summary = await runBackfill({ useCases: core.useCases, dryRun, print: (line) => printed.push(line) }, linesOf(lines));
  return { summary, printed: printed.map((line) => JSON.parse(line) as Record<string, any>) };
}

const FILE = [
  text(tenantCreatedBody(TENANT_A)),
  text(marketOpenedBody({ marketId: MARKET_1, openedAt: at(0) })),
  text(tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, executedAt: at(1) })),
  text(tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 470_000, executedAt: at(2) })),
  text(marketClosedBody({ marketId: MARKET_1, closedAt: at(30) })),
];

describe("classifyLine", () => {
  it("tells a TenantCreated, a projection event and an event that is only stored apart", () => {
    expect(classifyLine(text(tenantCreatedBody(TENANT_A))).kind).toBe("tenant_created");
    expect(classifyLine(text(marketOpenedBody())).kind).toBe("event");
    expect(classifyLine(text({ ...marketOpenedBody(), type: "si.chance.markets.MarketCreated.v1" })).kind).toBe("event");
  });

  it.each([
    ["text that is not JSON", "{not json", "not JSON"],
    ["JSON that is not an object", "[1, 2]", "not a JSON object"],
    ["an event without an id", text({ ...marketOpenedBody(), id: undefined }), "id"],
    ["an event without a tenant", text({ ...marketOpenedBody(), tenantid: undefined }), "tenantid"],
    ["a TenantCreated with a tenant that disagrees", text({ ...tenantCreatedBody(TENANT_A), data: { tenantId: TENANT_B } }), "differs"],
    ["an event with a NUL character", text({ ...marketOpenedBody(), data: { ...(marketOpenedBody()["data"] as object), question: "a\u0000b" } }), "NUL"],
    ["a line longer than the limit", "x".repeat(MAX_LINE_LENGTH + 1), "longer than"],
  ])("sees %s as unattributable with the reason", (_name, line, reason) => {
    const classified = classifyLine(line);
    expect(classified.kind).toBe("unattributable");
    expect(classified.kind === "unattributable" && classified.reason).toContain(reason);
  });
});

describe("readLines", () => {
  const withFile = async (content: string, work: (file: string) => Promise<void>): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), "backfill-"));
    try {
      const file = join(directory, "events.ndjson");
      await writeFile(file, content);
      await work(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const all = async (lines: AsyncIterable<string>): Promise<string[]> => {
    const collected: string[] = [];
    for await (const line of lines) collected.push(line);
    return collected;
  };

  it("yields the lines of the file, with or without a final newline and with CRLF line ends", async () => {
    await withFile("a\nb\r\nc\n", async (file) => expect(await all(readLines(file))).toEqual(["a", "b", "c"]));
    await withFile("one\ntwo", async (file) => expect(await all(readLines(file))).toEqual(["one", "two"]));
  });

  it("loses no line when the first line is asked for long after the generator was made (the command migrates first)", async () => {
    await withFile("a\nb\nc\n", async (file) => {
      const lines = readLines(file);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await all(lines)).toEqual(["a", "b", "c"]);
    });
  });

  it("stops reading when the caller stops, and rejects with the system's message for a file that cannot be opened", async () => {
    await withFile("a\nb\nc\n", async (file) => {
      for await (const line of readLines(file)) {
        expect(line).toBe("a");
        break;
      }
    });
    await expect(all(readLines(join(tmpdir(), "backfill-no-such-folder", "events.ndjson")))).rejects.toThrow(/ENOENT/);
  });
});

describe("runBackfill", () => {
  it("provisions the tenant, records every event and counts the results; the tenant then answers like one fed by the streams", async () => {
    const core = createCore();
    const { summary, printed } = await run(core, FILE);
    expect(summary).toEqual({ lines: 5, results: { provisioned: 1, applied: 4 }, exitCode: 0 });
    expect(printed).toEqual([{ dryRun: false, lines: 5, results: { provisioned: 1, applied: 4 } }]);
    const view = await core.useCases.getMarket.execute({ actor: { userId: "u", tenantId: TENANT_A, role: "trader", correlationId: "c" }, marketId: MARKET_1 });
    expect(view).toMatchObject({ status: "closed", lastPriceYesMicro: 470_000, tradeCount: 2, volumeMicro: 20_000_000 });
  });

  it("is idempotent: the same file again is all duplicates and changes nothing", async () => {
    const core = createCore();
    await run(core, FILE);
    const before = JSON.stringify(core.store.snapshot().tenantData);
    const again = await run(core, FILE);
    expect(again.summary.results).toEqual({ duplicate: 5 });
    expect(JSON.stringify(core.store.snapshot().tenantData)).toBe(before);
  });

  it("does not care about the order of the lines", async () => {
    const forward = createCore();
    const backward = createCore();
    await run(forward, FILE);
    await run(backward, [...FILE].reverse());
    expect(JSON.stringify(backward.store.snapshot().tenantData[TENANT_A]?.versions[1])).toBe(JSON.stringify(forward.store.snapshot().tenantData[TENANT_A]?.versions[1]));
    expect(backward.store.snapshot().tenantData[TENANT_A]?.versions[1]?.points).toHaveLength(3);
  });

  describe("a market's lifecycle lines (README: the export carries the version the market had at each transition)", () => {
    const opened = (version: number) => text(marketOpenedBody({ marketId: MARKET_1, version, openedAt: at(0) }));
    const closed = (version: number) => text(marketClosedBody({ marketId: MARKET_1, version, closedAt: at(30) }));
    const resolved = (version: number) => text(marketResolvedBody({ marketId: MARKET_1, version, outcome: "YES", resolvedAt: at(60) }));
    const tenant = text(tenantCreatedBody(TENANT_A));
    const projectionOf = (core: Core) => core.store.snapshot().tenantData[TENANT_A]?.versions[1]?.summaries[0];

    it("gives the same market in every order when each line carries its own version (V-2, V-1, V)", async () => {
      const lines = [opened(3), closed(4), resolved(5)];
      const orders = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [2, 0, 1]];
      const results: unknown[] = [];
      for (const order of orders) {
        const core = createCore();
        const { summary } = await run(core, [tenant, ...order.map((index) => lines[index] ?? "")]);
        expect(summary.results["unattributable"]).toBeUndefined();
        expect(summary.results["failed"]).toBeUndefined();
        expect(projectionOf(core)).toMatchObject({ status: "resolved", outcome: "YES", version: 5 });
        results.push(JSON.stringify(projectionOf(core)));
      }
      expect(new Set(results).size).toBe(1);
    });

    it("refuses the second lifecycle line of a market that carries the same version as another type, whatever the order", async () => {
      for (const order of [[0, 1, 2], [2, 1, 0]]) {
        const lines = [opened(5), closed(5), resolved(5)];
        const core = createCore();
        const { summary, printed } = await run(core, [tenant, ...order.map((index) => lines[index] ?? "")]);
        // Only the first line of the three is applied; the other two are reported with their line number and the reason.
        expect(summary).toEqual({ lines: 4, results: { provisioned: 1, applied: 1, unattributable: 2 }, exitCode: 0 });
        expect(printed.slice(0, 2)).toEqual([
          { line: 3, result: "unattributable", reason: expect.stringContaining("not distinct") as string },
          { line: 4, result: "unattributable", reason: expect.stringContaining("version 5") as string },
        ]);
      }
    });

    it("accepts the same type twice with one version (the original event next to the export: the second is stale)", async () => {
      const { summary } = await run(createCore(), [tenant, opened(3), opened(3), closed(4)]);
      expect(summary.results).toEqual({ provisioned: 1, applied: 2, stale: 1 });
    });

    it("checks each market on its own, and also with dryRun", async () => {
      const other = text(marketOpenedBody({ marketId: MARKET_2, version: 3, openedAt: at(0) }));
      const { summary } = await run(createCore(), [tenant, opened(3), closed(4), other], true);
      expect(summary.results).toEqual({ tenant_created: 1, event: 3 });
      const dry = await run(createCore(), [tenant, opened(3), closed(3)], true);
      expect(dry.summary.results).toEqual({ tenant_created: 1, event: 1, unattributable: 1 });
    });
  });

  it("skips blank lines, counts a stored-only event as unprojected and reports unattributable lines with their line number", async () => {
    const core = createCore();
    const lines = [FILE[0] ?? "", "", "   ", text({ ...marketOpenedBody({ marketId: MARKET_2 }), type: "si.chance.markets.MarketCreated.v1" }), "garbage", text(marketOpenedBody({ marketId: MARKET_2, openedAt: at(0) }))];
    const { summary, printed } = await run(core, lines);
    expect(summary).toEqual({ lines: 6, results: { provisioned: 1, unprojected: 1, unattributable: 1, applied: 1 }, exitCode: 0 });
    expect(printed).toEqual([{ line: 5, result: "unattributable", reason: expect.stringContaining("not JSON") as string }, expect.objectContaining({ lines: 6 })]);
  });

  it("reports a line whose use case throws, goes on with the others and exits 1", async () => {
    const core = createCore();
    const real = core.useCases.recordProjectionEvent;
    let calls = 0;
    core.useCases.recordProjectionEvent = {
      execute: (input) => {
        calls += 1;
        return calls === 2 ? Promise.reject(new Error("the database refused")) : real.execute(input);
      },
    };
    const { summary, printed } = await run(core, FILE);
    expect(summary.exitCode).toBe(1);
    expect(summary.results).toEqual({ provisioned: 1, applied: 3, failed: 1 });
    expect(printed[0]).toEqual({ line: 3, result: "failed", error: "the database refused" });
  });

  it("prints at most MAX_PRINTED_PROBLEMS problem lines and says how many it left out; the counts stay complete", async () => {
    const core = createCore();
    const bad = Array.from({ length: MAX_PRINTED_PROBLEMS + 7 }, () => "not json");
    const { summary, printed } = await run(core, bad);
    expect(summary.results).toEqual({ unattributable: MAX_PRINTED_PROBLEMS + 7 });
    expect(printed).toHaveLength(MAX_PRINTED_PROBLEMS + 2);
    expect(printed.at(-2)).toEqual({ note: "7 more problem lines were not printed" });
    expect(printed.at(-1)).toMatchObject({ lines: MAX_PRINTED_PROBLEMS + 7 });
  });

  it("with dryRun classifies every line and writes nothing", async () => {
    const core = createCore();
    const { summary, printed } = await run(core, [...FILE, "garbage"], true);
    expect(summary).toEqual({ lines: 6, results: { tenant_created: 1, event: 4, unattributable: 1 }, exitCode: 0 });
    expect(printed.at(-1)).toEqual({ dryRun: true, lines: 6, results: { tenant_created: 1, event: 4, unattributable: 1 } });
    expect(core.store.snapshot()).toMatchObject({ tenants: [], inbox: [], parked: [] });
  });

  it("makes a market that the streams no longer hold readable through the API (the reason for the command)", async () => {
    const harness = await createHarness({ provision: false });
    try {
      const before = await get(harness, `/v1/market-data/markets/${MARKET_1}`);
      expect(before.status).toBe(503);
      await run(harness.core, FILE);
      harness.core.clock.advanceMs(3_600_000);
      const after = await get(harness, `/v1/market-data/markets/${MARKET_1}`, asTrader());
      expect(after.status).toBe(200);
      expect(after.body).toMatchObject({ tradeCount: 2, status: "closed" });
    } finally {
      await harness.close();
    }
  });
});
