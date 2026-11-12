import { HISTORY_MAX_POINTS_LIMIT, HISTORY_MAX_POINTS_MIN } from "./domain/history.js";
import type { HistoryRules } from "./usecases/ports.js";

// Typed configuration, validated once at startup. A bad or missing setting stops the start with a message that names
// every problem; values are never printed (they may hold passwords).
// ADR-037: defaults, then the watched runtime file, then environment variables (the chart's ConfigMap and Secret), so
// an environment variable always wins. The runtime keys (RUNTIME_KEYS) are read here as their startup values; the
// watcher of RUNTIME_CONFIG_FILE (src/adapters/runtime-config.ts) applies the file with parseRuntimeFile while the
// service runs, without a restart, for every runtime key the environment does not set (the chart sets none there).

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

/**
 * Token contract v2 (all services): the tenant is the single alias of the `organization` claim (the tenant id), the
 * tenant role is that organization's group ("/tenant-admin" or "/trader" in organization.<alias>.groups), and
 * `platform-admin` is a realm role in `rolesClaim`.
 */
export interface AuthConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
  /** Dot path of the realm roles (only `platform-admin` is read from it). */
  rolesClaim: string;
  /** Dot path of the organization claim. */
  tenantClaim: string;
}

/**
 * The GraphQL endpoint (REQ-17, ADR-023, contracts/graphql/schema.graphql), startup settings only. The limits refuse a
 * query before it runs (depth: levels of nested fields, introspection excluded; complexity: see src/web/graphql/limits.ts).
 */
export interface GraphqlSettings {
  /** Whether `__schema` and `__type` are answered. Default false: only APP_ENV=local turns it on by default. */
  introspection: boolean;
  maxDepth: number;
  maxComplexity: number;
}

/** The defaults outside local mode; the deepest legal query of the schema has 3 levels. */
export const DEFAULT_GRAPHQL_SETTINGS: GraphqlSettings = { introspection: false, maxDepth: 5, maxComplexity: 5000 };

/** The bounds of the two limits; the Helm chart's schema repeats them. */
export const GRAPHQL_MAX_DEPTH_RANGE = { min: 1, max: 10 } as const;
export const GRAPHQL_MAX_COMPLEXITY_RANGE = { min: 10, max: 100_000 } as const;

/** The keys that may change while the service runs. */
export interface RuntimeSettings {
  logLevel: string;
  historyRules: HistoryRules;
}

export interface Config {
  /** "local" allows in-memory fallbacks; any other value (default "production") requires every setting. */
  appEnv: string;
  isLocal: boolean;
  /** The public API (gateway prefix /v1/market-data) and the health probes. market-data has no internal port. */
  port: number;
  /** The port of the separate listener that serves GET /metrics; never the API port. */
  metricsPort: number;
  /** Startup value of a runtime key. */
  logLevel: string;
  runtimeConfigFile: string | null;
  runtimeConfigPollMs: number;
  /** Null only in local mode: the service then keeps its data in memory. */
  databaseUrl: string | null;
  databasePoolMax: number;
  /** Null only in local mode: nothing is consumed then (the local events route feeds the read model instead). */
  natsUrl: string | null;
  auth: AuthConfig;
  graphql: GraphqlSettings;
  /** Startup value of the runtime keys. */
  historyRules: HistoryRules;
  shutdownDelayMs: number;
}

/** The longest drain delay: with the 10 seconds a shutdown may then take, it ends inside the chart's 30 seconds. */
export const MAX_SHUTDOWN_DELAY_MS = 15_000;

/** The keys RUNTIME_CONFIG_FILE may set; any other key in the file is reported and ignored. */
export const RUNTIME_KEYS = ["LOG_LEVEL", "HISTORY_MAX_POINTS", "HISTORY_ENABLED"] as const;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

// Local defaults of the token settings, matching a Keycloak on port 8081 of the developer's machine (see README).
// Tokens are always verified.
const LOCAL_AUTH = {
  jwksUrl: "http://localhost:8081/realms/chance/protocol/openid-connect/certs",
  issuer: "http://localhost:8081/realms/chance",
  audience: "chance",
};

type Source = Readonly<Record<string, string | undefined>>;

/** Readers of one source of settings; each records its problems instead of throwing, so all of them are reported. */
function readerOf(source: Source, problems: string[]) {
  const text = (name: string): string | undefined => {
    const value = source[name]?.trim();
    return value ? value : undefined;
  };
  // `fallback` is the value of a key that is not set; `onInvalid` (default: the same) the value of a key that is set but
  // fails its check, which the runtime file sets to the value in force.
  const integer = (name: string, fallback: number, min: number, max: number, onInvalid: number = fallback): number => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return onInvalid;
    }
    return value;
  };
  const boolean = (name: string, fallback: boolean, onInvalid: boolean = fallback): boolean => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    if (raw === "true") return true;
    if (raw === "false") return false;
    problems.push(`${name} must be true or false`);
    return onInvalid;
  };
  const choice = <T extends string>(name: string, allowed: readonly T[], fallback: T, onInvalid: T = fallback): T => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    problems.push(`${name} must be one of: ${allowed.join(", ")}`);
    return onInvalid;
  };
  const url = (name: string, protocols: readonly string[], value: string | undefined): string | null => {
    if (value === undefined) return null;
    try {
      const parsed = new URL(value);
      if (protocols.includes(parsed.protocol) && parsed.username === "" && parsed.password === "") return value;
      // A database URL carries its login: only the other URLs must not.
      if (protocols.includes(parsed.protocol) && protocols.includes("postgres:")) return value;
    } catch {
      // Reported below.
    }
    problems.push(`${name} must be a URL starting with ${protocols.map((p) => `${p}//`).join(" or ")} (only a database URL may hold a user name and password)`);
    return null;
  };
  /**
   * The runtime keys, read on top of `base` (a key that is not set). A key that is set but invalid takes its value from
   * `inForce` (default `base`), so a typo in the runtime file never undoes an override that is running (fail closed:
   * HISTORY_ENABLED=flase keeps a pause in force).
   */
  const runtime = (base: RuntimeSettings, inForce: RuntimeSettings = base): RuntimeSettings => ({
    logLevel: choice("LOG_LEVEL", LOG_LEVELS, base.logLevel, inForce.logLevel),
    historyRules: {
      maxPoints: integer("HISTORY_MAX_POINTS", base.historyRules.maxPoints, HISTORY_MAX_POINTS_MIN, HISTORY_MAX_POINTS_LIMIT, inForce.historyRules.maxPoints),
      enabled: boolean("HISTORY_ENABLED", base.historyRules.enabled, inForce.historyRules.enabled),
    },
  });
  return { text, integer, boolean, choice, url, runtime };
}

/** The defaults of the runtime keys. */
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  logLevel: "info",
  historyRules: { maxPoints: 1000, enabled: true },
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const read = readerOf(env, problems);
  const { text, integer, boolean, url } = read;

  const appEnv = text("APP_ENV") ?? "production";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(appEnv)) problems.push("APP_ENV must be lowercase letters, digits and dashes");
  const isLocal = appEnv === "local";
  const required = (name: string, hint: string): string | undefined => {
    const value = text(name);
    if (value === undefined && !isLocal) problems.push(`${name} is required (${hint}); only APP_ENV=local may leave it out`);
    return value;
  };

  const runtime = read.runtime(DEFAULT_RUNTIME_SETTINGS);

  const databaseUrl = url("DATABASE_URL", ["postgres:", "postgresql:"], required("DATABASE_URL", "the connection string of the service's PostgreSQL database"));
  const natsUrl = url("NATS_URL", ["nats:", "tls:"], required("NATS_URL", "the NATS server"));

  const authText = (name: string, local: string, hint: string): string => required(name, hint) ?? local;
  const jwksUrl = url("AUTH_JWKS_URL", ["http:", "https:"], authText("AUTH_JWKS_URL", LOCAL_AUTH.jwksUrl, "the JWKS URL of the identity provider"));
  const auth: AuthConfig = {
    jwksUrl: jwksUrl ?? LOCAL_AUTH.jwksUrl,
    issuer: authText("AUTH_ISSUER", LOCAL_AUTH.issuer, "the issuer (iss) of the tokens"),
    audience: authText("AUTH_AUDIENCE", LOCAL_AUTH.audience, "the audience (aud) of the tokens"),
    rolesClaim: text("AUTH_ROLES_CLAIM") ?? "realm_access.roles",
    tenantClaim: text("AUTH_TENANT_CLAIM") ?? "organization",
  };

  const port = integer("PORT", 8080, 1, 65535);
  const metricsPort = integer("METRICS_PORT", 9464, 1, 65535);
  // The API port never serves /metrics (so the gateway can never route it): the two listeners need two ports.
  if (metricsPort === port) problems.push("METRICS_PORT must differ from PORT (the API port never serves /metrics)");

  const config: Config = {
    appEnv,
    isLocal,
    port,
    metricsPort,
    logLevel: runtime.logLevel,
    runtimeConfigFile: text("RUNTIME_CONFIG_FILE") ?? null,
    runtimeConfigPollMs: integer("RUNTIME_CONFIG_POLL_MS", 10_000, 1000, 3_600_000),
    databaseUrl,
    databasePoolMax: integer("DATABASE_POOL_MAX", 5, 1, 50),
    natsUrl,
    auth,
    graphql: {
      // No introspection in production: the schema file in contracts/ is the documentation; a local run keeps it on.
      introspection: boolean("GRAPHQL_INTROSPECTION", isLocal),
      maxDepth: integer("GRAPHQL_MAX_DEPTH", DEFAULT_GRAPHQL_SETTINGS.maxDepth, GRAPHQL_MAX_DEPTH_RANGE.min, GRAPHQL_MAX_DEPTH_RANGE.max),
      maxComplexity: integer("GRAPHQL_MAX_COMPLEXITY", DEFAULT_GRAPHQL_SETTINGS.maxComplexity, GRAPHQL_MAX_COMPLEXITY_RANGE.min, GRAPHQL_MAX_COMPLEXITY_RANGE.max),
    },
    historyRules: runtime.historyRules,
    // Nobody routes traffic to a local run, so it does not wait.
    shutdownDelayMs: integer("SHUTDOWN_DELAY_MS", isLocal ? 0 : 5000, 0, MAX_SHUTDOWN_DELAY_MS),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** The startup values of the runtime keys. */
export function runtimeSettingsOf(config: Config): RuntimeSettings {
  return { logLevel: config.logLevel, historyRules: { ...config.historyRules } };
}

export interface RuntimeFileResult {
  settings: RuntimeSettings;
  /** Invalid values and unknown keys; the service logs them, and an invalid key keeps the value in force. */
  problems: string[];
}

/** The runtime keys that the environment sets: they win over the runtime file (ADR-037). */
export function runtimeKeysInEnv(env: NodeJS.ProcessEnv): string[] {
  return RUNTIME_KEYS.filter((key) => (env[key] ?? "").trim() !== "");
}

/**
 * Reads the runtime file: lines KEY=value, blank lines and lines starting with # are skipped, the last of repeated
 * keys counts. A key that is not in the file takes its startup value (defaults, then env), so deleting a line undoes
 * an override. A key whose value is invalid keeps `inForce`, the settings now running (default: the startup values), so
 * a typo such as HISTORY_ENABLED=flase never re-enables a history that was paused; an unknown or misspelled key is only
 * reported. A key in `setInEnv` keeps its environment value (ADR-037: env wins over the file) and is reported.
 * Never throws: a running service keeps working with what it has.
 */
export function parseRuntimeFile(content: string, startup: RuntimeSettings, setInEnv: readonly string[] = [], inForce: RuntimeSettings = startup): RuntimeFileResult {
  const problems: string[] = [];
  const values: Record<string, string> = {};
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!(RUNTIME_KEYS as readonly string[]).includes(key)) {
      problems.push(`Line ${index + 1}: ${key || "a line without KEY=value"} is not a runtime key (${RUNTIME_KEYS.join(", ")})`);
      continue;
    }
    values[key] = line.slice(separator + 1).trim();
  }
  for (const key of setInEnv) {
    if (key in values) {
      problems.push(`${key} is set in the environment, which wins over the runtime file (ADR-037); the file's value is ignored`);
      delete values[key];
    }
  }
  const settings = readerOf(values, problems).runtime(startup, inForce);
  return { settings, problems };
}
