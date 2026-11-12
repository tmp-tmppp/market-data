import { parseArgs } from "node:util";
import type { HandleResult } from "./adapters/nats/message-handlers.js";
import { handleProjectionMessage, handleTenantCreatedMessage } from "./adapters/nats/message-handlers.js";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { systemClock } from "./adapters/system.js";
import { EXIT_USAGE, parseCommandLine } from "./command-line.js";
import { createLogger } from "./logger.js";
import type { Logger } from "./usecases/ports.js";
import { ProvisionTenant } from "./usecases/provision-tenant.js";
import { RecordProjectionEvent } from "./usecases/record-projection-event.js";
import { MARKET_EVENTS_CONSUMER, TENANT_CREATED_CONSUMER, TRADE_EVENTS_CONSUMER } from "./usecases/support.js";

// `npm run parked -- [--consumer <name>] [--retry]`: lists the events a consumer gave up on after PARK_AFTER_DELIVERIES
// failed deliveries, or parked at once because they could not be attributed to a tenant (shared.parked_events). With
// --retry each one runs again through the handler of its consumer, and a row is deleted only when the handler
// acknowledges the message (the inbox and the consumed_events keys make a repeat harmless). Exit 0: nothing left
// failing; 1: an event is still failing; 64: wrong use.

const LIST_LIMIT = 1000;
const CONSUMERS = [TENANT_CREATED_CONSUMER, MARKET_EVENTS_CONSUMER, TRADE_EVENTS_CONSUMER];
const USAGE = `Usage: parked [--consumer <${CONSUMERS.join("|")}>] [--retry]`;

async function run(): Promise<number> {
  const parsed = parseCommandLine(
    () => parseArgs({ options: { consumer: { type: "string" }, retry: { type: "boolean", default: false } }, strict: true }),
    USAGE,
  );
  if (!parsed.ok) {
    console.error(parsed.message);
    return EXIT_USAGE;
  }
  const { values } = parsed.value;
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) {
    console.error(`DATABASE_URL is not set.\n${USAGE}`);
    return EXIT_USAGE;
  }

  const logger = createLogger("warn");
  const pool = createPool(databaseUrl, 2, logger);
  try {
    const store = new PostgresStore(pool, logger);
    const deps = { store, clock: systemClock, logger };
    const recordProjectionEvent = new RecordProjectionEvent(deps);
    const handlers: Record<string, (data: Uint8Array, log: Logger) => Promise<HandleResult>> = {
      [TENANT_CREATED_CONSUMER]: (data, log) => handleTenantCreatedMessage(data, new ProvisionTenant({ store, clock: systemClock, logger: log }), log),
      [MARKET_EVENTS_CONSUMER]: (data, log) => handleProjectionMessage(data, recordProjectionEvent, log),
      [TRADE_EVENTS_CONSUMER]: (data, log) => handleProjectionMessage(data, recordProjectionEvent, log),
    };

    const parked = await store.repositories.parkedEvents.list(values.consumer ?? null, LIST_LIMIT);
    if (parked.length === 0) console.log("No parked events.");
    let failed = 0;
    for (const event of parked) {
      const head = `${event.consumer} #${String(event.streamSequence)} ${event.subject} (${String(event.deliveries)} deliveries, parked ${event.parkedAt.toISOString()})`;
      if (!values.retry) {
        console.log(`${head}\n  ${event.reason}`);
        continue;
      }
      const handler = handlers[event.consumer];
      if (!handler) {
        console.log(`${head}: unknown consumer, left parked`);
        failed += 1;
        continue;
      }
      const result = await handler(new TextEncoder().encode(event.payload), logger);
      if (result.kind === "ack") {
        await store.repositories.parkedEvents.remove(event.consumer, event.streamSequence);
        console.log(`${head}: done, removed`);
      } else {
        console.log(`${head}: still failing, left parked (${result.reason})`);
        failed += 1;
      }
    }
    return failed === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

run().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error("parked failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
