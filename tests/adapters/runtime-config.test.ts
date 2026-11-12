import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_SETTINGS } from "../../src/config.js";
import type { RuntimeSettings } from "../../src/config.js";
import { RuntimeConfigWatcher, RuntimeSettingsHolder } from "../../src/adapters/runtime-config.js";
import { RecordingLogger } from "../support/fakes.js";

describe("RuntimeSettingsHolder", () => {
  it("hands out the current history rules and takes new settings", () => {
    const holder = new RuntimeSettingsHolder(DEFAULT_RUNTIME_SETTINGS);
    expect(holder.current()).toEqual(DEFAULT_RUNTIME_SETTINGS.historyRules);
    holder.set({ logLevel: "warn", historyRules: { maxPoints: 50, enabled: false } });
    expect(holder.current().enabled).toBe(false);
    expect(holder.get().logLevel).toBe("warn");
  });
});

describe("RuntimeConfigWatcher", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "market-data-runtime-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("applies the file when it changes, ignores an unchanged file and survives a missing one", async () => {
    const file = join(dir, "runtime.env");
    const logger = new RecordingLogger();
    const seen: RuntimeSettings[] = [];
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 60_000, startup: DEFAULT_RUNTIME_SETTINGS, logger, onChange: (s) => seen.push(s) });

    expect(await watcher.checkNow()).toBe(false);
    expect(await watcher.checkNow()).toBe(false);
    expect(logger.messages("warn")).toHaveLength(1);

    await writeFile(file, "HISTORY_ENABLED=false\nNOT_A_KEY=1\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(seen.at(-1)?.historyRules.enabled).toBe(false);
    expect(logger.messages("warn")).toContain("Ignored a setting of the runtime configuration file");
    expect(await watcher.checkNow()).toBe(false);

    await writeFile(file, "HISTORY_MAX_POINTS=300\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(seen.at(-1)?.historyRules).toEqual({ maxPoints: 300, enabled: true });

    await watcher.start();
    await watcher.stop();
  });

  it("keeps a pause in force when the line is later misspelled, and ends it only when the line is deleted", async () => {
    const file = join(dir, "runtime.env");
    const logger = new RecordingLogger();
    const holder = new RuntimeSettingsHolder(DEFAULT_RUNTIME_SETTINGS);
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 60_000, startup: DEFAULT_RUNTIME_SETTINGS, current: () => holder.get(), logger, onChange: (s) => holder.set(s) });

    await writeFile(file, "HISTORY_ENABLED=false\nHISTORY_MAX_POINTS=250\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(holder.current()).toEqual({ enabled: false, maxPoints: 250 });

    await writeFile(file, "HISTORY_ENABLED=flase\nHISTORY_MAX_POINTS=25O\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(holder.current()).toEqual({ enabled: false, maxPoints: 250 });

    await writeFile(file, "# the pause is over\n");
    expect(await watcher.checkNow()).toBe(true);
    expect(holder.current()).toEqual(DEFAULT_RUNTIME_SETTINGS.historyRules);
  });
});
