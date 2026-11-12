import { errors } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKET_CLOSED_TYPE, MARKET_OPENED_TYPE, MARKET_RESOLVED_TYPE, PROJECTION_EVENT_TYPES, TRADE_EXECUTED_TYPE, readProjectionEvent } from "../../src/domain/consumed.js";
import { TENANT_CREATED_TYPE, readTenantCreated } from "../../src/domain/tenant.js";
import { HistoryPaused, TenantNotReady } from "../../src/usecases/errors.js";
import {
  COPY_SOURCES,
  EXTERNAL_COPIES,
  METHODS,
  copyBytes,
  copyHash,
  consumed,
  deref,
  documentedAnswers,
  documentedRoutes,
  examplesOfSchema,
  marketsEvents,
  mergeAllOf,
  openapi,
  readmeHashes,
  readmeText,
  responseErrorsIn,
  schemaErrorsIn,
  sha256,
  sourceOfCopy,
  tenantsEvents,
  tradingEvents,
} from "../support/contracts.js";
import type { Doc } from "../support/contracts.js";
import { MARKET_1, TENANT_A, asPlatformAdmin, call, createHarness } from "../support/fake-use-cases.js";
import type { Answer, Harness } from "../support/fake-use-cases.js";

// The contracts of market-data against the copies of the publishers' files, and the code against both. The copies are
// read from contracts/external: the pipeline of this repository has no sibling folders, so every check but the drift
// check against a sibling runs there, and the drift check shows as skipped without one.

describe("the copies of the publishers' contracts", () => {
  it("are the files the README records: every copy has a hash there and it is the file's SHA-256", () => {
    const recorded = readmeHashes();
    expect(Object.keys(recorded).sort()).toEqual([...EXTERNAL_COPIES].sort());
    for (const name of EXTERNAL_COPIES) expect(copyHash(name), `external/${name}`).toBe(recorded[name]);
  });

  it("notice a change: a copy that differs by one byte, or a README hash that differs by one digit, fails the comparison above", () => {
    const recorded = readmeHashes();
    for (const name of EXTERNAL_COPIES) {
      const edited = Buffer.concat([copyBytes(name), Buffer.from("\n")]);
      expect(sha256(edited), `${name} with one more byte`).not.toBe(recorded[name]);

      const wrong = (recorded[name] ?? "").replace(/^./, (digit) => (digit === "0" ? "1" : "0"));
      const tampered = readmeHashes(readmeText().replace(recorded[name] ?? "", wrong));
      expect(tampered[name], `${name}: the README line is still found`).toBe(wrong);
      expect(copyHash(name), `${name} against a README hash that was changed`).not.toBe(tampered[name]);
    }
  });

  // A drift check against the sibling repository: it needs that repository beside this one, so in a build of this
  // repository alone (the pipeline) it is skipped, and the hash test above is the check there.
  for (const name of EXTERNAL_COPIES) {
    const source = sourceOfCopy(name);
    it.skipIf(source === null)(`${name} equals its source in the sibling repository`, () => {
      expect(sha256(source as Buffer), `${name} drifted from ${COPY_SOURCES[name]}: copy it again and update the README hash`).toBe(copyHash(name));
    });
  }

  it("are AsyncAPI 3.0 files", () => {
    for (const doc of [marketsEvents, tradingEvents, tenantsEvents]) expect(doc["asyncapi"]).toMatch(/^3\.0\./);
  });
});

describe("contracts/openapi.yaml", () => {
  it("is OpenAPI 3.1 with a bearer scheme, unique operation ids and resolvable references", () => {
    expect(openapi["openapi"]).toMatch(/^3\.1\./);
    expect(Object.values(openapi["components"].securitySchemes)[0]).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(openapi["security"]).toHaveLength(1);

    const ids: string[] = [];
    for (const item of Object.values(openapi["paths"] as Record<string, Doc>)) {
      for (const [method, operation] of Object.entries(item)) if (METHODS.includes(method)) ids.push((operation as Doc)["operationId"] ?? "");
    }
    expect(ids.sort()).toEqual(["getMarket", "getMarketHistory", "healthLive", "healthReady", "healthStartup", "listMarkets"]);

    const refs = [...JSON.stringify(openapi).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of refs) {
      const target = ref.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], openapi);
      expect(target, `reference #/${ref}`).toBeDefined();
    }
  });

  it("leaves only the health probes without a security requirement, and gives every other operation 503 with a Retry-After header", () => {
    const shared = openapi["components"].responses.ServiceUnavailable;
    expect(shared.headers["Retry-After"]).toMatchObject({ schema: { type: "integer" } });
    expect(Object.keys(shared.content)).toEqual(["application/problem+json"]);

    const unsecured: string[] = [];
    for (const [path, item] of Object.entries(openapi["paths"] as Record<string, Doc>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue;
        if (Array.isArray(operation["security"]) && operation["security"].length === 0) {
          unsecured.push(path);
          continue;
        }
        expect(operation["responses"]["503"], `${method} ${path}`).toEqual({ $ref: "#/components/responses/ServiceUnavailable" });
      }
    }
    expect(unsecured.sort()).toEqual(["/health/live", "/health/ready", "/health/startup"]);
  });

  it("documents the problem+json answer of every error status, and Cache-Control on every success answer of the API", () => {
    for (const [path, item] of Object.entries(openapi["paths"] as Record<string, Doc>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue;
        const open = Array.isArray(operation["security"]) && operation["security"].length === 0;
        for (const [status, response] of Object.entries(operation["responses"] as Record<string, Doc>)) {
          if (Number(status) >= 400) expect(Object.keys(deref(openapi, response)["content"]), `${method} ${path} ${status}`).toEqual(["application/problem+json"]);
          else if (!open) expect(response["headers"]?.["Cache-Control"], `${method} ${path} ${status}`).toEqual({ $ref: "#/components/headers/CacheControl" });
        }
      }
    }
  });
});

describe("the routes the application registers", () => {
  let routes: Harness;
  beforeAll(async () => {
    routes = await createHarness({ local: true });
  });
  afterAll(async () => {
    await routes.close();
  });

  it("are exactly the paths of contracts/openapi.yaml, the local events route and the GraphQL endpoint (contracts/graphql) aside", () => {
    const registered = routes.app.registeredRoutes
      .filter((route) => !["HEAD", "OPTIONS"].includes(route.method))
      .map((route) => `${route.method} ${route.url.replace(/:(\w+)/g, "{$1}")}`)
      .sort();
    expect(registered.filter((route) => !route.endsWith(" /local/events") && !route.endsWith(" /v1/market-data/graphql"))).toEqual(documentedRoutes(openapi));
    expect(registered.filter((route) => route.endsWith(" /local/events"))).toEqual(["POST /local/events"]);
    // The GraphQL endpoint is one POST route below the gateway prefix; its contract is the schema file, and no GET exists.
    expect(registered.filter((route) => route.endsWith(" /v1/market-data/graphql"))).toEqual(["POST /v1/market-data/graphql"]);
    expect(documentedRoutes(openapi)).toHaveLength(6);
  });

  it("keep the gateway's prefix /v1/market-data on every API path, and the local route out of the contract and out of /v1", () => {
    const paths = Object.keys(openapi["paths"] as Record<string, unknown>);
    expect(paths.filter((path) => !path.startsWith("/health/")).every((path) => path.startsWith("/v1/market-data/"))).toBe(true);
    expect(paths).not.toContain("/local/events");
  });
});

// --- every documented answer, provoked on the application and validated against its schema ---

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

type Scenario = (harness: Harness) => Promise<Answer>;
const UNKNOWN_MARKET = "018f3c1e-7a00-7000-8000-0000000000f1";
const LIST = "/v1/market-data/markets";
const DETAIL = "/v1/market-data/markets/{marketId}";
const HISTORY = "/v1/market-data/markets/{marketId}/history";
const market = (marketId: string, query = "") => `/v1/market-data/markets/${marketId}${query}`;
const history = (marketId: string, query = "") => `/v1/market-data/markets/${marketId}/history${query}`;

/** The signing keys cannot be fetched while `work` runs: every authenticated endpoint answers 503. */
async function keysDown<T>(harness: Harness, work: () => Promise<T>): Promise<T> {
  harness.failKeys(new errors.JWKSTimeout());
  try {
    return await work();
  } finally {
    harness.failKeys(null);
  }
}

/** The use case fails for the length of `work`. */
async function failing<T>(harness: Harness, name: "listMarkets" | "getMarket" | "getHistory", error: Error, work: () => Promise<T>): Promise<T> {
  harness.fake.failWith(name, error);
  try {
    return await work();
  } finally {
    harness.fake.failWith(name, null);
  }
}

const scenarios: Record<string, Scenario> = {
  "GET /v1/market-data/markets 200": (x) => call(x, "GET", LIST),
  "GET /v1/market-data/markets 400": (x) => call(x, "GET", `${LIST}?limit=0`),
  "GET /v1/market-data/markets 401": (x) => call(x, "GET", LIST, { token: null }),
  "GET /v1/market-data/markets 403": (x) => call(x, "GET", LIST, { token: asPlatformAdmin() }),
  "GET /v1/market-data/markets 503": (x) => keysDown(x, () => call(x, "GET", LIST)),
  "GET /v1/market-data/markets/{marketId} 200": (x) => call(x, "GET", market(MARKET_1)),
  "GET /v1/market-data/markets/{marketId} 400": (x) => call(x, "GET", market("not-a-uuid")),
  "GET /v1/market-data/markets/{marketId} 401": (x) => call(x, "GET", market(MARKET_1), { token: null }),
  "GET /v1/market-data/markets/{marketId} 403": (x) => call(x, "GET", market(MARKET_1), { token: asPlatformAdmin() }),
  "GET /v1/market-data/markets/{marketId} 404": (x) => call(x, "GET", market(UNKNOWN_MARKET)),
  "GET /v1/market-data/markets/{marketId} 409": (x) => call(x, "GET", market(MARKET_1, "?afterSequence=99")),
  "GET /v1/market-data/markets/{marketId} 503": (x) => failing(x, "getMarket", new TenantNotReady(), () => call(x, "GET", market(MARKET_1))),
  "GET /v1/market-data/markets/{marketId}/history 200": (x) => call(x, "GET", history(MARKET_1)),
  "GET /v1/market-data/markets/{marketId}/history 400": (x) => call(x, "GET", history(MARKET_1, "?interval=2h")),
  "GET /v1/market-data/markets/{marketId}/history 401": (x) => call(x, "GET", history(MARKET_1), { token: null }),
  "GET /v1/market-data/markets/{marketId}/history 403": (x) => call(x, "GET", history(MARKET_1), { token: asPlatformAdmin() }),
  "GET /v1/market-data/markets/{marketId}/history 404": (x) => call(x, "GET", history(UNKNOWN_MARKET)),
  "GET /v1/market-data/markets/{marketId}/history 409": (x) => call(x, "GET", history(MARKET_1, "?afterSequence=99")),
  "GET /v1/market-data/markets/{marketId}/history 503": (x) => failing(x, "getHistory", new HistoryPaused(), () => call(x, "GET", history(MARKET_1))),
  "GET /health/startup 200": (x) => call(x, "GET", "/health/startup", { token: null }),
  "GET /health/ready 200": (x) => call(x, "GET", "/health/ready", { token: null }),
  "GET /health/ready 503": async (x) => {
    x.setDraining(true);
    try {
      return await call(x, "GET", "/health/ready", { token: null });
    } finally {
      x.setDraining(false);
    }
  },
  "GET /health/live 200": (x) => call(x, "GET", "/health/live", { token: null }),
};

/** The kinds of answer carry the headers the contract documents. */
function expectHeaders(path: string, answer: Answer): void {
  if (!path.startsWith("/v1/")) return;
  expect(answer.headers["cache-control"]).toBe("private, no-store");
  expect(answer.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  if (answer.status === 503) expect(Number(answer.headers["retry-after"])).toBeGreaterThan(0);
  if (answer.status === 401) expect(answer.headers["www-authenticate"]).toContain("Bearer");
}

describe("every status code of contracts/openapi.yaml", () => {
  it("is provoked by exactly one scenario below, and no scenario provokes an undocumented one", () => {
    expect(Object.keys(scenarios).sort()).toEqual(documentedAnswers(openapi));
  });

  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`${name} answers with a body that validates against its schema`, async () => {
      const [method = "", path = "", status = ""] = name.split(" ");
      const answer = await scenario(h);
      expect(answer.status, JSON.stringify(answer.body)).toBe(Number(status));
      expect(responseErrorsIn(openapi, path, method, answer.status, answer.body)).toEqual([]);
      expectHeaders(path, answer);
    });
  }

  it("covers every reason of the 503 the contract lists: identity_provider_unavailable, tenant_not_ready and history_paused", async () => {
    const keys = await keysDown(h, () => call(h, "GET", LIST));
    const tenant = await failing(h, "getMarket", new TenantNotReady(), () => call(h, "GET", market(MARKET_1)));
    const paused = await failing(h, "getHistory", new HistoryPaused(), () => call(h, "GET", history(MARKET_1)));
    expect([keys, tenant, paused].map((answer) => answer.body?.["code"])).toEqual(["identity_provider_unavailable", "tenant_not_ready", "history_paused"]);
    for (const [path, answer] of [
      [LIST, keys],
      [DETAIL, tenant],
      [HISTORY, paused],
    ] as const) {
      expect(responseErrorsIn(openapi, path, "GET", 503, answer.body)).toEqual([]);
    }
  });

  it("makes the validator fail where an answer breaks the contract (the validator is checked)", async () => {
    const ok = await call(h, "GET", market(MARKET_1));
    expect(responseErrorsIn(openapi, DETAIL, "GET", 200, ok.body)).toEqual([]);
    const { question: _removed, ...without } = ok.body as Record<string, unknown>;
    expect(responseErrorsIn(openapi, DETAIL, "GET", 200, without)).not.toEqual([]);
    expect(responseErrorsIn(openapi, DETAIL, "GET", 200, { ...ok.body, status: "paused" })).not.toEqual([]);
    expect(responseErrorsIn(openapi, DETAIL, "GET", 200, { ...ok.body, extra: 1 })).not.toEqual([]);
    expect(responseErrorsIn(openapi, DETAIL, "GET", 200, { ...ok.body, startingPriceYesMicro: "400000" })).not.toEqual([]);
    expect(responseErrorsIn(openapi, DETAIL, "GET", 418, ok.body)).not.toEqual([]);
  });
});

// --- the events ---

const TENANT = TENANT_A;
const SUBJECT = "market/018f3c1e-7a00-7000-8000-0000000000f1";
type Event = Record<string, any>;

/** Values for the attributes whose patterns no generator can satisfy, and a tenant that agrees with `data.tenantId`. */
const overridesFor = (subject: string) => ({ subject, correlationid: "corr-9", tenantid: TENANT, tenantId: TENANT });

const CONSUMED_BY_NAME: Record<string, { type: string; kind: string; publisher: Doc }> = {
  MarketOpenedEvent: { type: MARKET_OPENED_TYPE, kind: "market_opened", publisher: marketsEvents },
  MarketClosedEvent: { type: MARKET_CLOSED_TYPE, kind: "market_closed", publisher: marketsEvents },
  MarketResolvedEvent: { type: MARKET_RESOLVED_TYPE, kind: "market_resolved", publisher: marketsEvents },
  TradeExecutedEvent: { type: TRADE_EXECUTED_TYPE, kind: "trade_executed", publisher: tradingEvents },
};

/** The data schema of an event schema of a file, with the envelope's parts merged in. */
function dataSchemaOf(doc: Doc, name: string): Doc {
  const merged = mergeAllOf(doc, deref(doc, { $ref: `#/components/schemas/${name}` }));
  return deref(doc, merged["properties"]["data"]);
}

/** The attributes of a file's envelope that every event of it must carry. */
const envelopeRequired = (doc: Doc, name: string): string[] => mergeAllOf(doc, deref(doc, { $ref: `#/components/schemas/${name}` }))["required"] as string[];

/** The facts `readProjectionEvent` must take from an example, computed here from the raw data and not by the code under test. */
function expectedFacts(kind: string, data: Event): Record<string, unknown> {
  switch (kind) {
    case "market_opened":
      return {
        marketId: data["marketId"],
        version: data["version"],
        question: String(data["question"]).trim(),
        closeTime: new Date(data["closeTime"]),
        startingPriceYesMicro: Math.round((data["startingPrice"] as number) * 1_000_000),
        openedAt: new Date(data["openedAt"]),
      };
    case "market_closed":
      return { marketId: data["marketId"], version: data["version"], closedAt: new Date(data["closedAt"]) };
    case "market_resolved":
      return { marketId: data["marketId"], version: data["version"], outcome: data["outcome"], resolvedAt: new Date(data["resolvedAt"]) };
    default:
      return { marketId: data["marketId"], tradeSequence: data["tradeSequence"], priceYesMicro: data["yesPriceMicro"], volumeMicro: data["costMicro"], executedAt: new Date(data["executedAt"]) };
  }
}

describe("contracts/asyncapi.yaml", () => {
  it("is AsyncAPI 3.0 and names exactly the types the code consumes: the four projected ones and TenantCreated, three receive operations", () => {
    expect(consumed["asyncapi"]).toMatch(/^3\.0\./);
    const typeOf = (name: string): string => mergeAllOf(consumed, deref(consumed, { $ref: `#/components/schemas/${name}` }))["properties"]["type"]["const"] as string;
    const names = Object.keys(consumed["components"].schemas as Record<string, unknown>).filter((name) => name.endsWith("Event"));
    expect(names.map(typeOf).sort()).toEqual([...PROJECTION_EVENT_TYPES, TENANT_CREATED_TYPE].sort());
    expect(Object.keys(consumed["components"].messages).sort()).toEqual(["MarketClosed", "MarketOpened", "MarketResolved", "TenantCreated", "TradeExecuted"]);
    const actions = Object.values(consumed["operations"] as Record<string, { action: string }>).map((operation) => operation.action);
    expect(actions).toEqual(["receive", "receive", "receive"]);
  });

  it("consumes channels that the publishers' files publish on, one durable consumer per stream's filter", () => {
    const published = (doc: Doc) => Object.values(doc["channels"] as Record<string, { address: string }>).map((channel) => channel.address);
    const all = [...published(marketsEvents), ...published(tradingEvents), ...published(tenantsEvents)];
    const wanted: string[] = [];
    for (const channel of Object.values(consumed["channels"] as Record<string, Doc>)) {
      const events: string[] = channel["parameters"]?.["event"]?.["enum"] ?? [""];
      for (const event of events) wanted.push((channel["address"] as string).replace("{event}", event));
    }
    expect(wanted.sort()).toEqual(["chance.markets.MarketClosed.{tenantId}", "chance.markets.MarketOpened.{tenantId}", "chance.markets.MarketResolved.{tenantId}", "chance.tenants.TenantCreated.{tenantId}", "chance.trading.TradeExecuted.{tenantId}"]);
    for (const address of wanted) expect(all, address).toContain(address);
  });

  it.each(Object.keys(CONSUMED_BY_NAME))("%s: every field it names is a field the publisher requires, with a range no stricter than the publisher's", (name) => {
    const { publisher } = CONSUMED_BY_NAME[name] as (typeof CONSUMED_BY_NAME)[string];
    const ours = dataSchemaOf(consumed, name);
    const theirs = dataSchemaOf(publisher, name);
    for (const field of ours["required"] as string[]) expect(theirs["required"], `data.${field} is required by market-data and not by the publisher`).toContain(field);
    for (const [field, schema] of Object.entries(ours["properties"] as Record<string, Doc>)) {
      const other = deref(publisher, theirs["properties"][field] ?? {});
      const own = deref(consumed, schema);
      expect(other["type"], `data.${field}`).toBe(own["type"]);
      if (own["enum"] !== undefined) expect(other["enum"], `data.${field}`).toEqual(own["enum"]);
      for (const bound of ["minimum", "minLength", "minItems"]) if (own[bound] !== undefined) expect(own[bound], `data.${field}.${bound}`).toBeLessThanOrEqual(other[bound] ?? Number.NEGATIVE_INFINITY);
      for (const bound of ["maximum", "maxLength", "maxItems"]) if (own[bound] !== undefined) expect(own[bound], `data.${field}.${bound}`).toBeGreaterThanOrEqual(other[bound] ?? Number.POSITIVE_INFINITY);
    }
    // The envelope attributes market-data reads are required in every event of the publisher.
    const required = envelopeRequired(publisher, name);
    for (const attribute of (consumed["components"].schemas.Envelope.required as string[]).filter((attribute) => attribute !== "data")) expect(required, attribute).toContain(attribute);
    expect(required).toContain("data");
  });

  it.each(Object.keys(CONSUMED_BY_NAME))("%s: every example built from the publisher's schema validates against it and against market-data's, and readProjectionEvent reads it", (name) => {
    const { type, kind, publisher } = CONSUMED_BY_NAME[name] as (typeof CONSUMED_BY_NAME)[string];
    const examples = examplesOfSchema(publisher, name, { overrides: overridesFor(SUBJECT) }) as Event[];
    expect(examples.length).toBeGreaterThan(0);

    for (const event of examples) {
      expect(schemaErrorsIn(publisher, name, event)).toEqual([]);
      expect(schemaErrorsIn(consumed, name, event)).toEqual([]);
      expect(event["type"]).toBe(type);
      const read = readProjectionEvent(event);
      expect(read, JSON.stringify(event)).toMatchObject({
        kind,
        eventId: event["id"],
        eventType: type,
        tenantId: TENANT,
        correlationId: "corr-9",
        facts: expectedFacts(kind, event["data"]),
      });
    }
  });

  it("reads a MarketOpened that has a field its contract does not know yet: an optional field of a later version is ignored", () => {
    const [event] = examplesOfSchema(marketsEvents, "MarketOpenedEvent", { overrides: overridesFor(SUBJECT) }) as Event[];
    // Invented fields: no contract defines them, the test only plays "a publisher adds an optional field later".
    const later = { ...event, data: { ...event?.["data"], someLaterOptionalField: "a-later-optional-field", anotherLaterField: true } };
    expect(readProjectionEvent(later)).toMatchObject({ kind: "market_opened", facts: expectedFacts("market_opened", event?.["data"]) });
    // ... and the one with only the required fields is read as well.
    const required = (dataSchemaOf(marketsEvents, "MarketOpenedEvent")["required"] as string[]);
    const minimal = { ...event, data: Object.fromEntries(Object.entries(event?.["data"] as Event).filter(([key]) => required.includes(key))) };
    expect(schemaErrorsIn(marketsEvents, "MarketOpenedEvent", minimal)).toEqual([]);
    expect(readProjectionEvent(minimal)).toMatchObject({ kind: "market_opened" });
  });

  it("reads TradeExecuted's tradeSequence and yesPriceMicro at both ends of their ranges, and any price of the range, off the 10 000 grid too", () => {
    const examples = examplesOfSchema(tradingEvents, "TradeExecutedEvent", { overrides: overridesFor(SUBJECT) }) as Event[];
    const sequences = examples.map((event) => (readProjectionEvent(event) as { facts: { tradeSequence: number } }).facts.tradeSequence);
    expect(sequences).toContain(1);
    expect(sequences).toContain(Number.MAX_SAFE_INTEGER);
    const prices = examples.map((event) => (readProjectionEvent(event) as { facts: { priceYesMicro: number } }).facts.priceYesMicro);
    expect(prices).toContain(10_000);
    expect(prices).toContain(990_000);

    const [base] = examples as [Event];
    const offGrid = { ...base, data: { ...base["data"], yesPriceMicro: 555_555 } };
    expect(schemaErrorsIn(tradingEvents, "TradeExecutedEvent", offGrid)).toEqual([]);
    expect(readProjectionEvent(offGrid)).toMatchObject({ kind: "trade_executed", facts: { priceYesMicro: 555_555 } });
  });

  it("reads a sale (TradeExecuted kind sale, UC-08) exactly as the buy of the other side it describes: the same price and volume", () => {
    const [base] = examplesOfSchema(tradingEvents, "TradeExecutedEvent", { overrides: overridesFor(SUBJECT) }) as [Event];
    const data = base["data"] as Event;
    // Selling YES buys NO: trading publishes side NO, the NO shares' cost and the NO level as a YES price.
    const asBuy = { ...base, data: { ...data, side: "NO", costMicro: 6_000_000, lastPriceMicro: 600_000, yesPriceMicro: 400_000, kind: "buy" } };
    const asSale = { ...asBuy, data: { ...(asBuy["data"] as Event), kind: "sale" } };
    expect(schemaErrorsIn(tradingEvents, "TradeExecutedEvent", asSale)).toEqual([]);
    expect(readProjectionEvent(asSale)).toEqual(readProjectionEvent(asBuy));
    // The volume of a sale is the credits paid into the market maker's offers (costMicro), as for a buy.
    expect(readProjectionEvent(asSale)).toMatchObject({ kind: "trade_executed", facts: { priceYesMicro: 400_000, volumeMicro: 6_000_000 } });
    // A value of kind outside the publisher's contract changes nothing for this reader (kind is not read).
    expect(schemaErrorsIn(tradingEvents, "TradeExecutedEvent", { ...asSale, data: { ...(asSale["data"] as Event), kind: "swap" } })).not.toEqual([]);
  });

  it("reads TenantCreated of the tenants' file: every example validates against both files and gives the tenant", () => {
    const examples = examplesOfSchema(tenantsEvents, "TenantCreatedEvent", { overrides: overridesFor(`tenant/${TENANT}`) }) as Event[];
    expect(examples.length).toBeGreaterThan(0);
    for (const event of examples) {
      expect(schemaErrorsIn(tenantsEvents, "TenantCreatedEvent", event)).toEqual([]);
      expect(schemaErrorsIn(consumed, "TenantCreatedEvent", event)).toEqual([]);
      expect(readTenantCreated(event)).toEqual({ kind: "tenant_created", notice: { eventId: event["id"], eventType: TENANT_CREATED_TYPE, tenantId: TENANT, correlationId: "corr-9" } });
    }
  });

  it("stores, not projects, the other events of the publishers' files: the reader says unprojected with the cause other_type", () => {
    const consumedNames = Object.keys(CONSUMED_BY_NAME);
    const others = [marketsEvents, tradingEvents].flatMap((doc) =>
      Object.keys(doc["components"].schemas as Record<string, unknown>)
        .filter((name) => name.endsWith("Event") && !consumedNames.includes(name) && !["ConsumedEvent", "TenantCreatedEvent"].includes(name))
        .map((name) => [name, doc] as const),
    );
    expect(others.length).toBeGreaterThan(0);
    // markets' two share-link event types are the real addition to the stream (their ids are stored forever, DM-14).
    expect(others.map(([name]) => name)).toEqual(expect.arrayContaining(["ShareLinkCreatedEvent", "ShareLinkRevokedEvent"]));
    for (const [name, doc] of others) {
      for (const event of examplesOfSchema(doc, name, { overrides: overridesFor(SUBJECT) }) as Event[]) {
        expect(readProjectionEvent(event), name).toMatchObject({ kind: "unprojected", cause: "other_type", tenantId: TENANT });
      }
    }
  });

  it("is checked against what it must refuse: a missing required value is unreadable (stored, a warning), a missing envelope attribute is unattributable", () => {
    const [opened] = examplesOfSchema(marketsEvents, "MarketOpenedEvent", { overrides: overridesFor(SUBJECT) }) as [Event];
    for (const field of dataSchemaOf(consumed, "MarketOpenedEvent")["required"] as string[]) {
      const data = { ...opened["data"] };
      delete data[field];
      expect(schemaErrorsIn(consumed, "MarketOpenedEvent", { ...opened, data }), field).not.toEqual([]);
      expect(readProjectionEvent({ ...opened, data }), field).toMatchObject({ kind: "unprojected", cause: "unreadable" });
    }
    for (const attribute of ["id", "type", "tenantid", "specversion"]) {
      const { [attribute]: _removed, ...without } = opened;
      expect(schemaErrorsIn(consumed, "MarketOpenedEvent", without), attribute).not.toEqual([]);
      expect(readProjectionEvent(without), attribute).toMatchObject({ kind: "unattributable" });
    }
    const [trade] = examplesOfSchema(tradingEvents, "TradeExecutedEvent", { overrides: overridesFor(SUBJECT) }) as [Event];
    for (const yesPriceMicro of [9_999, 990_001, 12.5]) {
      const bad = { ...trade, data: { ...trade["data"], yesPriceMicro } };
      expect(schemaErrorsIn(consumed, "TradeExecutedEvent", bad), String(yesPriceMicro)).not.toEqual([]);
      expect(readProjectionEvent(bad), String(yesPriceMicro)).toMatchObject({ kind: "unprojected", cause: "unreadable" });
    }
    // A later version of a type is another type: stored, not projected, so that a later reader can replay it.
    expect(readProjectionEvent({ ...trade, type: "si.chance.trading.TradeExecuted.v2" })).toMatchObject({ kind: "unprojected" });
  });
});
