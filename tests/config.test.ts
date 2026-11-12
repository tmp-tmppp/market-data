import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_GRAPHQL_SETTINGS, DEFAULT_RUNTIME_SETTINGS, loadConfig, parseRuntimeFile, runtimeKeysInEnv, runtimeSettingsOf } from "../src/config.js";

const PRODUCTION = {
  DATABASE_URL: "postgres://market-data:secret@db:5432/market-data", // hooks:allow test fixture, not a real password
  NATS_URL: "nats://nats:4222",
  AUTH_JWKS_URL: "http://keycloak:8080/realms/chance/protocol/openid-connect/certs",
  AUTH_ISSUER: "https://auth.example/realms/chance",
  AUTH_AUDIENCE: "chance",
};

function problemsOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
}

describe("METRICS_PORT (the listener that serves GET /metrics)", () => {
  it("defaults to 9464, also in local mode", () => {
    expect(loadConfig({ APP_ENV: "local" }).metricsPort).toBe(9464);
    expect(loadConfig({ APP_ENV: "local", METRICS_PORT: "9100" }).metricsPort).toBe(9100);
  });

  it.each(["0", "65536", "-1", "9464.5", "abc"])("rejects %s", (value) => {
    expect(() => loadConfig({ APP_ENV: "local", METRICS_PORT: value })).toThrow("METRICS_PORT must be an integer from 1 to 65535");
  });

  it("must differ from PORT: the API port never serves /metrics", () => {
    const problem = "METRICS_PORT must differ from PORT (the API port never serves /metrics)";
    expect(() => loadConfig({ APP_ENV: "local", PORT: "9000", METRICS_PORT: "9000" })).toThrow(problem);
    expect(() => loadConfig({ APP_ENV: "local", PORT: "9464" })).toThrow(problem);
    expect(loadConfig({ APP_ENV: "local", PORT: "9464", METRICS_PORT: "9465" })).toMatchObject({ port: 9464, metricsPort: 9465 });
  });
});

describe("loadConfig", () => {
  it("runs locally with in-memory defaults and no wait on shutdown", () => {
    const config = loadConfig({ APP_ENV: "local" });
    expect(config).toMatchObject({ isLocal: true, port: 8080, databaseUrl: null, natsUrl: null, shutdownDelayMs: 0, historyRules: DEFAULT_RUNTIME_SETTINGS.historyRules });
    expect(config.auth).toMatchObject({ audience: "chance", rolesClaim: "realm_access.roles", tenantClaim: "organization" });
  });

  it("requires the database, the broker and the token settings outside local mode", () => {
    const problems = problemsOf({});
    for (const name of ["DATABASE_URL", "NATS_URL", "AUTH_JWKS_URL", "AUTH_ISSUER", "AUTH_AUDIENCE"]) {
      expect(problems.some((problem) => problem.startsWith(name))).toBe(true);
    }
    expect(loadConfig(PRODUCTION)).toMatchObject({ isLocal: false, port: 8080, shutdownDelayMs: 5000, databasePoolMax: 5, runtimeConfigPollMs: 10_000 });
  });

  it("reads every setting and reports all problems at once, never the values", () => {
    const config = loadConfig({ ...PRODUCTION, PORT: "9000", HISTORY_MAX_POINTS: "500", HISTORY_ENABLED: "false", LOG_LEVEL: "debug", AUTH_ROLES_CLAIM: "roles", RUNTIME_CONFIG_FILE: "/etc/market-data/runtime/runtime.env" });
    expect(config).toMatchObject({ port: 9000, logLevel: "debug", historyRules: { maxPoints: 500, enabled: false }, runtimeConfigFile: "/etc/market-data/runtime/runtime.env" });
    expect(config.auth.rolesClaim).toBe("roles");
    const problems = problemsOf({ ...PRODUCTION, PORT: "0", HISTORY_ENABLED: "yes", HISTORY_MAX_POINTS: "9", DATABASE_URL: "mysql://x", APP_ENV: "Prod", NATS_URL: "nats://user:pw@nats:4222" });
    expect(problems).toHaveLength(6);
    expect(problems.join("\n")).not.toContain("secret");
  });
});

describe("GraphQL settings", () => {
  it("has no introspection in production, a depth limit of 5 and a complexity limit of 5000 by default", () => {
    expect(loadConfig(PRODUCTION).graphql).toEqual({ introspection: false, maxDepth: 5, maxComplexity: 5000 });
    expect(DEFAULT_GRAPHQL_SETTINGS).toEqual(loadConfig(PRODUCTION).graphql);
  });

  it("turns introspection on by default only for APP_ENV=local, and lets the environment decide either way", () => {
    expect(loadConfig({ APP_ENV: "local" }).graphql.introspection).toBe(true);
    expect(loadConfig({ APP_ENV: "local", GRAPHQL_INTROSPECTION: "false" }).graphql.introspection).toBe(false);
    expect(loadConfig({ ...PRODUCTION, GRAPHQL_INTROSPECTION: "true" }).graphql.introspection).toBe(true);
    expect(loadConfig({ ...PRODUCTION, APP_ENV: "staging" }).graphql.introspection).toBe(false);
  });

  it("reads the two limits and keeps them within their bounds, naming the key and never the value", () => {
    expect(loadConfig({ ...PRODUCTION, GRAPHQL_MAX_DEPTH: "3", GRAPHQL_MAX_COMPLEXITY: "250" }).graphql).toMatchObject({ maxDepth: 3, maxComplexity: 250 });
    expect(loadConfig({ ...PRODUCTION, GRAPHQL_MAX_DEPTH: "1", GRAPHQL_MAX_COMPLEXITY: "100000" }).graphql).toMatchObject({ maxDepth: 1, maxComplexity: 100_000 });
    expect(loadConfig({ ...PRODUCTION, GRAPHQL_MAX_DEPTH: "10", GRAPHQL_MAX_COMPLEXITY: "10" }).graphql).toMatchObject({ maxDepth: 10, maxComplexity: 10 });
    expect(problemsOf({ ...PRODUCTION, GRAPHQL_MAX_DEPTH: "0" })).toEqual(["GRAPHQL_MAX_DEPTH must be an integer from 1 to 10"]);
    expect(problemsOf({ ...PRODUCTION, GRAPHQL_MAX_DEPTH: "11" })).toHaveLength(1);
    expect(problemsOf({ ...PRODUCTION, GRAPHQL_MAX_DEPTH: "deep" })).toHaveLength(1);
    expect(problemsOf({ ...PRODUCTION, GRAPHQL_MAX_COMPLEXITY: "9" })).toEqual(["GRAPHQL_MAX_COMPLEXITY must be an integer from 10 to 100000"]);
    expect(problemsOf({ ...PRODUCTION, GRAPHQL_MAX_COMPLEXITY: "100001" })).toHaveLength(1);
    expect(problemsOf({ ...PRODUCTION, GRAPHQL_INTROSPECTION: "yes" })).toEqual(["GRAPHQL_INTROSPECTION must be true or false"]);
  });
});

describe("runtime file (ADR-037)", () => {
  const startup = runtimeSettingsOf(loadConfig({ APP_ENV: "local" }));

  it("applies runtime keys, falls back to startup values for the rest and reports unknown keys", () => {
    const { settings, problems } = parseRuntimeFile("# comment\nHISTORY_ENABLED=false\nPORT=1\n\nLOG_LEVEL=warn\n", startup);
    expect(settings).toEqual({ logLevel: "warn", historyRules: { maxPoints: 1000, enabled: false } });
    expect(problems).toEqual(["Line 3: PORT is not a runtime key (LOG_LEVEL, HISTORY_MAX_POINTS, HISTORY_ENABLED)"]);
  });

  it("keeps the startup value of an invalid key and lets the environment win", () => {
    const { settings, problems } = parseRuntimeFile("HISTORY_MAX_POINTS=0\nLOG_LEVEL=debug\nno line", startup, ["LOG_LEVEL"]);
    expect(settings).toEqual(startup);
    expect(problems).toHaveLength(3);
    expect(runtimeKeysInEnv({ LOG_LEVEL: "warn", HISTORY_ENABLED: " ", PORT: "1" })).toEqual(["LOG_LEVEL"]);
  });

  it("keeps a pause in force when its line is misspelled (fail closed), and ends it only when the line is deleted", () => {
    const running = { logLevel: "warn", historyRules: { maxPoints: 200, enabled: false } } as const;
    const typos = parseRuntimeFile("HISTORY_ENABLED=flase\nHISTORY_MAX_POINTS=2OO\nLOG_LEVEL=loud", startup, [], running);
    expect(typos.settings).toEqual(running);
    expect(typos.problems).toHaveLength(3);
    expect(parseRuntimeFile("HISTORY_MAX_POINTS=300", startup, [], running).settings).toEqual({ ...startup, historyRules: { ...startup.historyRules, maxPoints: 300 } });
    expect(parseRuntimeFile("", startup, [], running).settings).toEqual(startup);
  });
});
