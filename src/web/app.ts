import type { FastifyInstance } from "fastify";
import type { Logger as PinoLogger } from "pino";
import { DEFAULT_GRAPHQL_SETTINGS } from "../config.js";
import type { GraphqlSettings } from "../config.js";
import type { ConsumerUseCases, MarketDataUseCases } from "../usecases/use-cases.js";
import { authenticate } from "./auth.js";
import type { AuthOptions } from "./auth.js";
import { createBaseApp } from "./context.js";
import { registerGraphqlEndpoint } from "./graphql/endpoint.js";
import { registerHealthRoutes } from "./routes/health.js";
import type { HealthChecks } from "./routes/health.js";
import { registerLocalEventRoutes } from "./routes/local-events.js";
import { registerMarketRoutes } from "./routes/markets.js";

export interface WebDeps {
  logger: PinoLogger;
  useCases: MarketDataUseCases;
  auth: AuthOptions;
  health: HealthChecks;
  /** The GraphQL endpoint's limits and introspection switch (default: the production values, introspection off). */
  graphql?: GraphqlSettings;
  /** The consumers' use cases for the local events route (APP_ENV=local without NATS); null or absent in every other mode. */
  local?: ConsumerUseCases | null;
  /** Records the request metrics (src/adapters/metrics/metrics.ts); optional, most tests leave it out. */
  metrics?: { attach(app: FastifyInstance): void };
  /** Told the `extensions.code` of every error in the answers of the GraphQL endpoint (the metrics count them). */
  onGraphqlErrors?: (codes: ReadonlyArray<string | undefined>) => void;
}

/** The only request body is one CloudEvent of the local events route: 16 KiB is generous. */
const BODY_LIMIT = 16 * 1024;

/** The application (port 8080, gateway prefix /v1/market-data), not started: tests call it with app.inject. */
export function buildApp(deps: WebDeps): FastifyInstance {
  const app = createBaseApp({ logger: deps.logger, bodyLimit: BODY_LIMIT });
  // Before the routes and the GraphQL scope (which inherits it), so that every response is counted, also the 404 of a
  // path that matches no route.
  deps.metrics?.attach(app);
  registerHealthRoutes(app, deps.health);
  const hook = authenticate(deps.auth);
  registerMarketRoutes(app, deps.useCases, hook);
  registerGraphqlEndpoint(app, deps.useCases, hook, deps.graphql ?? DEFAULT_GRAPHQL_SETTINGS, deps.onGraphqlErrors);
  if (deps.local) registerLocalEventRoutes(app, deps.local, hook);
  return app;
}
