import { parseArgs } from "node:util";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { runMigrations } from "./adapters/postgres/migrate.js";
import { systemClock } from "./adapters/system.js";
import { EXIT_USAGE, parseCommandLine } from "./command-line.js";
import { createLogger } from "./logger.js";
import { REPLAY_OPTIONS, REPLAY_USAGE, replayCommandOf, runReplay } from "./replay-run.js";
import { ReplayProjections } from "./usecases/replay-projections.js";

// `npm run replay -- [--tenant <id>] [--batch-size <n>] [--keep-old] [--allow-unreadable] [--status]` (DM-09, REQ-12):
// rebuilds the projections of each tenant from consumed_events into a new version while the service keeps answering and
// consuming, compares the two versions and switches the reads to the new one (the use case ReplayProjections has the
// reasoning, README "The replay demo" the operator's view). Needs DATABASE_URL; runs the migrations first, as the
// service does at its start (not with --status). Prints one JSON line per tenant. Exit 0: every tenant switched; 1: a tenant failed; 2: none
// failed but one was held by unreadable stored events (fix the reader and rerun: a rerun reads the stored events again from
// the start; --allow-unreadable switches without them); 64: wrong use (an unknown option, a missing value, a bad --batch-size,
// no DATABASE_URL: the reason and a usage line go to stderr).
// In the cluster it runs as a second Node process of the pod: `node --max-old-space-size=96 dist/replay.js`.

async function run(): Promise<number> {
  // An unknown option, an option without its value or a stray argument is wrong use (64 and the usage line), not a failure (1).
  const parsed = parseCommandLine(() => parseArgs({ options: REPLAY_OPTIONS, strict: true }), REPLAY_USAGE);
  if (!parsed.ok) {
    console.error(parsed.message);
    return EXIT_USAGE;
  }
  const command = replayCommandOf(parsed.value.values);
  if (typeof command === "string") {
    console.error(`${command}\n${REPLAY_USAGE}`);
    return EXIT_USAGE;
  }
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) {
    console.error(`DATABASE_URL is not set.\n${REPLAY_USAGE}`);
    return EXIT_USAGE;
  }

  const logger = createLogger("warn");
  const pool = createPool(databaseUrl, 2, logger);
  try {
    // --status changes nothing, so it does not migrate either (the service has done that at its start).
    if (!command.status) await runMigrations(pool, logger);
    const store = new PostgresStore(pool, logger);
    const replay = new ReplayProjections({ store, clock: systemClock, logger });
    return await runReplay({ store, replay, print: (line) => console.log(line), note: (line) => console.error(line) }, command);
  } finally {
    await pool.end();
  }
}

run().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error("replay failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
