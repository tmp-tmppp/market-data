import type { Clock, Logger, Store } from "../usecases/ports.js";

/**
 * How long an entry of the inbox is kept (DM-06). The streams market-data consumes (TENANTS, MARKETS, TRADING) keep
 * their messages for 30 days by default (STREAM_MAX_AGE_DAYS of each publisher, the same value in every Chance
 * service), so a redelivery can only arrive within that time; one more day is the margin for clock differences and a
 * consumer that was down. An entry older than this can never match a redelivered event, so it is purged. A publisher
 * run with a longer max age than 30 days needs this raised too. consumed_events and the price points are never
 * purged: they are the replay source and the read model (ADR-032).
 */
export const INBOX_RETENTION_MS = 31 * 24 * 3_600_000;

const DEFAULT_INTERVAL_MS = 3_600_000;

export interface MaintenanceOptions {
  store: Store;
  clock: Clock;
  logger: Logger;
  /** Time between two runs. Default one hour. */
  intervalMs?: number;
}

/**
 * The periodic housekeeping: purges the inbox entries older than INBOX_RETENTION_MS. It runs once at start and then
 * every `intervalMs`; a failure (the database is down) is logged and the next run tries again, so the timer never
 * throws into the process. Every replica runs it: the purge is idempotent.
 */
export class Maintenance {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(options: MaintenanceOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /** One purge; resolves with the number of inbox entries deleted and rejects when the store fails. */
  async runOnce(): Promise<number> {
    const olderThan = new Date(this.clock.now().getTime() - INBOX_RETENTION_MS);
    const deleted = await this.store.repositories.inbox.purge(olderThan);
    if (deleted > 0) this.logger.info({ deleted, olderThan: olderThan.toISOString() }, "Purged old inbox entries");
    return deleted;
  }

  /** The run the timer makes: never throws, and never two at once. */
  private tick(): void {
    if (this.running) return;
    this.running = this.runOnce()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, "The inbox purge failed; it will be tried again");
      })
      .finally(() => {
        this.running = null;
      });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
    this.timer.unref();
    this.tick();
  }

  /** Stops the timer and waits for the run in progress. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
