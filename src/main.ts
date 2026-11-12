import { createRemoteJWKSet } from "jose";
import type pg from "pg";
import { Maintenance } from "./adapters/maintenance.js";
import { MemoryStore } from "./adapters/memory/memory-store.js";
import { createMarketDataMetrics } from "./adapters/metrics/market-data-metrics.js";
import { createMetrics, startMetricsServer } from "./adapters/metrics/metrics.js";
import { JetStreamConsumer, MARKETS_CONSUMER, TENANTS_CONSUMER, TRADING_CONSUMER } from "./adapters/nats/jetstream-consumer.js";
import { handleProjectionMessage, handleTenantCreatedMessage } from "./adapters/nats/message-handlers.js";
import { runMigrations } from "./adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { RuntimeConfigWatcher, RuntimeSettingsHolder } from "./adapters/runtime-config.js";
import { systemClock } from "./adapters/system.js";
import { ConfigError, loadConfig, runtimeKeysInEnv, runtimeSettingsOf } from "./config.js";
import { createLogger } from "./logger.js";
import { createShutdown, registerShutdownSignals } from "./shutdown.js";
import { GetHistory } from "./usecases/get-history.js";
import { GetMarket } from "./usecases/get-market.js";
import { ListMarkets } from "./usecases/list-markets.js";
import type { Logger, ParkedEvent, Store } from "./usecases/ports.js";
import { ProvisionTenant } from "./usecases/provision-tenant.js";
import { RecordProjectionEvent } from "./usecases/record-projection-event.js";
import { buildApp } from "./web/app.js";
import { tenantOfRequest } from "./web/auth.js";

// Composition root: configuration -> adapters -> use cases -> the web application, the three consumers and the
// maintenance timer. Nothing else wires things together. market-data publishes nothing (no outbox, no relay) and has one
// port: the public API and the health probes.

const MIGRATION_ATTEMPTS = 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  logger.info({ appEnv: config.appEnv }, "Starting market-data");

  // Runtime settings (ADR-037): the history use case reads its limits from the holder on every request; the watcher
  // replaces them, and the log level, when the mounted file changes. A runtime key that the environment sets keeps its
  // environment value whatever the file says (`setInEnv`). Without a file the startup values stay.
  const rules = new RuntimeSettingsHolder(runtimeSettingsOf(config));
  const runtimeConfig = config.runtimeConfigFile
    ? new RuntimeConfigWatcher({
        file: config.runtimeConfigFile,
        pollMs: config.runtimeConfigPollMs,
        startup: runtimeSettingsOf(config),
        setInEnv: runtimeKeysInEnv(process.env),
        current: () => rules.get(),
        logger,
        onChange: (settings) => {
          rules.set(settings);
          logger.level = settings.logLevel;
        },
      })
    : null;

  // Adapters. Without a setting, only APP_ENV=local falls back to memory; loadConfig has refused anything else.
  let store: Store;
  let pool: pg.Pool | null = null;
  let maintenance: Maintenance | null = null;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl, config.databasePoolMax, logger);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runMigrations(pool, logger);
        break;
      } catch (error) {
        if (attempt >= MIGRATION_ATTEMPTS) throw error;
        logger.warn({ attempt, err: error }, "The database is not ready for migrations, trying again");
        await sleep(3000);
      }
    }
    store = new PostgresStore(pool, logger);
    maintenance = new Maintenance({ store, clock: systemClock, logger });
  } else {
    logger.warn({}, "DATABASE_URL is not set: keeping all data in memory (APP_ENV=local)");
    // A tenant is registered on its first event, because no TenantCreated arrives without a database and a broker.
    store = new MemoryStore({ autoProvision: true, logger });
  }

  // Use cases.
  const deps = { store, clock: systemClock, logger };
  const useCases = {
    listMarkets: new ListMarkets(deps),
    getMarket: new GetMarket(deps),
    getHistory: new GetHistory({ ...deps, rules }),
  };
  const provisionTenant = new ProvisionTenant(deps);
  // Request metrics: the tenant label is the tenant of the verified token (request.auth is set only after the check).
  // The projection and GraphQL metrics of the service are on the same registry.
  const metrics = createMetrics({ tenantOf: tenantOfRequest });
  const marketData = createMarketDataMetrics(metrics.registry);
  const recordProjectionEvent = new RecordProjectionEvent({ ...deps, observer: marketData.observer });

  // True from the first SIGTERM on; the readiness probe reads it.
  let shuttingDown = false;

  const getKey = createRemoteJWKSet(new URL(config.auth.jwksUrl), { timeoutDuration: 3000 });
  const app = buildApp({
    logger,
    useCases,
    auth: {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      getKey,
      rolesClaim: config.auth.rolesClaim,
      tenantClaim: config.auth.tenantClaim,
    },
    health: { ping: () => store.ping(), isDraining: () => shuttingDown },
    graphql: config.graphql,
    metrics,
    onGraphqlErrors: marketData.graphqlErrors,
    // A local run without a broker has no consumers: the events route runs their use cases instead.
    local: config.isLocal && !config.natsUrl ? { provisionTenant, recordProjectionEvent } : null,
  });

  // The three consumers (only with a broker): TenantCreated provisions a tenant's schema; the MARKETS and TRADING
  // consumers store every event they can attribute in consumed_events and project it. The use case logs one line per
  // event at info, so the handler's own lines for the same event go to debug.
  const park = (event: ParkedEvent): Promise<void> => store.repositories.parkedEvents.park(event);
  const handlerLog: Logger = {
    info: (fields, message) => logger.debug(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
  };
  const consumers = config.natsUrl
    ? [
        new JetStreamConsumer({
          url: config.natsUrl,
          spec: TENANTS_CONSUMER,
          handle: (data) => handleTenantCreatedMessage(data, provisionTenant, logger),
          park,
          logger,
        }),
        new JetStreamConsumer({
          url: config.natsUrl,
          spec: MARKETS_CONSUMER,
          handle: (data) => handleProjectionMessage(data, recordProjectionEvent, handlerLog),
          park,
          logger,
        }),
        new JetStreamConsumer({
          url: config.natsUrl,
          spec: TRADING_CONSUMER,
          handle: (data) => handleProjectionMessage(data, recordProjectionEvent, handlerLog),
          park,
          logger,
        }),
      ]
    : [];
  if (consumers.length === 0) logger.warn({}, "NATS_URL is not set: nothing is consumed; POST /local/events feeds the read model (APP_ENV=local)");

  // The first read of the runtime file comes before the first request, so the startup log level and rules are the file's.
  await runtimeConfig?.start();

  await app.listen({ host: "0.0.0.0", port: config.port });
  logger.info({ port: config.port }, "Listening");
  // GET /metrics has a listener of its own: the API port never serves it, so the gateway can never route it.
  const metricsServer = await startMetricsServer(metrics.registry, { port: config.metricsPort });
  logger.info({ port: metricsServer.port }, "Serving metrics");
  maintenance?.start();
  for (const consumer of consumers) consumer.start();

  // Graceful shutdown (SIGTERM from Kubernetes, SIGINT from a terminal): src/shutdown.ts has the order and the timing.
  const shutdown = createShutdown(
    {
      drain: () => {
        shuttingDown = true;
      },
      closeServer: async () => {
        await app.close();
        await metricsServer.close();
      },
      stopConsumers: async () => {
        await Promise.all(consumers.map((consumer) => consumer.stop()));
      },
      stopMaintenance: async () => {
        await maintenance?.stop();
      },
      stopRuntimeConfig: async () => {
        await runtimeConfig?.stop();
      },
      // Every consumer owns its connection to the broker and closes it in stop().
      closeEvents: () => Promise.resolve(),
      closeDatabase: async () => {
        await pool?.end();
      },
    },
    { logger, delayMs: config.shutdownDelayMs, exit: (code) => process.exit(code) },
  );
  registerShutdownSignals(shutdown);
}

main().catch((error: unknown) => {
  console.error("market-data failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
