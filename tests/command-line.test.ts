import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";
import { EXIT_USAGE, parseCommandLine } from "../src/command-line.js";
import { REPLAY_OPTIONS, REPLAY_USAGE } from "../src/replay-run.js";

// A wrong command line is wrong use (exit 64 with the reason and the usage line), not a failed run (exit 1): README "Commands".

describe("parseCommandLine", () => {
  const parse = (args: string[]) => parseCommandLine(() => parseArgs({ args, options: REPLAY_OPTIONS, strict: true }), REPLAY_USAGE);

  it("returns the parsed values of a right command line", () => {
    const parsed = parse(["--tenant", "t1", "--status"]);
    expect(parsed).toEqual({ ok: true, value: expect.objectContaining({ values: expect.objectContaining({ tenant: "t1", status: true }) as object }) as object });
  });

  it.each([
    ["an unknown option", ["--rebuild"], "--rebuild"],
    ["an option without its value", ["--tenant"], "--tenant"],
    ["a flag given a value", ["--keep-old=yes"], "--keep-old"],
    ["a stray argument", ["stray"], "stray"],
  ])("turns %s into a message with the reason and the usage line", (_name, args, mention) => {
    const parsed = parse(args);
    expect(parsed.ok).toBe(false);
    const message = parsed.ok ? "" : parsed.message;
    expect(message).toContain(mention);
    expect(message.endsWith(`\n${REPLAY_USAGE}`)).toBe(true);
  });

  it("throws every other error on: it is a bug, not a typo", () => {
    expect(() => parseCommandLine(() => { throw new TypeError("a bug"); }, REPLAY_USAGE)).toThrow("a bug");
    expect(() => parseCommandLine(() => { throw Object.assign(new Error("not from parseArgs"), { code: "ERR_OTHER" }); }, REPLAY_USAGE)).toThrow("not from parseArgs");
  });

  it("uses the exit code 64", () => {
    expect(EXIT_USAGE).toBe(64);
  });
});

// The wiring of the three commands is not under unit test (they are thin wrappers that need a database, excluded from the
// coverage), so the built commands are run: they refuse a wrong command line before they look at DATABASE_URL, and the
// message names the offending argument (a command that had got past the parse would say "DATABASE_URL is not set" instead).
// These tests need `npm run build` and are skipped without it.
const dist = fileURLToPath(new URL("../dist", import.meta.url));

describe.skipIf(!["replay", "backfill", "parked"].every((command) => existsSync(join(dist, `${command}.js`))))("the built commands (run npm run build first)", () => {
  const environment = { ...process.env };
  delete environment["DATABASE_URL"];
  const run = (command: string, args: string[]) => spawnSync(process.execPath, [join(dist, `${command}.js`), ...args], { env: environment, encoding: "utf8", timeout: 30_000 });

  it.each([
    ["replay", ["--rebuild"], "--rebuild"],
    ["replay", ["--tenant"], "--tenant"],
    ["replay", ["stray"], "stray"],
    ["backfill", ["--nope"], "--nope"],
    ["backfill", ["--file"], "--file"],
    ["parked", ["--nope"], "--nope"],
    ["parked", ["--consumer"], "--consumer"],
  ])("%s %j exits 64 with the reason and a usage line", (command, args, mention) => {
    const result = run(command, args);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain(mention);
    expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe("");
  });

  it("still exits 64 for a right command line without DATABASE_URL, with its own message", () => {
    const result = run("replay", ["--status"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("DATABASE_URL is not set");
  });
});
