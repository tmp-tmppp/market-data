import { errors } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKET_1, TENANT_A, TENANT_B, asPlatformAdmin, asTenantAdmin, asTrader, call, createHarness, expectContract } from "../support/fake-use-cases.js";
import type { Harness } from "../support/fake-use-cases.js";
import { TENANT_ADMIN_GROUP, TRADER_GROUP } from "../support/tokens.js";
import type { TokenOptions } from "../support/tokens.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

/** Every authenticated endpoint: the URL to call and the path as contracts/openapi.yaml writes it. */
const endpoints = [
  ["/v1/market-data/markets", "/v1/market-data/markets"],
  [`/v1/market-data/markets/${MARKET_1}`, "/v1/market-data/markets/{marketId}"],
  [`/v1/market-data/markets/${MARKET_1}/history`, "/v1/market-data/markets/{marketId}/history"],
] as const;

describe("authentication (401)", () => {
  it("answers 401 without a token, with a malformed header and with a bad token, on every endpoint", async () => {
    for (const [url, path] of endpoints) {
      const variants: Array<Record<string, string>> = [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }, { authorization: "Bearer not.a.jwt" }];
      for (const headers of variants) {
        const answer = await call(h, "GET", url, { token: null, headers });
        expect(answer.status, url).toBe(401);
        expect(answer.headers["content-type"]).toContain("application/problem+json");
        expect(answer.headers["www-authenticate"]).toContain("Bearer");
        expect(answer.body).toMatchObject({ status: 401, code: "unauthorized", type: "urn:chance:problem:unauthorized" });
        expectContract(path, "GET", answer);
      }
    }
  });

  it("answers 401 for a token with the wrong issuer, audience or signature, or an expired one", async () => {
    const bad = [
      await h.keys.sign({ ...asTrader(), issuer: "http://localhost:8081/realms/other" }),
      await h.keys.sign({ ...asTrader(), audience: "someone-else" }),
      await h.keys.signWithOtherKey(asTrader()),
      await h.keys.sign({ ...asTrader(), expiresIn: -60 }),
    ];
    for (const token of bad) {
      const answer = await h.app.inject({ method: "GET", url: "/v1/market-data/markets", headers: { authorization: `Bearer ${token}` } });
      expect(answer.statusCode).toBe(401);
    }
  });

  it("answers 401 for a correctly signed token that has no exp claim (it would never expire)", async () => {
    const token = await h.keys.sign({ ...asTrader(), noExpiry: true });
    const answer = await h.app.inject({ method: "GET", url: "/v1/market-data/markets", headers: { authorization: `Bearer ${token}` } });
    expect(answer.statusCode).toBe(401);
    expect(answer.headers["www-authenticate"]).toContain("Bearer");
    expect(answer.json()).toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("answers 401 for an unsigned token", async () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"x"}').toString("base64url")}.`;
    const answer = await h.app.inject({ method: "GET", url: "/v1/market-data/markets", headers: { authorization: `Bearer ${unsigned}` } });
    expect(answer.statusCode).toBe(401);
  });

  it("answers 401 for a token that names more than one organization, whatever the groups in them", async () => {
    const bothTraders = { sub: "multi-1", memberships: { [TENANT_A]: [TRADER_GROUP], [TENANT_B]: [TRADER_GROUP] } };
    const oneWithoutGroup = { sub: "multi-2", memberships: { [TENANT_A]: [TRADER_GROUP], [TENANT_B]: [] } };
    const oldShape = { sub: "multi-3", roles: ["trader"], organization: [TENANT_A, TENANT_B] };
    for (const token of [bothTraders, oneWithoutGroup, oldShape]) {
      for (const [url] of endpoints) {
        const answer = await call(h, "GET", url, { token });
        expect(answer.status, `${url} ${JSON.stringify(token)}`).toBe(401);
        expect(answer.headers["www-authenticate"]).toContain("invalid_token");
      }
    }
  });

  it("answers 401 for a token without a subject", async () => {
    const token = await h.keys.sign({ ...asTrader(), sub: "" });
    const answer = await h.app.inject({ method: "GET", url: "/v1/market-data/markets", headers: { authorization: `Bearer ${token}` } });
    expect(answer.statusCode).toBe(401);
  });

  it("does not write the token into the logs", async () => {
    const token = await h.sign(asTrader("log-trader"));
    await h.app.inject({ method: "GET", url: "/v1/market-data/markets", headers: { authorization: `Bearer ${token}` } });
    expect(h.logLines.join("")).not.toContain(token);
  });
});

describe("the identity provider's signing keys (503)", () => {
  it("answers 503 with Retry-After, not 401, when the keys cannot be fetched, and recovers when they can", async () => {
    h.failKeys(new Error("connect ECONNREFUSED"));
    try {
      for (const [url, path] of endpoints) {
        const answer = await call(h, "GET", url);
        expect(answer.status, url).toBe(503);
        expect(answer.headers["retry-after"]).toBe("5");
        expect(answer.body).toMatchObject({ code: "identity_provider_unavailable", status: 503 });
        expectContract(path, "GET", answer);
      }
    } finally {
      h.failKeys(null);
    }
    expect((await call(h, "GET", "/v1/market-data/markets")).status).toBe(200);
  });

  it("tells a key problem from a token problem: a timeout or a broken key set is 503, a key that does not match is 401", async () => {
    try {
      for (const failure of [new errors.JWKSTimeout(), new errors.JWKSInvalid("the key set is not valid"), new TypeError("fetch failed")]) {
        h.failKeys(failure);
        expect((await call(h, "GET", "/v1/market-data/markets")).status, failure.name).toBe(503);
      }
      h.failKeys(new errors.JWKSNoMatchingKey());
      expect((await call(h, "GET", "/v1/market-data/markets")).status).toBe(401);
    } finally {
      h.failKeys(null);
    }
  });
});

/** Every endpoint answers 403 to the token. */
async function expectForbiddenEverywhere(token: TokenOptions): Promise<void> {
  for (const [url, path] of endpoints) {
    const answer = await call(h, "GET", url, { token });
    expect(answer.status, `${url} ${JSON.stringify(token)}`).toBe(403);
    expect(answer.body).toMatchObject({ status: 403, code: "forbidden", type: "urn:chance:problem:forbidden" });
    expectContract(path, "GET", answer);
  }
}

describe("roles and tenants (403)", () => {
  it("answers 403 to a platform admin on every endpoint, also with a tenant and a tenant group in the token", async () => {
    await expectForbiddenEverywhere(asPlatformAdmin());
    await expectForbiddenEverywhere({ sub: "p-2", roles: ["platform-admin"], memberships: { [TENANT_A]: [TRADER_GROUP] } });
    await expectForbiddenEverywhere({ sub: "p-3", roles: ["platform-admin"], memberships: { [TENANT_A]: [TENANT_ADMIN_GROUP] } });
  });

  it("answers 403 to a token without a tenant or with a tenant that is not a UUID", async () => {
    const tokens: TokenOptions[] = [
      { sub: "u" },
      { sub: "u", organization: null },
      { sub: "u", memberships: {} },
      { sub: "u", memberships: { acme: [TENANT_ADMIN_GROUP] } },
      { sub: "u", memberships: { acme: [TRADER_GROUP] } },
    ];
    for (const token of tokens) await expectForbiddenEverywhere(token);
  });

  it("answers 403 before it validates the query or the path, and never reaches a use case", async () => {
    h.fake.clearCalls();
    expect((await call(h, "GET", "/v1/market-data/markets?nonsense=1", { token: asPlatformAdmin() })).status).toBe(403);
    expect((await call(h, "GET", "/v1/market-data/markets?limit=0", { token: asPlatformAdmin() })).status).toBe(403);
    expect((await call(h, "GET", "/v1/market-data/markets/not-a-uuid", { token: asPlatformAdmin() })).status).toBe(403);
    expect((await call(h, "GET", `/v1/market-data/markets/${MARKET_1}/history?interval=2h`, { token: { sub: "u" } })).status).toBe(403);
    expect(h.fake.calls.listMarkets).toEqual([]);
    expect(h.fake.calls.getMarket).toEqual([]);
    expect(h.fake.calls.getHistory).toEqual([]);
  });

  it("lets a trader (the group /trader) and a tenant admin (the group /tenant-admin) read everything, and passes the role on", async () => {
    for (const [token, role] of [
      [asTrader("reader-1"), "trader"],
      [asTenantAdmin("reader-2"), "tenant-admin"],
    ] as const) {
      h.fake.clearCalls();
      for (const [url, path] of endpoints) {
        const answer = await call(h, "GET", url, { token });
        expect(answer.status, `${role} ${url}`).toBe(200);
        expectContract(path, "GET", answer);
      }
      expect(h.fake.calls.listMarkets[0]?.actor).toMatchObject({ userId: token.sub, tenantId: TENANT_A, role });
      expect(h.fake.calls.getMarket[0]?.actor).toMatchObject({ userId: token.sub, tenantId: TENANT_A, role });
      expect(h.fake.calls.getHistory[0]?.actor).toMatchObject({ userId: token.sub, tenantId: TENANT_A, role });
    }
  });

  it("answers 403 to a token whose organization has both groups, no group or a group that is not a tenant role", async () => {
    const groups: Array<[string, string[]]> = [
      ["both groups", [TRADER_GROUP, TENANT_ADMIN_GROUP]],
      ["both groups, other order", [TENANT_ADMIN_GROUP, TRADER_GROUP]],
      ["no group", []],
      ["an unknown group", ["/viewer"]],
      ["a nested group", ["/trader/sub"]],
      ["a path without the slash", ["trader"]],
      ["another case", ["/Trader"]],
      ["an empty group", [""]],
      ["a valid group and an unknown one", [TRADER_GROUP, "/viewer"]],
      ["the same group twice", [TRADER_GROUP, TRADER_GROUP]],
    ];
    for (const [name, list] of groups) {
      await expectForbiddenEverywhere({ sub: `groups-${name}`, memberships: { [TENANT_A]: list } });
    }
    const answer = await call(h, "GET", "/v1/market-data/markets", { token: { sub: "both-1", memberships: { [TENANT_A]: [TRADER_GROUP, TENANT_ADMIN_GROUP] } } });
    expect(answer.body).toMatchObject({ code: "forbidden", detail: expect.stringContaining("exactly one group") });
  });

  it("answers 403 when the organization claim cannot carry a group: no object, no entry, no groups array, a group that is no text", async () => {
    const claims: Array<string[] | Record<string, unknown> | string> = [
      [TENANT_A],
      TENANT_A,
      { [TENANT_A]: {} },
      { [TENANT_A]: { id: "1" } },
      { [TENANT_A]: "/trader" },
      { [TENANT_A]: null },
      { [TENANT_A]: { groups: "/trader" } },
      { [TENANT_A]: { groups: { 0: "/trader" } } },
      { [TENANT_A]: { groups: [42] } },
      { [TENANT_A]: { groups: [["/trader"]] } },
      { [TENANT_A]: { groups: [{ path: "/trader" }] } },
      { [TENANT_A]: { group: ["/trader"], role: "trader", roles: ["trader"] } },
    ];
    for (const organization of claims) await expectForbiddenEverywhere({ sub: "u", organization });
  });

  it("refuses the old shape: a realm role trader or tenant-admin, with no group of the organization, is 403", async () => {
    const tokens: TokenOptions[] = [
      { sub: "old-1", roles: ["trader"], organization: [TENANT_A] },
      { sub: "old-2", roles: ["tenant-admin"], organization: [TENANT_A] },
      { sub: "old-3", roles: ["trader", "tenant-admin"], organization: [TENANT_A] },
      { sub: "old-4", roles: ["trader"], organization: { [TENANT_A]: { id: "1" } } },
      { sub: "old-5", roles: ["tenant-admin"], memberships: { [TENANT_A]: [] } },
      { sub: "old-6", roles: ["trader"], organization: TENANT_A },
      { sub: "old-7", roles: ["trader"] },
    ];
    for (const token of tokens) await expectForbiddenEverywhere(token);
  });

  it("takes the role from the group alone: other realm roles beside a valid group do no harm", async () => {
    const answer = await call(h, "GET", "/v1/market-data/markets", { token: { sub: "mix-1", roles: ["offline_access", "tenant-admin"], memberships: { [TENANT_A]: [TRADER_GROUP] } } });
    expect(answer.status).toBe(200);
    expect(h.fake.calls.listMarkets.at(-1)?.actor.role).toBe("trader");
  });

  it("takes the tenant from the token, never from the request", async () => {
    h.fake.clearCalls();
    const asA = await call(h, "GET", "/v1/market-data/markets", { token: asTrader("owner-1"), headers: { "x-tenant-id": TENANT_B } });
    expect(asA.status).toBe(200);
    expect(h.fake.calls.listMarkets[0]?.actor.tenantId).toBe(TENANT_A);
    const query = await call(h, "GET", `/v1/market-data/markets?tenantId=${TENANT_B}`);
    expect(query.status).toBe(400);
    expect(query.body?.["errors"]).toEqual([expect.objectContaining({ field: "tenantId" })]);
  });

  it("gives a caller of another tenant that tenant's data only: a market of tenant A is 404 for tenant B", async () => {
    const own = await call(h, "GET", `/v1/market-data/markets/${MARKET_1}`, { token: asTrader("a-1", TENANT_A) });
    expect(own.status).toBe(200);
    const other = await call(h, "GET", `/v1/market-data/markets/${MARKET_1}`, { token: asTrader("b-1", TENANT_B) });
    expect(other.status).toBe(404);
    expect(other.body).toMatchObject({ code: "not_found" });
  });
});
