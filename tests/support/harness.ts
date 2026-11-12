import type { OutgoingHttpHeaders } from "node:http";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { JWTVerifyGetKey } from "jose";
import { expect } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { readProjectionEvent } from "../../src/domain/consumed.js";
import { readTenantCreated } from "../../src/domain/tenant.js";
import type { GraphqlSettings } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { GetHistory } from "../../src/usecases/get-history.js";
import { GetMarket } from "../../src/usecases/get-market.js";
import { ListMarkets } from "../../src/usecases/list-markets.js";
import { ProvisionTenant } from "../../src/usecases/provision-tenant.js";
import { RecordProjectionEvent } from "../../src/usecases/record-projection-event.js";
import { ReplayProjections } from "../../src/usecases/replay-projections.js";
import type { ConsumerUseCases, MarketDataUseCases, RecordResult, ReplayProjectionsUseCase } from "../../src/usecases/use-cases.js";
import { buildApp } from "../../src/web/app.js";
import { publicResponseErrors } from "./contracts.js";
import { RecordingLogger, T0, TENANT_A, TENANT_B, TestClock, TestRules, tenantCreatedBody } from "./fakes.js";
import { AUDIENCE, ISSUER, TENANT_ADMIN_GROUP, TRADER_GROUP, createTestKeys } from "./tokens.js";
import type { TokenOptions } from "./tokens.js";

// The full stack of market-data over one MemoryStore: the real use cases (also the replay) behind the real web
// application, with really signed and really verified tokens. tests/support/fake-use-cases.ts is the other harness, for
// the routes alone.

type Body = Record<string, unknown>;

export interface CoreOptions {
  /** A tenant is registered on its first event or request (APP_ENV=local); default false, as production. */
  autoProvision?: boolean;
}

export type CoreUseCases = MarketDataUseCases & ConsumerUseCases & { replayProjections: ReplayProjectionsUseCase };

/** The store, the clock, the rules and every use case, without the web layer. */
export function createCore(options: CoreOptions = {}) {
  const store = new MemoryStore({ autoProvision: options.autoProvision ?? false });
  const clock = new TestClock();
  const logger = new RecordingLogger();
  const rules = new TestRules();
  const deps = { store, clock, logger };
  const useCases: CoreUseCases = {
    listMarkets: new ListMarkets(deps),
    getMarket: new GetMarket(deps),
    getHistory: new GetHistory({ ...deps, rules }),
    provisionTenant: new ProvisionTenant(deps),
    recordProjectionEvent: new RecordProjectionEvent(deps),
    replayProjections: new ReplayProjections(deps),
  };
  return { store, clock, logger, rules, useCases };
}

export type Core = ReturnType<typeof createCore>;

/** TenantCreated through the real use case, for each tenant (default: TENANT_A and TENANT_B). */
export async function provisionTenants(core: Core, tenantIds: readonly string[] = [TENANT_A, TENANT_B]): Promise<void> {
  for (const tenantId of tenantIds) {
    const read = readTenantCreated(tenantCreatedBody(tenantId));
    if (read.kind !== "tenant_created") throw new Error("The test TenantCreated was not read");
    await core.useCases.provisionTenant.execute(read.notice);
  }
}

/** What a consumer does with one message: read it with the production reader, then record it (stored as it arrived). */
export async function record(core: Core, body: Body): Promise<RecordResult> {
  const event = readProjectionEvent(body);
  if (event.kind === "unattributable") throw new Error(`The test event is unattributable: ${event.reason}`);
  return core.useCases.recordProjectionEvent.execute({ event, raw: body });
}

// One RSA key pair per test file: generating it is the slowest step, and the tests only need tokens that are really
// signed and really verified.
let sharedKeys: ReturnType<typeof createTestKeys> | undefined;

export interface HarnessOptions extends CoreOptions {
  /** Provision TENANT_A and TENANT_B (default true). */
  provision?: boolean;
  /** The GraphQL endpoint settings (default: the production ones, introspection off). */
  graphql?: GraphqlSettings;
  /** The request metrics and the GraphQL error counter, as src/main.ts wires them. */
  metrics?: { attach(app: FastifyInstance): void };
  onGraphqlErrors?: (codes: ReadonlyArray<string | undefined>) => void;
}

/** The application over the real use cases on a MemoryStore, with real JWT verification against a local key. */
export async function createHarness(options: HarnessOptions = {}) {
  const core = createCore(options);
  if (options.provision !== false) await provisionTenants(core);
  const keys = await (sharedKeys ??= createTestKeys());
  const logLines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const getKey: JWTVerifyGetKey = (header, token) => keys.getKey(header, token);
  const app = buildApp({
    logger: createLogger("info", sink),
    useCases: core.useCases,
    auth: { issuer: ISSUER, audience: AUDIENCE, getKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" },
    health: { ping: () => core.store.ping(), isDraining: () => false },
    ...(options.graphql === undefined ? {} : { graphql: options.graphql }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    ...(options.onGraphqlErrors === undefined ? {} : { onGraphqlErrors: options.onGraphqlErrors }),
    local: null,
  });
  await app.ready();
  const sign = (token?: TokenOptions): Promise<string> => keys.sign(token);
  return { app, core, sign, logLines, close: () => app.close() };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/** Claims of the two kinds of reader in token contract v2: the tenant and the role are in `organization`. */
export const asTenantAdmin = (sub = "admin-1", tenant: string = TENANT_A): TokenOptions => ({ sub, memberships: { [tenant]: [TENANT_ADMIN_GROUP] } });
export const asTrader = (sub = "trader-1", tenant: string = TENANT_A): TokenOptions => ({ sub, memberships: { [tenant]: [TRADER_GROUP] } });

export interface Answer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Record<string, any> | null;
}

/** One GET through the application, as a client would send it (a trader of TENANT_A unless `token` says otherwise). */
export async function get(h: Harness, url: string, token: TokenOptions | null = asTrader()): Promise<Answer> {
  const auth = token === null ? {} : { authorization: `Bearer ${await h.sign(token)}` };
  const response = await h.app.inject({ method: "GET", url, headers: auth });
  return { status: response.statusCode, headers: response.headers, body: response.body ? (JSON.parse(response.body) as Record<string, any>) : null };
}

/** Asserts that a real answer has the shape written in contracts/openapi.yaml (`path` as written there). */
export function expectContract(path: string, answer: Answer): void {
  expect(publicResponseErrors(path, "GET", answer.status, answer.body), `GET ${path} -> ${answer.status}`).toEqual([]);
}

export { T0 };
