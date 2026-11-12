import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_TIMEOUT_MS, createShutdown, registerShutdownSignals } from "../src/shutdown.js";
import type { ShutdownSteps } from "../src/shutdown.js";
import type { Logger } from "../src/usecases/ports.js";

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function recordingSteps(overrides: Partial<ShutdownSteps> = {}) {
  const calls: string[] = [];
  const step = (name: string) => () => {
    calls.push(name);
    return Promise.resolve();
  };
  const steps: ShutdownSteps = {
    drain: () => {
      calls.push("drain");
    },
    closeServer: step("closeServer"),
    stopConsumers: step("stopConsumers"),
    stopMaintenance: step("stopMaintenance"),
    stopRuntimeConfig: step("stopRuntimeConfig"),
    closeEvents: step("closeEvents"),
    closeDatabase: step("closeDatabase"),
    ...overrides,
  };
  return { calls, steps };
}

describe("createShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains first, waits the delay, then stops everything in order and exits with 0", async () => {
    const { calls, steps } = recordingSteps();
    const exit = vi.fn();
    const done = createShutdown(steps, { logger: silent, delayMs: 5000, exit })("SIGTERM");
    expect(calls).toEqual(["drain"]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toEqual(["drain"]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(calls).toEqual(["drain", "closeServer", "stopConsumers", "stopMaintenance", "stopRuntimeConfig", "closeEvents", "closeDatabase"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("ignores a second signal", async () => {
    const { calls, steps } = recordingSteps();
    const exit = vi.fn();
    const shutdown = createShutdown(steps, { logger: silent, delayMs: 0, exit });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(calls.filter((call) => call === "drain")).toHaveLength(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("keeps its signal listeners after the first signal, so a second one never reaches Node's default action (which ends the process)", () => {
    const target = new EventEmitter();
    const shutdown = vi.fn(() => Promise.resolve());
    registerShutdownSignals(shutdown, target);

    target.emit("SIGTERM");
    expect(target.listenerCount("SIGTERM")).toBe(1);
    expect(target.listenerCount("SIGINT")).toBe(1);
    target.emit("SIGTERM");
    target.emit("SIGINT");

    expect(shutdown.mock.calls).toEqual([["SIGTERM"], ["SIGTERM"], ["SIGINT"]]);
  });

  it("exits with 1 and skips the remaining steps when a step fails", async () => {
    const { calls, steps } = recordingSteps({ stopMaintenance: () => Promise.reject(new Error("stuck")) });
    const exit = vi.fn();
    await createShutdown(steps, { logger: silent, delayMs: 0, exit })("SIGTERM");
    expect(calls).not.toContain("closeEvents");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("exits with 1 when the steps take longer than the delay plus the timeout", async () => {
    const { steps } = recordingSteps({ closeServer: () => new Promise<void>(() => undefined) });
    const exit = vi.fn();
    void createShutdown(steps, { logger: silent, delayMs: 1000, exit })("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000 + SHUTDOWN_TIMEOUT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
