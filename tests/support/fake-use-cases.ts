import type { OutgoingHttpHeaders } from "node:http";
import { Writable } from "node:stream";
import type { JWTVerifyGetKey } from "jose";
import { expect } from "vitest";
import { DEFAULT_INTERVAL, bucketize, historyRange, parseInterval } from "../../src/domain/history.js";
import type { Bucket } from "../../src/domain/history.js";
import { parseMarketId } from "../../src/domain/consumed.js";
import type { TenantCreatedNotice } from "../../src/domain/tenant.js";
import { applyToProjection, emptyProjection, isListed, pointKey } from "../../src/domain/projection.js";
import type { PricePoint, ProjectionState } from "../../src/domain/projection.js";
import type { GraphqlSettings } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { NotFound, TenantNotReady, Updating, ValidationFailed, guardDomain } from "../../src/usecases/errors.js";
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeHistoryCursor,
  decodeMarketCursor,
  encodeHistoryCursor,
  encodeMarketCursor,
  marketViewOf,
  pageSize,
  parseAfterSequence,
  parseIds,
} from "../../src/usecases/support.js";
import type { PageOf } from "../../src/usecases/support.js";
import type {
  ConsumerUseCases,
  GetHistoryUseCase,
  GetMarketInput,
  GetMarketUseCase,
  HistoryInput,
  HistoryView,
  ListMarketsInput,
  ListMarketsUseCase,
  MarketDataUseCases,
  MarketView,
  ProvisionResult,
  ProvisionTenantUseCase,
  RecordProjectionEventInput,
  RecordProjectionEventUseCase,
  RecordResult,
} from "../../src/usecases/use-cases.js";
import { buildApp } from "../../src/web/app.js";
import { publicResponseErrors } from "./contracts.js";
import { CREATOR, MARKET_1, MARKET_2, MARKET_3, T0, TENANT_A, TENANT_B, TRADER, TestClock, at, marketClosedBody, marketOpenedBody, marketResolvedBody, projectionEvent, tradeExecutedBody } from "./fakes.js";
import { AUDIENCE, ISSUER, TENANT_ADMIN_GROUP, TRADER_GROUP, createTestKeys } from "./tokens.js";
import type { TokenOptions } from "./tokens.js";

export { CREATOR, MARKET_1, MARKET_2, MARKET_3, TENANT_A, TENANT_B, TRADER };

type UseCaseName = "listMarkets" | "getMarket" | "getHistory" | "provisionTenant" | "recordProjectionEvent";

/**
 * The use cases of the web layer and of the local events route, answered from the foundation's domain (a projection
 * folded from CloudEvent bodies, `marketViewOf`, `bucketize`, the cursors of support.ts) and nothing else: no store, no
 * use-case class. It records every input it got and throws the error a test configured, so the routes are tested alone
 * (the full stack is the end-to-end test's). Tenants are separate projections; a tenant nobody provisioned is not ready.
 */
export class FakeUseCases implements MarketDataUseCases, ConsumerUseCases {
  readonly calls = {
    listMarkets: [] as ListMarketsInput[],
    getMarket: [] as GetMarketInput[],
    getHistory: [] as HistoryInput[],
    provisionTenant: [] as TenantCreatedNotice[],
    recordProjectionEvent: [] as RecordProjectionEventInput[],
  };
  /** The clock `to` defaults to: one day after T0, so the seeded markets are in the past. */
  readonly clock = new TestClock(at(24 * 60));
  /** HISTORY_MAX_POINTS of the fake's range rule. */
  maxPoints = 1000;

  private readonly tenants = new Map<string, ProjectionState>();
  private readonly failures = new Map<UseCaseName, Error>();
  private readonly seenEvents = new Set<string>();

  readonly listMarkets: ListMarketsUseCase = { execute: (input) => this.run("listMarkets", input, () => this.list(input)) };
  readonly getMarket: GetMarketUseCase = { execute: (input) => this.run("getMarket", input, () => this.market(input)) };
  readonly getHistory: GetHistoryUseCase = { execute: (input) => this.run("getHistory", input, () => this.history(input)) };
  readonly provisionTenant: ProvisionTenantUseCase = { execute: (notice) => this.run("provisionTenant", notice, () => this.provisioned(notice)) };
  readonly recordProjectionEvent: RecordProjectionEventUseCase = { execute: (input) => this.run("recordProjectionEvent", input, () => this.recorded(input)) };

  /** The tenant has a schema: its requests are answered instead of tenant_not_ready. */
  provision(tenantId: string): void {
    if (!this.tenants.has(tenantId)) this.tenants.set(tenantId, emptyProjection());
  }

  /** Feeds CloudEvent bodies (the builders of fakes.ts) into the tenant's projection, as the consumer would. */
  seed(tenantId: string, bodies: Array<Record<string, unknown>>): void {
    this.provision(tenantId);
    const state = this.tenants.get(tenantId) as ProjectionState;
    for (const body of bodies) applyToProjection(state, projectionEvent(body), this.clock.now());
  }

  /** Every call of this use case throws `error` until `clearFailures()` (or `failWith(name, null)`). */
  failWith(name: UseCaseName, error: Error | null): void {
    if (error === null) this.failures.delete(name);
    else this.failures.set(name, error);
  }

  clearFailures(): void {
    this.failures.clear();
  }

  /** Forgets the recorded inputs (not the data). */
  clearCalls(): void {
    for (const list of Object.values(this.calls)) list.length = 0;
  }

  private async run<I, O>(name: UseCaseName, input: I, work: () => O): Promise<O> {
    (this.calls[name] as I[]).push(input);
    const failure = this.failures.get(name);
    if (failure) throw failure;
    return await Promise.resolve(work());
  }

  private stateOf(tenantId: string): ProjectionState {
    const state = this.tenants.get(tenantId);
    if (!state) throw new TenantNotReady();
    return state;
  }

  private list(input: ListMarketsInput): PageOf<MarketView> {
    const state = this.stateOf(input.actor.tenantId);
    const listed = [...state.summaries.values()].filter(isListed);
    if (input.ids !== undefined) {
      if (input.status !== undefined || input.limit !== undefined || input.cursor !== undefined) {
        throw new ValidationFailed([{ field: "ids", message: "ids cannot be combined with status, limit or cursor" }]);
      }
      const byId = new Map(listed.map((summary) => [summary.marketId, summary]));
      const items = parseIds(input.ids).flatMap((id) => {
        const summary = byId.get(id);
        return summary ? [marketViewOf(summary)] : [];
      });
      return { items, nextCursor: null };
    }
    const size = pageSize(input.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const before = decodeMarketCursor(input.cursor);
    const rows = listed
      .filter((summary) => (input.status === undefined || summary.status === input.status) && (before === null || summary.marketId < before))
      .sort((a, b) => (a.marketId < b.marketId ? 1 : -1));
    const page = rows.slice(0, size + 1);
    const last = page[size - 1];
    return { items: page.slice(0, size).map(marketViewOf), nextCursor: page.length > size && last ? encodeMarketCursor(last.marketId) : null };
  }

  private market(input: GetMarketInput): MarketView {
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    const afterSequence = parseAfterSequence(input.afterSequence);
    const state = this.stateOf(input.actor.tenantId);
    const summary = state.summaries.get(marketId);
    if (!summary || !isListed(summary)) throw new NotFound();
    if (afterSequence !== undefined && !state.points.has(pointKey(marketId, afterSequence))) throw new Updating(summary.lastTradeSequence);
    return marketViewOf(summary);
  }

  private history(input: HistoryInput): HistoryView {
    const marketId = guardDomain(() => parseMarketId(input.marketId));
    const interval = guardDomain(() => parseInterval(input.interval ?? DEFAULT_INTERVAL));
    const size = pageSize(input.limit, DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE);
    const afterSequence = parseAfterSequence(input.afterSequence);
    const state = this.stateOf(input.actor.tenantId);
    const summary = state.summaries.get(marketId);
    if (!summary || !isListed(summary) || summary.openedAt === null) throw new NotFound();
    if (afterSequence !== undefined && !state.points.has(pointKey(marketId, afterSequence))) throw new Updating(summary.lastTradeSequence);

    const { range, pageStart } =
      input.cursor !== undefined
        ? decodeHistoryCursor(input.cursor, { interval, from: input.from, to: input.to })
        : (() => {
            const resolved = guardDomain(() => historyRange({ interval, from: input.from, to: input.to, openedAt: summary.openedAt as Date, now: this.clock.now(), maxPoints: this.maxPoints }));
            return { range: resolved, pageStart: resolved.from };
          })();

    const points: PricePoint[] = [...state.points.values()].filter((point) => point.marketId === marketId);
    const buckets: Bucket[] = bucketize(
      points.filter((point) => point.time >= pageStart && point.time < range.to),
      interval,
    ).slice(0, size + 1);
    const next = buckets[size];
    const previous = points
      .filter((point) => point.time < pageStart)
      .sort((a, b) => a.time.getTime() - b.time.getTime() || a.tradeSequence - b.tradeSequence)
      .at(-1);
    return {
      marketId,
      interval,
      from: range.from,
      to: range.to,
      previousCloseYesMicro: previous?.priceYesMicro ?? null,
      buckets: buckets.slice(0, size),
      nextCursor: next ? encodeHistoryCursor(next.start, range) : null,
    };
  }

  private provisioned(notice: TenantCreatedNotice): ProvisionResult {
    if (this.seenEvents.has(notice.eventId)) return "duplicate";
    this.seenEvents.add(notice.eventId);
    this.provision(notice.tenantId);
    return "provisioned";
  }

  private recorded({ event }: RecordProjectionEventInput): RecordResult {
    if (this.seenEvents.has(event.eventId)) return "duplicate";
    this.seenEvents.add(event.eventId);
    this.provision(event.tenantId);
    if (event.kind === "unprojected") return "unprojected";
    const applied = applyToProjection(this.stateOf(event.tenantId), event, this.clock.now());
    return applied.kind === "stale" ? "stale" : "applied";
  }
}

/**
 * Two tenants. TENANT_A: MARKET_1 open with three trades (the third an hour after the second, so the 1h history has two
 * buckets), MARKET_2 closed without trades, MARKET_3 resolved YES with one trade. TENANT_B: only MARKET_3 (its own copy),
 * so MARKET_1 is another tenant's market for a caller of TENANT_B.
 */
export function seedStandardMarkets(fake: FakeUseCases): void {
  fake.seed(TENANT_A, [
    marketOpenedBody({ marketId: MARKET_1, question: "Will the demo work on the first try?", openedAt: at(0), closeTime: at(48 * 60) }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, executedAt: at(1) }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 500_000, executedAt: at(2) }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 3, yesPriceMicro: 550_000, executedAt: at(70) }),
    marketOpenedBody({ marketId: MARKET_2, question: "Will the second market close?", openedAt: at(5), closeTime: at(90) }),
    marketClosedBody({ marketId: MARKET_2, closedAt: at(100) }),
    marketOpenedBody({ marketId: MARKET_3, question: "Will the third market resolve?", openedAt: at(10), closeTime: at(90) }),
    tradeExecutedBody({ marketId: MARKET_3, tradeSequence: 1, yesPriceMicro: 600_000, executedAt: at(20) }),
    marketClosedBody({ marketId: MARKET_3, version: 2, closedAt: at(100) }),
    marketResolvedBody({ marketId: MARKET_3, version: 3, outcome: "YES", resolvedAt: at(110) }),
  ]);
  fake.seed(TENANT_B, [marketOpenedBody({ marketId: MARKET_3, tenantId: TENANT_B, question: "Another tenant's market?", openedAt: at(1), closeTime: at(120) })]);
}

// One RSA key pair per test file: generating it is the slowest step of a harness, and the tests only need tokens that are
// really signed and really verified, not a new key each time.
let sharedKeys: ReturnType<typeof createTestKeys> | undefined;

export interface HarnessOptions {
  /** Provision TENANT_A and TENANT_B (default true). */
  provision?: boolean;
  /** Seed the standard markets (default true). */
  seed?: boolean;
  /** Build the application with the local events route (APP_ENV=local without NATS). */
  local?: boolean;
  /** The GraphQL endpoint settings (default: the production ones, introspection off). */
  graphql?: GraphqlSettings;
}

/** The application over the fake use cases, with real JWT verification against a local key. */
export async function createHarness(options: HarnessOptions = {}) {
  const fake = new FakeUseCases();
  if (options.provision !== false) {
    fake.provision(TENANT_A);
    fake.provision(TENANT_B);
  }
  if (options.seed !== false && options.provision !== false) seedStandardMarkets(fake);
  const keys = await (sharedKeys ??= createTestKeys());
  const logLines: string[] = [];
  // The key resolver can be made to fail like a JWKS download that does not work (see failKeys).
  let keyFailure: unknown = null;
  const getKey: JWTVerifyGetKey = async (header, token) => {
    if (keyFailure !== null) throw keyFailure as Error;
    return await keys.getKey(header, token);
  };
  let draining = false;
  let pingFailure: Error | null = null;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const logger = createLogger("info", sink);
  const app = buildApp({
    logger,
    useCases: fake,
    auth: { issuer: ISSUER, audience: AUDIENCE, getKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" },
    health: {
      ping: () => (pingFailure === null ? Promise.resolve() : Promise.reject(pingFailure)),
      isDraining: () => draining,
    },
    ...(options.graphql === undefined ? {} : { graphql: options.graphql }),
    local: options.local ? fake : null,
  });
  await app.ready();

  const sign = (token?: TokenOptions): Promise<string> => keys.sign(token);
  /** From now on the key resolver rejects with this error; null makes it work again. */
  const failKeys = (error: unknown): void => {
    keyFailure = error;
  };
  /** From now on the database ping rejects with this error; null makes it work again. */
  const failPing = (error: Error | null): void => {
    pingFailure = error;
  };
  /** Pretends the process got SIGTERM and is in the drain delay (or is running again). */
  const setDraining = (value: boolean): void => {
    draining = value;
  };
  const close = async (): Promise<void> => {
    await app.close();
  };

  return { app, fake, keys, logLines, sign, failKeys, failPing, setDraining, close };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * Claims of the three kinds of user in token contract v2: the tenant (the organization alias) and the role (the
 * organization's group) are in `organization`; the platform admin's role is a realm role.
 */
export const asTenantAdmin = (sub = CREATOR, tenant: string = TENANT_A): TokenOptions => ({ sub, memberships: { [tenant]: [TENANT_ADMIN_GROUP] } });
export const asTrader = (sub = TRADER, tenant: string = TENANT_A): TokenOptions => ({ sub, memberships: { [tenant]: [TRADER_GROUP] } });
export const asPlatformAdmin = (sub = "platform-1"): TokenOptions => ({ sub, roles: ["platform-admin"] });

export interface CallOptions {
  /** Claims of the bearer token; null sends no Authorization header. Default: a trader of TENANT_A. */
  token?: TokenOptions | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Answer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Record<string, any> | null;
}

/** One request through the application, as a client would send it. */
export async function call(h: Harness, method: "GET" | "POST", url: string, options: CallOptions = {}): Promise<Answer> {
  const auth = options.token === null ? {} : { authorization: `Bearer ${await h.sign(options.token ?? asTrader())}` };
  const response = await h.app.inject({
    method,
    url,
    headers: { ...auth, ...options.headers },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  return { status: response.statusCode, headers: response.headers, body: response.body ? (JSON.parse(response.body) as Record<string, any>) : null };
}

/** Asserts that a real answer has the shape written in contracts/openapi.yaml (`path` as written there). */
export function expectContract(path: string, method: string, answer: Answer): void {
  expect(publicResponseErrors(path, method, answer.status, answer.body), `${method} ${path} -> ${answer.status}`).toEqual([]);
}

export { T0 };
