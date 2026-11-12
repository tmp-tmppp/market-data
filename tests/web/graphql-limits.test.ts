import { describe, expect, it } from "vitest";
import type { DocumentNode, FragmentDefinitionNode, OperationDefinitionNode } from "graphql";
import { Kind, buildSchema, parse } from "../../src/web/graphql/graphql-js.js";
import { MAX_REPEATED_FIELDS, operationCost, operationDepth, limitRules, repeatedFieldError, ROOT_FIELD_COST } from "../../src/web/graphql/limits.js";
import { readSchemaFile } from "../../src/web/graphql/endpoint.js";

// The two measures behind GRAPHQL_MAX_DEPTH and GRAPHQL_MAX_COMPLEXITY, on documents of the real schema, without HTTP.

const schema = buildSchema(readSchemaFile());

function parts(source: string): { operation: OperationDefinitionNode; fragments: Map<string, FragmentDefinitionNode>; document: DocumentNode } {
  const document = parse(source);
  const fragments = new Map<string, FragmentDefinitionNode>();
  let operation: OperationDefinitionNode | undefined;
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
    else if (definition.kind === Kind.OPERATION_DEFINITION) operation ??= definition;
  }
  if (!operation) throw new Error("no operation");
  return { operation, fragments, document };
}

const depth = (source: string) => {
  const { operation, fragments } = parts(source);
  return operationDepth(operation, fragments);
};
const cost = (source: string, variables: Record<string, unknown> = {}) => {
  const { operation, fragments } = parts(source);
  return operationCost(operation, fragments, schema, variables);
};

const MARKET_FIELDS = "marketId question status closeTime openedAt closedAt resolvedAt outcome startingPriceYesMicro lastPriceYesMicro currentPriceYesMicro volumeMicro tradeCount lastTradeSequence lastTradeAt version updatedAt";

describe("operationDepth", () => {
  it("counts the levels of nested fields", () => {
    expect(depth("{ markets { items { marketId } } }")).toBe(3);
    expect(depth("{ market(id: \"x\") { marketId } }")).toBe(2);
    expect(depth("{ __typename }")).toBe(1);
    expect(depth("{ history(marketId: \"x\") { buckets { start } pageInfo { hasNextPage } } }")).toBe(3);
  });

  it("adds no level for a fragment spread or an inline fragment", () => {
    expect(depth("{ markets { ...P } } fragment P on MarketPage { items { marketId } }")).toBe(3);
    expect(depth("{ markets { ... on MarketPage { items { ... { marketId } } } } }")).toBe(3);
  });

  it("does not count the subtree of introspection, and survives a fragment cycle", () => {
    expect(depth("{ __schema { types { fields { type { ofType { ofType { name } } } } } } }")).toBe(1);
    expect(depth("{ markets { ...A } } fragment A on MarketPage { ...B } fragment B on MarketPage { ...A items { marketId } }")).toBeGreaterThanOrEqual(1);
  });

  it("walks a fragment once however often it is spread", () => {
    const fragments = Array.from({ length: 40 }, (_, index) => `fragment F${index} on Market { marketId ...F${index + 1} ...F${index + 1} }`).join(" ");
    expect(depth(`{ market(id: "x") { ...F0 } } ${fragments} fragment F40 on Market { marketId }`)).toBe(2);
  });
});

describe("operationCost", () => {
  it("costs a market by id as a root field plus its fields", () => {
    expect(cost('{ market(id: "x") { marketId question } }')).toBe(1 + ROOT_FIELD_COST + 2);
    expect(ROOT_FIELD_COST).toBe(20);
  });

  it("costs a full page of 100 markets with every field 1 824 and the default page 20 rows", () => {
    expect(cost(`{ markets(first: 100) { items { ${MARKET_FIELDS} } pageInfo { hasNextPage endCursor } } }`)).toBe(1824);
    expect(cost(`{ markets { items { ${MARKET_FIELDS} } pageInfo { hasNextPage endCursor } } }`)).toBe(1 + ROOT_FIELD_COST + (1 + 17) * 20 + 3);
  });

  it("costs a full page of 500 buckets 4 029, and the default page 100 buckets", () => {
    const history = (args: string) => `{ history(marketId: "x"${args}) { marketId interval from to previousCloseYesMicro buckets { start openYesMicro highYesMicro lowYesMicro closeYesMicro volumeMicro trades } pageInfo { hasNextPage endCursor } } }`;
    expect(cost(history(", first: 500"))).toBe(4029);
    expect(cost(history(""))).toBe(1 + ROOT_FIELD_COST + 5 + (1 + 7) * 100 + 3);
  });

  it("reads a page size from a variable, and the number of ids of a batch", () => {
    const query = "query($n: Int) { markets(first: $n) { items { marketId } } }";
    expect(cost(query, { n: 50 })).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 50);
    expect(cost(query, {})).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 20);
    expect(cost(query, { n: 5000 })).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 100);
    expect(cost(query, { n: -3 })).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 1);
    const batch = 'query($ids: [ID!]) { markets(ids: $ids, first: 100) { items { marketId } } }';
    expect(cost(batch, { ids: ["a", "b", "c"] })).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 3);
    expect(cost('{ markets(ids: ["a", "b"]) { items { marketId } } }')).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 2);
  });

  it("reads the default value of a variable the request does not send, as execution does", () => {
    const history = (declaration: string) => `query(${declaration}) { history(marketId: "x", first: $n) { buckets { start } } }`;
    const literal = (first: number) => `{ history(marketId: "x", first: ${first}) { buckets { start } } }`;
    expect(cost(history("$n: Int = 500"))).toBe(cost(literal(500)));
    expect(cost(history("$n: Int = 500"), {})).toBe(cost(literal(500)));
    expect(cost(history("$n: Int = 500"))).toBeGreaterThan(cost(literal(100)));
    // A value the request sends wins, an explicit null is the argument's own default, and a variable without a default is as before.
    expect(cost(history("$n: Int = 500"), { n: 7 })).toBe(cost(literal(7)));
    expect(cost(history("$n: Int = 500"), { n: null })).toBe(cost('{ history(marketId: "x") { buckets { start } } }'));
    expect(cost(history("$n: Int"))).toBe(cost('{ history(marketId: "x") { buckets { start } } }'));

    const markets = "query($n: Int = 100) { markets(first: $n) { items { marketId } } }";
    expect(cost(markets)).toBe(cost("{ markets(first: 100) { items { marketId } } }"));
    expect(cost(markets, { n: 3 })).toBe(cost("{ markets(first: 3) { items { marketId } } }"));
  });

  it("counts the ids of a list default like the ids of a literal list", () => {
    const ids = Array.from({ length: 100 }, (_, index) => `"m${index}"`).join(", ");
    const batch = `query($ids: [ID!] = [${ids}]) { markets(ids: $ids) { items { marketId } } }`;
    const literal = `{ markets(ids: [${ids}]) { items { marketId } } }`;
    expect(cost(batch)).toBe(cost(literal));
    expect(cost(batch)).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 100);
    expect(cost(batch, { ids: ["a", "b"] })).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 2);
    expect(cost(batch, { ids: null })).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 20);
  });

  it("takes the defaults of the operation that is costed, not of another one in the document", () => {
    const source = "query A($n: Int = 100) { markets(first: $n) { items { marketId } } } query B($n: Int = 2) { markets(first: $n) { items { marketId } } }";
    const document = parse(source);
    const operations = document.definitions.filter((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);
    const costs = operations.map((operation) => operationCost(operation, new Map(), schema, {}));
    expect(costs).toEqual([1 + ROOT_FIELD_COST + (1 + 1) * 100, 1 + ROOT_FIELD_COST + (1 + 1) * 2]);
  });

  it("counts every alias and every use of a fragment, because each one runs", () => {
    expect(cost('{ a: market(id: "x") { marketId } b: market(id: "x") { marketId } }')).toBe(2 * (1 + ROOT_FIELD_COST + 1));
    expect(cost('{ a: market(id: "x") { ...M } b: market(id: "y") { ...M } } fragment M on Market { marketId question }')).toBe(2 * (1 + ROOT_FIELD_COST + 2));
    expect(cost("{ markets { ...P } } fragment P on MarketPage { items { marketId } }")).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 20);
    expect(cost("{ markets { ... on MarketPage { items { marketId } } } }")).toBe(1 + ROOT_FIELD_COST + (1 + 1) * 20);
  });

  it("is a walk in proportion to the document for fragments that spread each other twice, and a number too big for any limit", () => {
    const fragments = Array.from({ length: 60 }, (_, index) => `fragment F${index} on Market { marketId ...F${index + 1} ...F${index + 1} }`).join(" ");
    const started = Date.now();
    const value = cost(`{ market(id: "x") { ...F0 } } ${fragments} fragment F60 on Market { marketId }`);
    expect(Date.now() - started).toBeLessThan(500);
    expect(value).toBeGreaterThan(1e15);
  });

  it("does not follow a fragment cycle, and gives introspection no cost", () => {
    expect(cost("{ markets { ...A } } fragment A on MarketPage { ...B } fragment B on MarketPage { ...A items { marketId } }")).toBeGreaterThan(0);
    expect(cost("{ __schema { types { name fields { name } } } }")).toBe(0);
    expect(cost("{ __typename }")).toBe(1 + 0);
  });

  it("gives a field the schema does not know the cost of a leaf, so the validation can report it", () => {
    expect(cost("{ nothing { more } }")).toBe(1 + ROOT_FIELD_COST + 1);
  });
});

// graphql merges the fields of one level that share a response name and compares every pair of them (and, for a field with a
// selection, every pair of its selections), so the work grows with the square of the repeats and compounds with the depth.
// The document may repeat a field only MAX_REPEATED_FIELDS times in all, counted before graphql validates.
describe("repeatedFieldError", () => {
  const check = (source: string) => repeatedFieldError(parse(source));
  const times = (text: string, count: number) => Array.from({ length: count }, () => text).join(" ");
  const LIMIT = MAX_REPEATED_FIELDS;

  it("allows a document that selects each field once, aliases of one field and the same name at different levels", () => {
    expect(check(`{ markets { items { ${MARKET_FIELDS} } pageInfo { hasNextPage endCursor } } }`)).toBeNull();
    expect(check(`{ ${Array.from({ length: 500 }, (_, index) => `a${index}: market(id: "x") { marketId }`).join(" ")} }`)).toBeNull();
    expect(check('{ market(id: "x") { marketId } markets { items { marketId } } history(marketId: "x") { marketId } }')).toBeNull();
    expect(check("{ __typename markets { __typename items { __typename } } }")).toBeNull();
  });

  it("allows as many repeats as the limit and refuses one more, of a field and of a field with a selection", () => {
    // A field selected LIMIT + 1 times repeats LIMIT times.
    expect(check(`{ markets { items { ${times("status", LIMIT + 1)} } } }`)).toBeNull();
    expect(check(`{ markets { items { ${times("status", LIMIT + 2)} } } }`)).not.toBeNull();
    expect(check(`{ ${times("markets { items { status } }", LIMIT + 1)} }`)).toBeNull();
    expect(check(`{ ${times("markets { items { status } }", LIMIT + 2)} }`)).not.toBeNull();
  });

  it("adds the repeats of every level and of every field together", () => {
    // Each level repeats a field `each` times (selected each + 1 times): two such levels fit the limit, three do not.
    const each = Math.floor(LIMIT / 2);
    const level = (name: string) => `${name}: markets { items { ${times("status", each + 1)} } }`;
    expect(check(`{ ${level("a")} ${level("b")} }`)).toBeNull();
    expect(check(`{ ${level("a")} ${level("b")} ${level("c")} }`)).not.toBeNull();
  });

  it("tells the name that crossed the limit, with the standard code and a position", () => {
    const error = check(`{ markets { items { marketId ${times("status", LIMIT + 2)} } } }`);
    expect(error?.message).toContain('"status"');
    expect(error?.message).toContain(String(LIMIT));
    expect(error?.extensions).toEqual({ code: "complexity_limit_exceeded", status: 400, field: "status", maxRepeatedFields: LIMIT });
    expect(error?.locations?.[0]).toMatchObject({ line: 1 });
    // The name is an alias where there is one.
    expect(check(`{ ${times("x: markets { items { marketId } }", LIMIT + 2)} }`)?.extensions["field"]).toBe("x");
    // A name is not echoed back without a bound.
    expect(String(check(`{ ${times(`${"n".repeat(500)}: market(id: "x") { marketId }`, LIMIT + 2)} }`)?.extensions["field"])).toHaveLength(64);
  });

  it("counts fields that graphql merges from inline fragments and from spread fragments", () => {
    expect(check(`{ markets { items { ${times("... { status }", LIMIT + 2)} } } }`)).not.toBeNull();
    expect(check(`{ markets { items { ${times("... on Market { status }", LIMIT + 1)} } } }`)).toBeNull();
    expect(check(`{ markets { items { ${times("...S", LIMIT + 2)} } } } fragment S on Market { status }`)).not.toBeNull();
    // A fragment adds the names it selects to the level it is spread into, and a name it repeats itself counts when it is spread.
    expect(check(`{ markets { items { status ...A ...B } } } fragment A on Market { status question } fragment B on Market { status marketId }`)).toBeNull();
    expect(check(`{ markets { items { status } } } fragment A on Market { ${times("status", LIMIT + 2)} }`)).not.toBeNull();
  });

  it("measures a document of fragments that spread each other twice at once, and does not follow a cycle", () => {
    const fragments = Array.from({ length: 60 }, (_, index) => `fragment F${index} on Market { marketId ...F${index + 1} ...F${index + 1} }`).join(" ");
    const started = Date.now();
    const error = check(`{ market(id: "x") { ...F0 } } ${fragments} fragment F60 on Market { marketId }`);
    expect(Date.now() - started).toBeLessThan(500);
    expect(error?.extensions["code"]).toBe("complexity_limit_exceeded");
    expect(check("{ markets { ...A } } fragment A on MarketPage { ...B } fragment B on MarketPage { ...A items { marketId } }")).toBeNull();
    expect(check("{ markets { ...Unknown } }")).toBeNull();
  });

  it("counts a repeated name on the way to a deep level, and stays inside the stack on a very deep one", () => {
    expect(check(`{ markets { items { ${times("status", LIMIT + 2)} } } }`)).not.toBeNull();
    const deep = `{ ${"a { ".repeat(650)}b ${"}".repeat(650)} }`;
    expect(check(deep)).toBeNull();
  });

  it("does not look inside introspection, but counts the introspection field itself", () => {
    expect(check(`{ __schema { types { ${times("name", 500)} } } }`)).toBeNull();
    expect(check(`{ ${times("__schema { queryType { name } }", LIMIT + 2)} }`)).not.toBeNull();
  });

  it("looks at every operation and every fragment of the document", () => {
    expect(check(`query A { markets { items { marketId } } } query B { markets { items { ${times("status", LIMIT + 2)} } } }`)).not.toBeNull();
    expect(check(`query A { markets { items { marketId } } } fragment Unused on Market { ${times("status", LIMIT + 2)} }`)).not.toBeNull();
  });
});

describe("limitRules", () => {
  it("is one rule for the limits and one more where introspection is off", () => {
    expect(limitRules({ maxDepth: 5, maxComplexity: 5000, introspection: true }, {})).toHaveLength(1);
    expect(limitRules({ maxDepth: 5, maxComplexity: 5000, introspection: false }, {})).toHaveLength(2);
  });
});
