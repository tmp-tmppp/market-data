import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphQLNonNull, buildClientSchema, buildSchema, getIntrospectionQuery, isEnumType, isNonNullType, isObjectType, lexicographicSortSchema, printSchema } from "graphql";
import type { GraphQLSchema, IntrospectionQuery } from "graphql";
import { parse as parseYaml } from "yaml";
import { DEFAULT_GRAPHQL_SETTINGS } from "../../src/config.js";
import { INTERVALS } from "../../src/domain/history.js";
import { MARKET_STATUSES } from "../../src/domain/projection.js";
import { OUTCOMES } from "../../src/domain/units.js";
import { readSchemaFile } from "../../src/web/graphql/endpoint.js";
import { MAX_REPEATED_FIELDS } from "../../src/web/graphql/limits.js";
import { INTERVAL_NAME, STATUS_NAME } from "../../src/web/graphql/resolvers.js";
import { openapi } from "../support/contracts.js";
import type { Doc } from "../support/contracts.js";
import { createHarness } from "../support/fake-use-cases.js";
import type { Harness } from "../support/fake-use-cases.js";
import { GRAPHQL, send } from "../support/graphql.js";

// contracts/graphql/schema.graphql against the code and against the REST contract. The service builds its schema from
// that file, so "the served schema equals the file" is checked on what a client can read: the introspection answer of a
// running application.

const FILE = new URL("../../contracts/graphql/schema.graphql", import.meta.url);
const sdl = readFileSync(FILE, "utf8");
const fileSchema = buildSchema(sdl);
const normalized = (schema: GraphQLSchema): string => printSchema(lexicographicSortSchema(schema));

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ graphql: { ...DEFAULT_GRAPHQL_SETTINGS, introspection: true } });
});
afterAll(async () => {
  await h.close();
});

/** The schema a client builds from the endpoint's introspection answer. */
async function servedSchema(harness: Harness): Promise<GraphQLSchema> {
  const query = getIntrospectionQuery({ descriptions: true, specifiedByUrl: true, directiveIsRepeatable: true, schemaDescription: true, inputValueDeprecation: true });
  const answer = await send(harness, "POST", GRAPHQL, { query });
  expect(answer.status, answer.text.slice(0, 300)).toBe(200);
  expect(answer.body?.errors).toBeUndefined();
  return buildClientSchema(answer.body?.data as unknown as IntrospectionQuery);
}

describe("contracts/graphql/schema.graphql, the file", () => {
  it("is the file the service reads at start", () => {
    expect(readSchemaFile()).toBe(sdl);
  });

  it("states the fixed limit on repeated fields that the endpoint keeps, here and in the README", () => {
    expect(sdl).toContain(`more than ${MAX_REPEATED_FIELDS} times in all`);
    expect(readFileSync(new URL("../../README.md", import.meta.url), "utf8")).toContain(`at most ${MAX_REPEATED_FIELDS} times in all`);
  });

  it("offers queries only: no mutation and no subscription type, three root fields with the arguments of the plan", () => {
    expect(fileSchema.getMutationType()).toBeUndefined();
    expect(fileSchema.getSubscriptionType()).toBeUndefined();
    const fields = fileSchema.getQueryType()?.getFields() ?? {};
    expect(Object.keys(fields).sort()).toEqual(["history", "market", "markets"]);
    const args = (name: string) => (fields[name]?.args ?? []).map((argument) => argument.name).sort();
    expect(args("markets")).toEqual(["after", "first", "ids", "status"]);
    expect(args("market")).toEqual(["afterSequence", "id"]);
    // `afterSequence` is DM-17 for the charts, which read the history: the REST history has it too.
    expect(args("history")).toEqual(["after", "afterSequence", "first", "from", "interval", "marketId", "to"]);
  });

  it("makes every root field nullable, so one failed read leaves the others of the query answering", () => {
    for (const [name, field] of Object.entries(fileSchema.getQueryType()?.getFields() ?? {})) expect(isNonNullType(field.type), name).toBe(false);
  });

  it("names no tenant anywhere: the tenant of a request is the token's", () => {
    for (const type of Object.values(fileSchema.getTypeMap())) {
      if (type.name.startsWith("__") || !isObjectType(type)) continue;
      for (const field of Object.values(type.getFields())) {
        expect(field.name.toLowerCase(), `${type.name}.${field.name}`).not.toContain("tenant");
        for (const argument of field.args) expect(argument.name.toLowerCase(), `${type.name}.${field.name}(${argument.name})`).not.toContain("tenant");
      }
    }
  });

  it("describes every type and every root field (the file is the API documentation)", () => {
    for (const type of Object.values(fileSchema.getTypeMap())) {
      if (type.name.startsWith("__")) continue;
      expect(type.description, type.name).toBeTruthy();
    }
    for (const [name, field] of Object.entries(fileSchema.getQueryType()?.getFields() ?? {})) expect(field.description, name).toBeTruthy();
  });

  it("has enums that are the domain's lists, name for name", () => {
    const statuses = fileSchema.getType("MarketStatus");
    const intervals = fileSchema.getType("HistoryInterval");
    if (!isEnumType(statuses) || !isEnumType(intervals)) throw new Error("the enums are missing");
    // The maps of resolvers.ts are typed over the domain's lists, so a key added there fails to compile; this keeps the file
    // and the maps together, and the maps and the domain at runtime.
    expect(Object.keys(STATUS_NAME).sort()).toEqual([...MARKET_STATUSES].sort());
    expect(Object.keys(INTERVAL_NAME).sort()).toEqual(Object.keys(INTERVALS).sort());
    expect(statuses.getValues().map((value) => value.name).sort()).toEqual(Object.values(STATUS_NAME).sort());
    expect(intervals.getValues().map((value) => value.name).sort()).toEqual(Object.values(INTERVAL_NAME).sort());
    const outcome = fileSchema.getType("Outcome");
    if (!isEnumType(outcome)) throw new Error("Outcome is missing");
    expect(outcome.getValues().map((value) => value.name)).toEqual([...OUTCOMES]);
  });
});

describe("the schema the application serves", () => {
  it("equals the file: types, fields, arguments, enums, scalars and every description", async () => {
    const served = await servedSchema(h);
    expect(normalized(served)).toBe(normalized(fileSchema));
    expect(served.getQueryType()?.name).toBe("Query");
    expect(served.getMutationType()).toBeNull();
    expect(served.getSubscriptionType()).toBeNull();
  });

  it("is checked by a comparison that can fail: a changed file or a changed served schema differs", async () => {
    const served = await servedSchema(h);
    const withoutField = buildSchema(sdl.replace("  afterSequence: Long\n  ): PriceHistory", "  ): PriceHistory").replace("    afterSequence: Long\n  ): PriceHistory", "  ): PriceHistory"));
    expect(normalized(served)).not.toBe(normalized(withoutField));
    const withMutation = buildSchema(`${sdl}\nextend schema { mutation: Mutation }\ntype Mutation { x: Int }`);
    expect(normalized(served)).not.toBe(normalized(withMutation));
    const described = buildSchema(sdl.replace("The outcome of a resolved market.", "Another text."));
    expect(normalized(served)).not.toBe(normalized(described));
  });

  it("serves the schema of a service with the production settings only as the file, never by introspection", async () => {
    const production = await createHarness();
    try {
      const answer = await send(production, "POST", GRAPHQL, { query: getIntrospectionQuery() });
      expect(answer.status).toBe(400);
      expect(answer.body?.errors?.[0]?.["extensions"]["code"]).toBe("introspection_disabled");
    } finally {
      await production.close();
    }
  });
});

describe("the same data as contracts/openapi.yaml", () => {
  const rest = (name: string): Doc => (openapi["components"].schemas as Record<string, Doc>)[name] as Doc;
  const nullable = (property: Doc): boolean => (Array.isArray(property["type"]) && property["type"].includes("null")) || (Array.isArray(property["oneOf"]) && property["oneOf"].some((option: Doc) => option["type"] === "null"));

  /** Every property of a REST schema is a field of the GraphQL type, nullable exactly where the REST property is. */
  function expectSameFields(restName: string, graphqlName: string, renamed: Record<string, string> = {}): void {
    const type = fileSchema.getType(graphqlName);
    if (!isObjectType(type)) throw new Error(`${graphqlName} is missing`);
    const fields = type.getFields();
    const properties = rest(restName)["properties"] as Record<string, Doc>;
    const expected = Object.keys(properties).map((name) => renamed[name] ?? name).sort();
    expect(Object.keys(fields).sort(), `${graphqlName} fields`).toEqual(expected);
    for (const [name, property] of Object.entries(properties)) {
      const field = fields[renamed[name] ?? name];
      if (!field || name in renamed) continue;
      expect(field.type instanceof GraphQLNonNull, `${graphqlName}.${name} non-null`).toBe(!nullable(property));
    }
  }

  it("has every field of Market and of its bucket, with the same nullability", () => {
    expectSameFields("Market", "Market");
    expectSameFields("Bucket", "PriceBucket");
  });

  it("has every field of the history, the REST cursor being the page info", () => {
    expectSameFields("History", "PriceHistory", { nextCursor: "pageInfo" });
    expectSameFields("MarketPage", "MarketPage", { nextCursor: "pageInfo" });
  });

  it("takes the query parameters of the REST routes as arguments, `first` and `after` for limit and cursor", () => {
    const nameOf = (item: Doc): string => String(item["$ref"] ? (openapi["components"].parameters as Record<string, Doc>)[String(item["$ref"]).split("/").pop() ?? ""]?.["name"] : item["name"]);
    const parameters = (path: string): string[] => ((openapi["paths"][path].get.parameters as Doc[]) ?? []).map(nameOf);
    const rename = (name: string): string => ({ limit: "first", cursor: "after" })[name as "limit" | "cursor"] ?? name;
    const argumentsOf = (field: string): string[] => (fileSchema.getQueryType()?.getFields()[field]?.args ?? []).map((argument) => argument.name).sort();
    expect(argumentsOf("markets")).toEqual(parameters("/v1/market-data/markets").map(rename).sort());
    expect(argumentsOf("market")).toEqual(["afterSequence", "id"]);
    expect(argumentsOf("history")).toEqual(parameters("/v1/market-data/markets/{marketId}/history").map(rename).sort());
  });
});

describe("what the image and the chart carry", () => {
  const root = new URL("../../", import.meta.url);
  const text = (file: string): string => readFileSync(new URL(file, root), "utf8");

  it("copies the schema file into the image and keeps it out of the build-context ignore list", () => {
    expect(text("Dockerfile")).toMatch(/^COPY contracts\/graphql \.\/contracts\/graphql$/m);
    const ignore = text(".dockerignore").split("\n").map((line) => line.trim());
    expect(ignore).toContain("!contracts/graphql");
    // The rest of contracts/ stays out of the image: only the exception of the one folder.
    expect(ignore).toContain("contracts/*");
    expect(ignore).not.toContain("contracts");
  });

  it("sets the three GraphQL keys in the chart with the service's defaults, and bounds them in the schema as config.ts does", () => {
    const values = parseYaml(text("helm/values.yaml")) as Doc;
    expect(values["env"]).toMatchObject({
      GRAPHQL_INTROSPECTION: String(DEFAULT_GRAPHQL_SETTINGS.introspection),
      GRAPHQL_MAX_DEPTH: String(DEFAULT_GRAPHQL_SETTINGS.maxDepth),
      GRAPHQL_MAX_COMPLEXITY: String(DEFAULT_GRAPHQL_SETTINGS.maxComplexity),
    });
    const properties = (JSON.parse(text("helm/values.schema.json")) as Doc)["properties"]["env"]["properties"] as Record<string, Doc>;
    const accepts = (key: string, value: string): boolean => new RegExp(String(properties[key]?.["pattern"])).test(value);
    for (const value of ["1", "5", "10"]) expect(accepts("GRAPHQL_MAX_DEPTH", value), value).toBe(true);
    for (const value of ["0", "11", "05", "x", ""]) expect(accepts("GRAPHQL_MAX_DEPTH", value), value).toBe(false);
    for (const value of ["10", "19", "20", "99", "100", "5000", "99999", "100000"]) expect(accepts("GRAPHQL_MAX_COMPLEXITY", value), value).toBe(true);
    for (const value of ["9", "0", "100001", "1000000", "010", "x", ""]) expect(accepts("GRAPHQL_MAX_COMPLEXITY", value), value).toBe(false);
    expect(properties["GRAPHQL_INTROSPECTION"]?.["enum"]).toEqual(["true", "false"]);
  });
});
