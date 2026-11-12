import { parseArgs } from "node:util";
import { ProvisionTenant } from "./usecases/provision-tenant.js";
import { RecordProjectionEvent } from "./usecases/record-projection-event.js";
import { runMigrations } from "./adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { systemClock } from "./adapters/system.js";
import { readLines, runBackfill } from "./backfill-run.js";
import { EXIT_USAGE, parseCommandLine } from "./command-line.js";
import { createLogger } from "./logger.js";
import type { ConsumerUseCases } from "./usecases/use-cases.js";

// `npm run backfill -- --file <events.ndjson> [--dry-run]` (README "First deployment"): loads CloudEvents that are
// older than what the streams still hold, one per line, through the same use cases as a consumed message (TenantCreated
// provisions the tenant; every other event is stored in consumed_events and projected). Idempotent and order-free. The file
// is read line by line as a stream, never whole, so a path such as /dev/stdin works (`kubectl exec -i ... --file /dev/stdin
// < events.ndjson`). Needs DATABASE_URL and runs the migrations first; --dry-run only reads and classifies, touches no
// database and needs no DATABASE_URL. Prints one JSON line for each problem line and a last JSON line with the counts.
// Exit 0: done; 1: a line failed or the run did; 64: wrong use.

const USAGE = "Usage: backfill --file <events.ndjson> [--dry-run]";

async function run(): Promise<number> {
  const parsed = parseCommandLine(() => parseArgs({ options: { file: { type: "string" }, "dry-run": { type: "boolean", default: false } }, strict: true }), USAGE);
  if (!parsed.ok) {
    console.error(parsed.message);
    return EXIT_USAGE;
  }
  const { values } = parsed.value;
  const file = values.file?.trim();
  if (!file) {
    console.error(`--file is required.\n${USAGE}`);
    return EXIT_USAGE;
  }
  const dryRun = values["dry-run"] === true;
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!dryRun && !databaseUrl) {
    console.error(`DATABASE_URL is not set.\n${USAGE}`);
    return EXIT_USAGE;
  }

  const print = (line: string): void => console.log(line);

  if (dryRun) {
    // Nothing is written, so no use case is ever called.
    const refuse = (): never => {
      throw new Error("A dry run never calls a use case");
    };
    const useCases: ConsumerUseCases = { provisionTenant: { execute: refuse }, recordProjectionEvent: { execute: refuse } };
    return (await runBackfill({ useCases, dryRun, print }, readLines(file))).exitCode;
  }

  const logger = createLogger("warn");
  const pool = createPool(databaseUrl ?? "", 2, logger);
  try {
    await runMigrations(pool, logger);
    const store = new PostgresStore(pool, logger);
    const deps = { store, clock: systemClock, logger };
    const useCases: ConsumerUseCases = { provisionTenant: new ProvisionTenant(deps), recordProjectionEvent: new RecordProjectionEvent(deps) };
    return (await runBackfill({ useCases, dryRun, print }, readLines(file))).exitCode;
  } finally {
    await pool.end();
  }
}

run().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error("backfill failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
