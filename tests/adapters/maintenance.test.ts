import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INBOX_RETENTION_MS, Maintenance } from "../../src/adapters/maintenance.js";
import type { InboxEntry, InboxRepository, Store } from "../../src/usecases/ports.js";
import { RecordingLogger, TestClock } from "../support/fakes.js";

// The store is only asked for its inbox: the rest of the Store port is not used by the maintenance and fails loudly if it is.
class FakeInbox implements InboxRepository {
  readonly purged: Date[] = [];
  deleted = 3;
  failure: Error | null = null;
  gate: Promise<void> | null = null;
  record(_entry: InboxEntry): Promise<boolean> {
    return Promise.reject(new Error("not used"));
  }
  async purge(olderThan: Date): Promise<number> {
    this.purged.push(olderThan);
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
    return this.deleted;
  }
}

function storeOf(inbox: InboxRepository): Store {
  const unused = (): never => {
    throw new Error("not used");
  };
  return {
    repositories: { inbox, tenants: { provision: unused, isRegistered: unused, list: unused }, parkedEvents: { park: unused, list: unused, remove: unused } },
    transaction: unused,
    forTenant: unused,
    ensureTenant: unused,
    ping: unused,
  };
}

describe("Maintenance", () => {
  let inbox: FakeInbox;
  let clock: TestClock;
  let logger: RecordingLogger;
  let maintenance: Maintenance;

  beforeEach(() => {
    vi.useFakeTimers();
    inbox = new FakeInbox();
    clock = new TestClock();
    logger = new RecordingLogger();
    maintenance = new Maintenance({ store: storeOf(inbox), clock, logger, intervalMs: 1000 });
  });
  afterEach(async () => {
    await maintenance.stop();
    vi.useRealTimers();
  });

  it("keeps the inbox for 31 days: the streams keep 30 days of messages by default plus one day of margin (DM-06)", () => {
    expect(INBOX_RETENTION_MS).toBe(31 * 24 * 3_600_000);
  });

  it("runOnce purges the entries older than the retention and returns how many it deleted", async () => {
    const deleted = await maintenance.runOnce();

    expect(deleted).toBe(3);
    expect(inbox.purged).toEqual([new Date(clock.now().getTime() - INBOX_RETENTION_MS)]);
    expect(logger.lines.filter((line) => line.level === "info")).toHaveLength(1);
  });

  it("runOnce logs nothing when there was nothing to delete, and rejects when the store fails", async () => {
    inbox.deleted = 0;
    expect(await maintenance.runOnce()).toBe(0);
    expect(logger.lines).toHaveLength(0);

    inbox.failure = new Error("database is down");
    await expect(maintenance.runOnce()).rejects.toThrow("database is down");
  });

  it("start purges at once and then every interval; stop ends the timer", async () => {
    maintenance.start();
    maintenance.start(); // a second start changes nothing
    await vi.advanceTimersByTimeAsync(0);
    expect(inbox.purged).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(inbox.purged).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(inbox.purged).toHaveLength(4);

    await maintenance.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(inbox.purged).toHaveLength(4);
  });

  it("a failing run is logged as a warning and never thrown out of the timer; the next run tries again", async () => {
    inbox.failure = new Error("connection refused");
    maintenance.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.lines.filter((line) => line.level === "warn")).toHaveLength(1);

    inbox.failure = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(inbox.purged).toHaveLength(2);
    expect(logger.lines.filter((line) => line.level === "info")).toHaveLength(1);
  });

  it("never starts a second purge while one is still running, and stop waits for it", async () => {
    let release: () => void = () => undefined;
    inbox.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    maintenance.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(inbox.purged).toHaveLength(1);

    let stopped = false;
    const stopping = maintenance.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
