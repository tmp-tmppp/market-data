import { errors as joseErrors } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HistoryPaused, NotFound, TenantNotReady, Unavailable, Updating, ValidationFailed } from "../../src/usecases/errors.js";
import { MAX_REPEATED_FIELDS } from "../../src/web/graphql/limits.js";
import { T0, at } from "../support/fakes.js";
import { MARKET_1, MARKET_2, MARKET_3, TENANT_A, TENANT_B, asPlatformAdmin, asTenantAdmin, asTrader, createHarness } from "../support/fake-use-cases.js";
import type { Harness } from "../support/fake-use-cases.js";
import { GRAPHQL, codesOf, gql, send } from "../support/graphql.js";
import { TENANT_ADMIN_GROUP, TRADER_GROUP } from "../support/tokens.js";
import type { TokenOptions } from "../support/tokens.js";

// The GraphQL endpoint over the routes' own harness: the real application and real tokens, with fake use cases that
// record their inputs, so these tests show what the endpoint asks of the use cases and what it makes of their answers.
// tests/web/graphql-end-to-end.test.ts runs the same queries over the real use cases and compares them with the REST API.

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.clearFailures();
  h.fake.clearCalls();
});

const NOBODY_HOME = "018f3c1e-7a00-7000-8000-0000000000f1";
const MARKET_FIELDS = "marketId question status closeTime openedAt closedAt resolvedAt outcome startingPriceYesMicro lastPriceYesMicro currentPriceYesMicro volumeMicro tradeCount lastTradeSequence lastTradeAt version updatedAt";

describe("the answers", () => {
  it("lists the tenant's markets, newest first, with enums, ISO dates and the integers of the REST API", async () => {
    const answer = await gql(h, `{ markets { items { ${MARKET_FIELDS} } pageInfo { hasNextPage endCursor } } }`);
    expect(answer.status).toBe(200);
    expect(answer.body?.errors).toBeUndefined();
    const page = answer.body?.data?.["markets"];
    expect(page.items.map((item: { marketId: string }) => item.marketId)).toEqual([MARKET_3, MARKET_2, MARKET_1]);
    expect(page.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
    expect(page.items[2]).toEqual({
      marketId: MARKET_1,
      question: "Will the demo work on the first try?",
      status: "OPEN",
      closeTime: at(48 * 60).toISOString(),
      openedAt: T0.toISOString(),
      closedAt: null,
      resolvedAt: null,
      outcome: null,
      startingPriceYesMicro: 400_000,
      lastPriceYesMicro: 550_000,
      currentPriceYesMicro: 550_000,
      volumeMicro: 30_000_000,
      tradeCount: 3,
      lastTradeSequence: 3,
      lastTradeAt: at(70).toISOString(),
      version: 1,
      updatedAt: expect.any(String) as string,
    });
    expect(page.items[1]).toMatchObject({ status: "CLOSED", lastPriceYesMicro: null, currentPriceYesMicro: 400_000, tradeCount: 0, lastTradeAt: null });
    expect(page.items[0]).toMatchObject({ status: "RESOLVED", outcome: "YES", currentPriceYesMicro: 1_000_000 });
  });

  it("carries Cache-Control private no-store, a correlation id and the JSON type, on every kind of answer", async () => {
    const ok = await gql(h, "{ markets { items { marketId } } }", { headers: { "x-correlation-id": "gql-test-1" } });
    expect(ok.headers["cache-control"]).toBe("private, no-store");
    expect(ok.headers["x-correlation-id"]).toBe("gql-test-1");
    expect(ok.headers["content-type"]).toContain("application/json");
    const partial = await gql(h, `{ market(id: "${NOBODY_HOME}") { marketId } }`);
    const refused = await gql(h, "{ markets { items { marketId } } }", { token: null });
    const invalid = await gql(h, "{ nothing }");
    const syntax = await gql(h, "{ markets");
    for (const answer of [partial, refused, invalid, syntax]) {
      expect(answer.headers["cache-control"], `${answer.status}`).toBe("private, no-store");
      expect(answer.headers["x-correlation-id"]).toEqual(expect.any(String));
    }
  });

  it("answers one market by id (any letter case) and passes afterSequence on", async () => {
    const answer = await gql(h, `query One($id: ID!, $after: Long) { market(id: $id, afterSequence: $after) { marketId status version } }`, {
      variables: { id: MARKET_1.toUpperCase(), after: 2 },
      operationName: "One",
    });
    expect(answer.body?.data?.["market"]).toEqual({ marketId: MARKET_1, status: "OPEN", version: 1 });
    expect(h.fake.calls.getMarket).toHaveLength(1);
    expect(h.fake.calls.getMarket[0]).toMatchObject({ marketId: MARKET_1, afterSequence: 2 });
  });

  it("passes the page arguments on as the REST parameters (first is limit, after is cursor), and pages to the end", async () => {
    const first = await gql(h, "{ markets(status: null, first: 2) { items { marketId } pageInfo { hasNextPage endCursor } } }");
    expect(first.body?.data?.["markets"].items.map((item: { marketId: string }) => item.marketId)).toEqual([MARKET_3, MARKET_2]);
    const { hasNextPage, endCursor } = (first.body?.data?.["markets"] as { pageInfo: { hasNextPage: boolean; endCursor: string | null } }).pageInfo;
    expect(hasNextPage).toBe(true);
    expect(endCursor).toEqual(expect.any(String));
    expect(h.fake.calls.listMarkets[0]).toMatchObject({ limit: 2 });
    expect(h.fake.calls.listMarkets[0]).not.toHaveProperty("status");

    const second = await gql(h, "query($c: String) { markets(first: 2, after: $c) { items { marketId } pageInfo { hasNextPage endCursor } } }", { variables: { c: endCursor } });
    expect(second.body?.data?.["markets"]).toEqual({ items: [{ marketId: MARKET_1 }], pageInfo: { hasNextPage: false, endCursor: null } });
    expect(h.fake.calls.listMarkets[1]).toMatchObject({ limit: 2, cursor: endCursor });

    const open = await gql(h, "{ markets(status: OPEN) { items { marketId status } } }");
    expect(open.body?.data?.["markets"].items).toEqual([{ marketId: MARKET_1, status: "OPEN" }]);
    expect(h.fake.calls.listMarkets[2]).toMatchObject({ status: "open" });
  });

  it("answers a batch of ids in the order given, leaving out unknown ones, and refuses ids with another argument", async () => {
    const batch = await gql(h, "query($ids: [ID!]) { markets(ids: $ids) { items { marketId } pageInfo { hasNextPage } } }", { variables: { ids: [MARKET_1, NOBODY_HOME, MARKET_3, MARKET_2] } });
    expect(batch.body?.data?.["markets"]).toEqual({ items: [{ marketId: MARKET_1 }, { marketId: MARKET_3 }, { marketId: MARKET_2 }], pageInfo: { hasNextPage: false } });
    expect(h.fake.calls.listMarkets[0]).toMatchObject({ ids: [MARKET_1, NOBODY_HOME, MARKET_3, MARKET_2] });

    const combined = await gql(h, `{ markets(ids: ["${MARKET_1}"], first: 5) { items { marketId } } }`);
    expect(combined.status).toBe(200);
    expect(combined.body?.data).toEqual({ markets: null });
    expect(combined.body?.errors?.[0]).toMatchObject({ path: ["markets"], extensions: { code: "validation_failed", status: 400, fields: [{ field: "ids" }] } });
  });

  it("answers the history with the REST fields, the interval as an enum and a page of buckets", async () => {
    const answer = await gql(
      h,
      `query($m: ID!) { history(marketId: $m, interval: ONE_HOUR) { marketId interval from to previousCloseYesMicro buckets { start openYesMicro highYesMicro lowYesMicro closeYesMicro volumeMicro trades } pageInfo { hasNextPage endCursor } } }`,
      { variables: { m: MARKET_1 } },
    );
    expect(answer.status).toBe(200);
    expect(answer.body?.errors).toBeUndefined();
    const history = answer.body?.data?.["history"];
    expect(history).toMatchObject({ marketId: MARKET_1, interval: "ONE_HOUR", previousCloseYesMicro: null, pageInfo: { hasNextPage: false, endCursor: null } });
    expect(history.buckets).toEqual([
      { start: at(0).toISOString(), openYesMicro: 400_000, highYesMicro: 500_000, lowYesMicro: 400_000, closeYesMicro: 500_000, volumeMicro: expect.any(Number) as number, trades: 2 },
      { start: at(60).toISOString(), openYesMicro: 550_000, highYesMicro: 550_000, lowYesMicro: 550_000, closeYesMicro: 550_000, volumeMicro: expect.any(Number) as number, trades: 1 },
    ]);
    expect(h.fake.calls.getHistory[0]).toMatchObject({ marketId: MARKET_1, interval: "1h" });
  });

  it("passes every history argument on: the interval's REST key, the range as dates, the page and afterSequence", async () => {
    const from = at(0).toISOString();
    const to = at(120).toISOString();
    const first = await gql(h, `query($m: ID!, $from: DateTime, $to: DateTime) { history(marketId: $m, interval: ONE_MINUTE, from: $from, to: $to, first: 1, afterSequence: 3) { buckets { start } pageInfo { hasNextPage endCursor } } }`, {
      variables: { m: MARKET_1, from, to },
    });
    expect(first.body?.errors).toBeUndefined();
    expect(h.fake.calls.getHistory[0]).toMatchObject({ marketId: MARKET_1, interval: "1m", from: new Date(from), to: new Date(to), limit: 1, afterSequence: 3 });
    const { hasNextPage, endCursor } = (first.body?.data?.["history"] as { pageInfo: { hasNextPage: boolean; endCursor: string | null } }).pageInfo;
    expect(hasNextPage).toBe(true);
    const second = await gql(h, `query($m: ID!, $from: DateTime, $to: DateTime, $c: String) { history(marketId: $m, interval: ONE_MINUTE, from: $from, to: $to, first: 5, after: $c) { buckets { start } pageInfo { hasNextPage } } }`, {
      variables: { m: MARKET_1, from, to, c: endCursor },
    });
    expect(second.body?.errors).toBeUndefined();
    // Four buckets in all (the opening point and three trades in their own minutes), one of them on page 1.
    expect(second.body?.data?.["history"].buckets).toHaveLength(3);
    expect(h.fake.calls.getHistory[1]).toMatchObject({ cursor: endCursor, limit: 5 });
  });

  it("accepts a date with an offset and reads the same instant", async () => {
    const answer = await gql(h, `{ history(marketId: "${MARKET_1}", interval: ONE_HOUR, from: "${new Date(T0.getTime()).toISOString().replace("Z", "+00:00")}") { from } }`);
    expect(answer.body?.errors).toBeUndefined();
    expect(answer.body?.data?.["history"].from).toBe(at(0).toISOString());
  });
});

describe("the tenant comes from the token only", () => {
  it("gives each caller the markets of its own tenant, and another tenant's market is not_found", async () => {
    const mine = await gql(h, "{ markets { items { marketId question } } }", { token: asTrader("trader-b", TENANT_B) });
    expect(mine.body?.data?.["markets"].items).toEqual([{ marketId: MARKET_3, question: "Another tenant's market?" }]);
    expect(h.fake.calls.listMarkets[0]?.actor).toMatchObject({ tenantId: TENANT_B, role: "trader" });

    const other = await gql(h, `{ market(id: "${MARKET_1}") { marketId } }`, { token: asTrader("trader-b", TENANT_B) });
    expect(other.body?.data).toEqual({ market: null });
    expect(codesOf(other)).toEqual(["not_found"]);
    expect(h.fake.calls.getMarket[0]?.actor.tenantId).toBe(TENANT_B);
  });

  it("offers no argument or field that names a tenant: one that is sent is a query error and nothing runs", async () => {
    const argument = await gql(h, `{ markets(tenantId: "${TENANT_B}") { items { marketId } } }`);
    expect(argument.status).toBe(400);
    expect(codesOf(argument)).toEqual(["graphql_validation_failed"]);
    const field = await gql(h, "{ markets { items { tenantId } } }");
    expect(field.status).toBe(400);
    expect(h.fake.calls.listMarkets).toHaveLength(0);
  });

  it("reads the actor from the verified token: user, tenant and role of a trader and of a tenant admin", async () => {
    await gql(h, "{ markets { items { marketId } } }", { token: asTenantAdmin("admin-9") });
    expect(h.fake.calls.listMarkets[0]?.actor).toMatchObject({ userId: "admin-9", tenantId: TENANT_A, role: "tenant-admin" });
    await gql(h, "{ markets { items { marketId } } }", { token: asTrader("trader-9") });
    expect(h.fake.calls.listMarkets[1]?.actor).toMatchObject({ userId: "trader-9", tenantId: TENANT_A, role: "trader" });
  });
});

describe("authentication and roles are those of the REST routes", () => {
  const QUERIES = {
    markets: "{ markets { items { marketId } } }",
    market: `{ market(id: "${MARKET_1}") { marketId } }`,
    history: `{ history(marketId: "${MARKET_1}") { marketId } }`,
  };
  const calledAny = () => Object.values(h.fake.calls).some((list) => list.length > 0);

  it.each<[string, TokenOptions | null]>([
    ["no Authorization header", null],
    ["a token without exp", { ...asTrader(), noExpiry: true }],
    ["an expired token", { ...asTrader(), expiresIn: -60 }],
    ["a token of another issuer", { ...asTrader(), issuer: "http://evil.example/realms/test" }],
    ["a token for another audience", { ...asTrader(), audience: "someone-else" }],
    ["a token of two organizations", { memberships: { [TENANT_A]: [TRADER_GROUP], [TENANT_B]: [TRADER_GROUP] } }],
  ])("is 401 for %s, for every query, and nothing runs", async (_name, token) => {
    for (const [name, query] of Object.entries(QUERIES)) {
      const answer = await gql(h, query, { token });
      expect(answer.status, name).toBe(401);
      expect(answer.body?.data).toBeUndefined();
      expect(answer.body?.errors?.[0], name).toMatchObject({ extensions: { code: "unauthorized", status: 401 } });
      expect(answer.headers["www-authenticate"], name).toContain("Bearer");
    }
    expect(calledAny()).toBe(false);
  });

  it("is 401 for a token signed with a key the service does not trust", async () => {
    const forged = await h.keys.signWithOtherKey(asTrader());
    const answer = await send(h, "POST", GRAPHQL, { query: QUERIES.markets }, { headers: { authorization: `Bearer ${forged}` }, token: null });
    expect(answer.status).toBe(401);
    expect(codesOf(answer)).toEqual(["unauthorized"]);
  });

  it("is 401 for an Authorization header that is not a bearer token", async () => {
    const answer = await send(h, "POST", GRAPHQL, { query: QUERIES.markets }, { headers: { authorization: "Basic dXNlcjpwYXNz" }, token: null });
    expect(answer.status).toBe(401);
  });

  it.each<[string, TokenOptions | null]>([
    ["a platform admin", asPlatformAdmin()],
    ["a platform admin that also names a tenant", { sub: "p", roles: ["platform-admin"], memberships: { [TENANT_A]: [TRADER_GROUP] } }],
    ["a token without an organization", { sub: "nobody" }],
    ["the old realm role trader", { sub: "old", roles: ["trader"], memberships: { [TENANT_A]: [] } }],
    ["both groups at once", { sub: "both", memberships: { [TENANT_A]: [TRADER_GROUP, TENANT_ADMIN_GROUP] } }],
    ["an unknown group", { sub: "odd", memberships: { [TENANT_A]: ["/auditor"] } }],
    ["an organization that is not a UUID", { sub: "alias", memberships: { acme: [TRADER_GROUP] } }],
    ["a v1 organization claim (an array)", { sub: "v1", organization: [TENANT_A] }],
  ])("is 403 for %s on every query, before the body is read or anything runs", async (_name, token) => {
    for (const [name, query] of Object.entries(QUERIES)) {
      const answer = await gql(h, query, { token });
      expect(answer.status, name).toBe(403);
      expect(answer.body?.data).toBeUndefined();
      expect(answer.body?.errors?.[0], name).toMatchObject({ extensions: { code: "forbidden", status: 403 } });
    }
    // The role is checked before the body: a body that is not even JSON gets 403, not 400, from a caller without rights.
    const garbage = await send(h, "POST", GRAPHQL, "{not json", { token, headers: { "content-type": "application/json" } });
    expect(garbage.status).toBe(403);
    expect(calledAny()).toBe(false);
  });

  it("is 503 with Retry-After when the signing keys cannot be fetched, and 401 again once they can", async () => {
    h.failKeys(new joseErrors.JWKSTimeout());
    try {
      const down = await gql(h, QUERIES.markets);
      expect(down.status).toBe(503);
      expect(down.headers["retry-after"]).toBe("5");
      expect(down.body?.errors?.[0]).toMatchObject({ extensions: { code: "identity_provider_unavailable", status: 503, retryAfterSeconds: 5 } });
    } finally {
      h.failKeys(null);
    }
    expect((await gql(h, QUERIES.markets)).status).toBe(200);
  });
});

describe("the errors of the use cases, with the codes of the REST problems", () => {
  it("makes a failed field null with the REST code and status, and keeps the answer 200", async () => {
    h.fake.failWith("getMarket", new NotFound());
    const notFound = await gql(h, `{ market(id: "${MARKET_1}") { marketId } }`);
    expect(notFound.status).toBe(200);
    expect(notFound.body?.data).toEqual({ market: null });
    expect(notFound.body?.errors).toEqual([{ message: "No such market", locations: [{ line: 1, column: 3 }], path: ["market"], extensions: { code: "not_found", status: 404 } }]);

    h.fake.failWith("getMarket", new Updating(41));
    const updating = await gql(h, `{ market(id: "${MARKET_1}", afterSequence: 42) { marketId } }`);
    expect(updating.body?.errors?.[0]).toMatchObject({ path: ["market"], extensions: { code: "updating", status: 409, lastTradeSequence: 41 } });
  });

  it.each([
    ["history", "history_paused", 503, 30, new HistoryPaused()],
    ["history", "tenant_not_ready", 503, 5, new TenantNotReady()],
    ["history", "identity_like_unavailable", 503, 7, new Unavailable("identity_like_unavailable", "later", 7)],
  ] as const)("tells %s %s as status %i with retryAfterSeconds %i", async (name, code, status, retryAfter, failure) => {
    h.fake.failWith("getHistory", failure);
    const answer = await gql(h, `{ ${name}(marketId: "${MARKET_1}") { marketId } }`);
    expect(answer.status).toBe(200);
    expect(answer.body?.data).toEqual({ [name]: null });
    expect(answer.body?.errors?.[0]).toMatchObject({ extensions: { code, status, retryAfterSeconds: retryAfter } });
  });

  it("tells the use case's field errors under the names of the arguments the caller sent", async () => {
    const page = await gql(h, "{ markets(first: 500) { items { marketId } } }");
    expect(page.body?.errors?.[0]).toMatchObject({
      path: ["markets"],
      extensions: { code: "validation_failed", status: 400, fields: [{ field: "first", message: "first must be an integer from 1 to 100" }] },
    });
    const cursor = await gql(h, `{ markets(after: "not a cursor") { items { marketId } } }`);
    expect(cursor.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", fields: [{ field: "after", message: "The cursor is not valid" }] } });
    const id = await gql(h, `{ market(id: "not-a-uuid") { marketId } }`);
    expect(id.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", fields: [{ field: "id", message: "id must be a UUID" }] } });
    const marketId = await gql(h, `{ history(marketId: "not-a-uuid") { marketId } }`);
    expect(marketId.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", fields: [{ field: "marketId", message: "marketId must be a UUID" }] } });
    const sequence = await gql(h, `{ market(id: "${MARKET_1}", afterSequence: 0) { marketId } }`);
    expect(sequence.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", fields: [{ field: "afterSequence" }] } });
  });

  it("refuses a range of too many buckets with validation_failed and maxPoints, as the REST problem does", async () => {
    h.fake.maxPoints = 10;
    try {
      const answer = await gql(h, `{ history(marketId: "${MARKET_1}", interval: ONE_MINUTE, from: "${at(0).toISOString()}", to: "${at(600).toISOString()}") { marketId } }`);
      expect(answer.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", status: 400, maxPoints: 10, fields: [{ field: "from" }] } });
    } finally {
      h.fake.maxPoints = 1000;
    }
  });

  it("treats a date that is no instant like the REST routes: validation_failed on that argument, a leap second included", async () => {
    const text = await gql(h, `{ history(marketId: "${MARKET_1}", from: "yesterday") { marketId } }`);
    expect(text.status).toBe(400);
    expect(codesOf(text)).toEqual(["validation_failed"]);
    const variable = await gql(h, "query($f: DateTime) { history(marketId: \"" + MARKET_1 + "\", from: $f) { marketId } }", { variables: { f: 12 } });
    expect(variable.status).toBe(400);
    expect(codesOf(variable)).toEqual(["validation_failed"]);
    const leap = await gql(h, `{ history(marketId: "${MARKET_1}", from: "2026-12-31T23:59:60Z") { marketId } }`);
    expect(leap.status).toBe(200);
    expect(leap.body?.errors?.[0]).toMatchObject({ path: ["history"], extensions: { code: "validation_failed", fields: [{ field: "from" }] } });
  });

  it("refuses a Long that is not a safe integer", async () => {
    const answer = await gql(h, `{ market(id: "${MARKET_1}", afterSequence: 9007199254740993) { marketId } }`);
    expect(answer.status).toBe(400);
    expect(codesOf(answer)).toEqual(["validation_failed"]);
    const variable = await gql(h, "query($a: Long) { market(id: \"" + MARKET_1 + "\", afterSequence: $a) { marketId } }", { variables: { a: 1.5 } });
    expect(variable.status).toBe(400);
  });

  it("still answers the other fields of a query when one fails", async () => {
    const answer = await gql(h, `{ found: market(id: "${MARKET_1}") { marketId } missing: market(id: "${NOBODY_HOME}") { marketId } markets { items { marketId } } }`);
    expect(answer.status).toBe(200);
    expect(answer.body?.data).toMatchObject({ found: { marketId: MARKET_1 }, missing: null, markets: { items: expect.any(Array) as unknown[] } });
    expect(answer.body?.errors).toHaveLength(1);
    expect(answer.body?.errors?.[0]).toMatchObject({ path: ["missing"], extensions: { code: "not_found" } });
  });

  it("hides an error nobody expected behind a fixed text and logs it", async () => {
    h.fake.failWith("listMarkets", new Error("connection to 10.1.2.3:5432 refused, password=hunter2"));
    const answer = await gql(h, "{ markets { items { marketId } } }");
    expect(answer.status).toBe(200);
    expect(answer.body?.data).toEqual({ markets: null });
    expect(answer.body?.errors).toEqual([expect.objectContaining({ message: "The service failed to handle the request", path: ["markets"], extensions: { code: "internal_error", status: 500 } })]);
    expect(answer.text).not.toContain("hunter2");
    expect(answer.text).not.toContain("10.1.2.3");
    expect(h.logLines.some((line) => line.includes("A GraphQL resolver failed") && line.includes("hunter2"))).toBe(true);
  });

  it("maps the same use case error to the same code as the REST route does", async () => {
    const failures: Array<[string, Error]> = [
      ["not_found", new NotFound()],
      ["updating", new Updating(3)],
      ["history_paused", new HistoryPaused()],
      ["tenant_not_ready", new TenantNotReady()],
      ["validation_failed", new ValidationFailed([{ field: "marketId", message: "bad" }])],
    ];
    for (const [code, failure] of failures) {
      h.fake.failWith("getMarket", failure);
      const rest = await send(h, "GET", `/v1/market-data/markets/${MARKET_1}`, undefined);
      const graphql = await gql(h, `{ market(id: "${MARKET_1}") { marketId } }`);
      expect(rest.body).toMatchObject({ code });
      expect(codesOf(graphql), code).toEqual([code]);
      expect(graphql.body?.errors?.[0]?.["extensions"]["status"], code).toBe(rest.status);
    }
  });
});

describe("the query is checked before it runs", () => {
  it("answers a syntax error with 400 and no data, and names the line", async () => {
    const answer = await gql(h, "{ markets {\n  items { marketId ");
    expect(answer.status).toBe(400);
    expect(answer.body?.data).toBeUndefined();
    expect(answer.body?.errors?.[0]).toMatchObject({ locations: [expect.any(Object)], extensions: { code: "graphql_syntax_error", status: 400 } });
    expect(h.fake.calls.listMarkets).toHaveLength(0);
  });

  it("answers a query that does not fit the schema with 400 and no data", async () => {
    for (const query of ["{ nothing }", "{ markets { items { nothing } } }", "{ market { marketId } }", `{ market(id: 7, afterSequence: "x") { marketId } }`, "query A { markets { items { marketId } } } query B { markets { items { marketId } } }"]) {
      const answer = await gql(h, query);
      expect(answer.status, query).toBe(400);
      expect(answer.body?.data, query).toBeUndefined();
      expect(answer.body?.errors?.length, query).toBeGreaterThan(0);
    }
    expect(h.fake.calls.listMarkets).toHaveLength(0);
  });

  it("has no mutation and no subscription: both are refused as a query that does not fit, and nothing runs", async () => {
    const mutation = await gql(h, `mutation { resolveMarket(id: "${MARKET_1}") { marketId } }`);
    expect(mutation.status).toBe(400);
    expect(codesOf(mutation)).toEqual(["graphql_validation_failed"]);
    expect(mutation.body?.errors?.[0]?.["message"]).toContain("mutation");
    const subscription = await gql(h, "subscription { markets { items { marketId } } }");
    expect(subscription.status).toBe(400);
    expect(codesOf(subscription)).toEqual(["graphql_validation_failed"]);
    expect(Object.values(h.fake.calls).every((list) => list.length === 0)).toBe(true);
  });

  it("needs an operation name when the document has several, and runs the one that is named", async () => {
    const query = "query A { markets { items { marketId } } } query B { market(id: \"" + MARKET_1 + "\") { marketId } }";
    expect((await gql(h, query)).status).toBe(400);
    const named = await gql(h, query, { operationName: "B" });
    expect(named.status).toBe(200);
    expect(named.body?.data).toEqual({ market: { marketId: MARKET_1 } });
    expect(h.fake.calls.listMarkets).toHaveLength(0);
    expect((await gql(h, query, { operationName: "C" })).status).toBe(400);
  });

  it("needs the variables a query declares", async () => {
    const answer = await gql(h, "query($id: ID!) { market(id: $id) { marketId } }");
    expect(answer.status).toBe(400);
    expect(codesOf(answer)).toEqual(["graphql_validation_failed"]);
  });

  // graphql wraps the refusal of a built-in scalar or an enum with the inner error as `originalError`; that is the caller's
  // mistake, as the same value written in the query is, and no bug of the service to log.
  const wrongVariables: Array<[string, string, Record<string, unknown>]> = [
    ["an enum value that does not exist", "query($s: MarketStatus) { markets(status: $s) { items { marketId } } }", { s: "BOGUS" }],
    ["an interval that does not exist", `query($i: HistoryInterval) { history(marketId: "${MARKET_1}", interval: $i) { marketId } }`, { i: "WEEKLY" }],
    ["an Int sent as text", "query($n: Int) { markets(first: $n) { items { marketId } } }", { n: "abc" }],
    ["an Int sent as a fraction", "query($n: Int) { markets(first: $n) { items { marketId } } }", { n: 1.5 }],
    ["an ID sent as an object", "query($id: ID!) { market(id: $id) { marketId } }", { id: { a: 1 } }],
    ["an item of ids sent as an object", "query($ids: [ID!]) { markets(ids: $ids) { items { marketId } } }", { ids: ["a", { b: 1 }] }],
    ["ids sent as an object", "query($ids: [ID!]) { markets(ids: $ids) { items { marketId } } }", { ids: { a: 1 } }],
  ];
  it.each(wrongVariables)("answers %s in a variable as a query error, not as a failure of the service", async (_name, query, variables) => {
    const logged = h.logLines.length;
    const answer = await gql(h, query, { variables });
    expect(answer.status).toBe(400);
    expect(answer.body?.data).toBeUndefined();
    expect(codesOf(answer)).toEqual(["graphql_validation_failed"]);
    expect(answer.body?.errors?.[0]).toMatchObject({ locations: [expect.any(Object)], extensions: { code: "graphql_validation_failed", status: 400 } });
    expect(answer.text).not.toContain("The service failed to handle the request");
    // Nothing was logged at error level: the caller cannot fill the error log with a wrong variable.
    expect(h.logLines.slice(logged).filter((line) => line.includes('"level":50') || line.includes("A GraphQL resolver failed"))).toEqual([]);
    expect(Object.values(h.fake.calls).every((list) => list.length === 0)).toBe(true);
  });

  it("tells the caller which variable is wrong, and cuts the \"Did you mean\" of an enum variable while introspection is off", async () => {
    const answer = await gql(h, "query($s: MarketStatus) { markets(status: $s) { items { marketId } } }", { variables: { s: "OPEM" } });
    expect(answer.body?.errors?.[0]?.["message"]).toContain('Variable "$s"');
    expect(answer.text).not.toContain("Did you mean");
    expect(answer.text).not.toContain("OPEN");
  });

  it("answers a variable of the right type as before, and the same wrong value written in the query as the same code", async () => {
    const good = await gql(h, "query($s: MarketStatus, $n: Int) { markets(status: $s, first: $n) { items { marketId } } }", { variables: { s: "OPEN", n: 5 } });
    expect(good.status).toBe(200);
    const literal = await gql(h, '{ markets(status: BOGUS) { items { marketId } } }');
    expect(literal.status).toBe(400);
    expect(codesOf(literal)).toEqual(["graphql_validation_failed"]);
  });
});

describe("only POST with a JSON object", () => {
  it.each(["GET", "PUT", "DELETE", "PATCH"] as const)("answers %s with 405 and Allow: POST, and runs nothing", async (method) => {
    const answer = await send(h, method, `${GRAPHQL}?query=${encodeURIComponent("{ markets { items { marketId } } }")}`, undefined);
    expect(answer.status).toBe(405);
    expect(answer.headers["allow"]).toBe("POST");
    expect(answer.body?.errors?.[0]).toMatchObject({ extensions: { code: "method_not_allowed", status: 405 } });
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    expect(answer.text).not.toContain("marketId\":");
    expect(Object.values(h.fake.calls).every((list) => list.length === 0)).toBe(true);
  });

  it("answers a GET without a token the same way, a path below the endpoint with the usual 404 problem", async () => {
    const get = await send(h, "GET", GRAPHQL, undefined, { token: null });
    expect(get.status).toBe(405);
    const below = await send(h, "GET", `${GRAPHQL}/extra`, undefined, { token: null });
    expect(below.status).toBe(404);
    expect(below.headers["content-type"]).toContain("application/problem+json");
    const slash = await send(h, "POST", `${GRAPHQL}/`, { query: "{ markets { items { marketId } } }" });
    expect(slash.status).toBe(404);
  });

  it("refuses a body that is not application/json with 415: a form or a text post cannot be sent by another site without a preflight", async () => {
    for (const type of ["application/x-www-form-urlencoded", "application/graphql", "multipart/form-data; boundary=x"]) {
      const answer = await send(h, "POST", GRAPHQL, "query=%7B+markets+%7B+items+%7B+marketId+%7D+%7D+%7D", { headers: { "content-type": type } });
      expect(answer.status, type).toBe(415);
      expect(answer.body?.errors?.[0], type).toMatchObject({ extensions: { code: "bad_request", status: 415 } });
    }
    // Fastify reads text/plain as a string, and a string is not the JSON object the endpoint needs: 400, nothing runs.
    const text = await send(h, "POST", GRAPHQL, JSON.stringify({ query: "{ markets { items { marketId } } }" }), { headers: { "content-type": "text/plain" } });
    expect(text.status).toBe(400);
    expect(text.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed" } });
    expect(h.fake.calls.listMarkets).toHaveLength(0);
  });

  it.each([
    ["no body", undefined],
    ["an empty object", {}],
    ["an array of queries (a batch)", [{ query: "{ markets { items { marketId } } }" }]],
    ["a query that is not text", { query: 7 }],
    ["an empty query", { query: "" }],
    ["variables that are a list", { query: "{ markets { items { marketId } } }", variables: [1] }],
    ["an operation name that is not text", { query: "{ markets { items { marketId } } }", operationName: 4 }],
    ["a member of its own", { query: "{ markets { items { marketId } } }", tenantId: TENANT_B }],
    ["a query of more than 10 000 characters", { query: `{ markets { items { marketId } } } ${"#".repeat(10_001)}` }],
  ])("refuses %s with 400 validation_failed", async (_name, payload) => {
    const answer = await send(h, "POST", GRAPHQL, payload, payload === undefined ? { headers: { "content-type": "application/json" } } : {});
    expect(answer.status).toBe(400);
    expect(answer.body?.errors?.[0]).toMatchObject({ extensions: { code: "validation_failed", status: 400 } });
    expect(h.fake.calls.listMarkets).toHaveLength(0);
  });

  it("refuses JSON that does not parse with 400, and a body over the size limit with 413", async () => {
    const bad = await send(h, "POST", GRAPHQL, "{not json", { headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    expect(bad.body?.errors?.[0]?.["extensions"]["code"]).toBe("bad_request");
    const big = await send(h, "POST", GRAPHQL, JSON.stringify({ query: "{ markets { items { marketId } } }", variables: { padding: "x".repeat(20_000) } }), { headers: { "content-type": "application/json" } });
    expect(big.status).toBe(413);
  });

  it("accepts and ignores `extensions` and a null operation name and variables, as GraphQL clients send them", async () => {
    const answer = await send(h, "POST", GRAPHQL, { query: "{ markets { items { marketId } } }", variables: null, operationName: null, extensions: { clientName: "web" } });
    expect(answer.status).toBe(200);
    expect(answer.body?.errors).toBeUndefined();
  });
});

describe("the endpoint's own limits (settings of the service)", () => {
  const settings = (overrides: Partial<{ introspection: boolean; maxDepth: number; maxComplexity: number }> = {}) => ({ introspection: false, maxDepth: 5, maxComplexity: 5000, ...overrides });
  const open = async <T>(overrides: Parameters<typeof settings>[0], work: (harness: Harness) => Promise<T>): Promise<T> => {
    const harness = await createHarness({ graphql: settings(overrides) });
    try {
      return await work(harness);
    } finally {
      await harness.close();
    }
  };

  it("refuses a query deeper than GRAPHQL_MAX_DEPTH before it runs, with the depth in the error", async () => {
    await open({ maxDepth: 2 }, async (harness) => {
      const answer = await gql(harness, "{ markets { items { marketId } } }");
      expect(answer.status).toBe(400);
      expect(answer.body?.data).toBeUndefined();
      expect(answer.body?.errors?.[0]).toMatchObject({ extensions: { code: "depth_limit_exceeded", status: 400, depth: 3, maxDepth: 2 } });
      expect(harness.fake.calls.listMarkets).toHaveLength(0);
      expect((await gql(harness, `{ market(id: "${MARKET_1}") { marketId } }`)).status).toBe(200);
    });
  });

  it("refuses a query over GRAPHQL_MAX_COMPLEXITY before it runs: aliases, fragments and page sizes all count", async () => {
    await open({ maxComplexity: 100 }, async (harness) => {
      const one = await gql(harness, `{ market(id: "${MARKET_1}") { marketId } }`);
      expect(one.status).toBe(200);
      const aliases = Array.from({ length: 10 }, (_, index) => `m${index}: market(id: "${MARKET_1}") { marketId }`).join(" ");
      const many = await gql(harness, `{ ${aliases} }`);
      expect(many.status).toBe(400);
      expect(many.body?.errors?.[0]).toMatchObject({ extensions: { code: "complexity_limit_exceeded", status: 400, complexity: 220, maxComplexity: 100 } });
      const page = await gql(harness, "{ markets(first: 100) { items { marketId } } }");
      expect(page.body?.errors?.[0]).toMatchObject({ extensions: { code: "complexity_limit_exceeded", complexity: 221 } });
      const small = await gql(harness, "{ markets(first: 10) { items { marketId } } }");
      expect(small.status).toBe(200);
      expect(harness.fake.calls.getMarket).toHaveLength(1);
      expect(harness.fake.calls.listMarkets).toHaveLength(1);
    });
  });

  it("costs a page size that a variable gets from its default like the same size written in the query", async () => {
    // Thirteen full pages of 100 markets: refused as a literal (23 673), and refused when the size is a default of the variable.
    const page = (size: string) => Array.from({ length: 13 }, (_, index) => `a${index}: markets(first: ${size}) { items { ${MARKET_FIELDS} } }`).join(" ");
    const history = (size: string) => Array.from({ length: 6 }, (_, index) => `h${index}: history(marketId: "${MARKET_1}", first: ${size}) { buckets { start openYesMicro highYesMicro lowYesMicro closeYesMicro volumeMicro trades } }`).join(" ");
    const literal = await gql(h, `{ ${page("100")} }`);
    expect(literal.status).toBe(400);
    expect(literal.body?.errors?.[0]).toMatchObject({ extensions: { code: "complexity_limit_exceeded", complexity: 23_673 } });

    for (const options of [{}, { variables: {} }]) {
      const withDefault = await gql(h, `query($n: Int = 100) { ${page("$n")} }`, options);
      expect(withDefault.status, JSON.stringify(options)).toBe(400);
      expect(withDefault.body?.errors?.[0], JSON.stringify(options)).toMatchObject({ extensions: { code: "complexity_limit_exceeded", complexity: 23_673 } });
    }
    const history500 = await gql(h, `query($n: Int = 500) { ${history("$n")} }`);
    expect(history500.status).toBe(400);
    expect(history500.body?.errors?.[0]).toMatchObject({ extensions: { code: "complexity_limit_exceeded", complexity: 24_126 } });
    // Nothing of the refused queries ran.
    expect(h.fake.calls.listMarkets).toHaveLength(0);
    expect(h.fake.calls.getHistory).toHaveLength(0);

    // A value the request sends wins over the default, and a cheap query with a default still runs.
    const sent = await gql(h, `query($n: Int = 100) { markets(first: $n) { items { marketId } } }`, { variables: { n: 3 } });
    expect(sent.status).toBe(200);
    const cheap = await gql(h, `query($n: Int = 5) { markets(first: $n) { items { marketId } } }`);
    expect(cheap.status).toBe(200);
    // The cost read the sizes that ran: the value sent, then the declared default.
    expect(h.fake.calls.listMarkets).toHaveLength(2);
    expect(h.fake.calls.listMarkets[0]).toMatchObject({ limit: 3 });
    expect(h.fake.calls.listMarkets[1]).toMatchObject({ limit: 5 });
  });

  it("refuses a field that a query repeats under one name far more often than a client does, before it validates", async () => {
    // 1 400 times `status` under one level: cheap by the cost (1 422) but graphql compares every pair of them while it validates.
    const repeated = await gql(h, `{ markets(first: 1) { items { ${"status ".repeat(1_400)} } } }`);
    expect(repeated.status).toBe(400);
    expect(repeated.body?.data).toBeUndefined();
    expect(repeated.body?.errors?.[0]).toMatchObject({ locations: [expect.any(Object)], extensions: { code: "complexity_limit_exceeded", status: 400, field: "status", maxRepeatedFields: MAX_REPEATED_FIELDS } });
    expect(h.fake.calls.listMarkets).toHaveLength(0);

    // The same holds for a parent repeated with a sub-selection, which graphql merges pair by pair.
    const parents = await gql(h, `{ ${"markets(first: 1) { items { status } } ".repeat(150)} }`);
    expect(parents.status).toBe(400);
    expect(codesOf(parents)).toEqual(["complexity_limit_exceeded"]);
    expect(h.fake.calls.listMarkets).toHaveLength(0);

    // A field selected again through fragments, as clients compose their queries, is far below the limit.
    const composed = await gql(h, "{ markets { items { marketId ...A ...B } } } fragment A on Market { marketId question } fragment B on Market { marketId status }");
    expect(composed.status).toBe(200);
    expect(h.fake.calls.listMarkets).toHaveLength(1);
  });

  it("is not slowed down by a fragment that spreads two others, thirty levels deep (the walk is memoized)", async () => {
    const fragments = Array.from({ length: 30 }, (_, index) => `fragment F${index} on Market { marketId ...F${index + 1} ...F${index + 1} }`).join("\n");
    const query = `{ market(id: "${MARKET_1}") { ...F0 } }\n${fragments}\nfragment F30 on Market { marketId }`;
    const started = Date.now();
    const answer = await gql(h, query);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answer.status).toBe(400);
    expect(codesOf(answer)).toContain("complexity_limit_exceeded");
  });

  it("refuses a document of thousands of nested selections without failing: the token limit and the depth limit answer 400", async () => {
    const nested = `{ ${"a { ".repeat(600)}${"}".repeat(600)} }`;
    const answer = await gql(h, nested);
    expect(answer.status).toBe(400);
    expect(answer.body?.errors?.length).toBeGreaterThan(0);
    const tokens = await gql(h, `{ ${"a ".repeat(2100)} }`);
    expect(tokens.status).toBe(400);
    expect(codesOf(tokens)).toEqual(["graphql_syntax_error"]);
  });

  it("answers no introspection by default (__schema and __type), but __typename always", async () => {
    for (const query of ["{ __schema { types { name } } }", `{ __type(name: "Market") { name } }`, "{ markets { items { marketId } } __schema { queryType { name } } }"]) {
      const answer = await gql(h, query);
      expect(answer.status, query).toBe(400);
      expect(codesOf(answer)).toContain("introspection_disabled");
    }
    const typename = await gql(h, "{ __typename markets { __typename items { __typename } } }");
    expect(typename.status).toBe(200);
    expect(typename.body?.data).toMatchObject({ __typename: "Query", markets: { __typename: "MarketPage" } });
    expect(h.fake.calls.listMarkets).toHaveLength(1);
  });

  it("cuts the \"Did you mean\" of a query error while introspection is off, and keeps it while it is on", async () => {
    const query = "{ marketz { items { marketId } } }";
    const off = await gql(h, query);
    expect(off.status).toBe(400);
    expect(off.body?.errors?.[0]?.["message"]).toBe('Cannot query field "marketz" on type "Query".');
    expect(off.text).not.toContain("Did you mean");
    const enumValue = await gql(h, "{ markets(status: OPEM) { items { marketId } } }");
    expect(enumValue.status).toBe(400);
    expect(enumValue.text).not.toContain("OPEN");
    await open({ introspection: true }, async (harness) => {
      const on = await gql(harness, query);
      expect(on.body?.errors?.[0]?.["message"]).toContain("Did you mean");
    });
  });

  it("answers introspection when GRAPHQL_INTROSPECTION is on, outside the depth and complexity limits", async () => {
    await open({ introspection: true, maxDepth: 2, maxComplexity: 10 }, async (harness) => {
      const answer = await gql(harness, "{ __schema { queryType { name } types { name fields { name type { name ofType { name ofType { name } } } } } } }");
      expect(answer.status).toBe(200);
      expect(answer.body?.data?.["__schema"].queryType.name).toBe("Query");
    });
  });
});
