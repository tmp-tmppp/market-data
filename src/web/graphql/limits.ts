import type { ASTVisitor, DocumentNode, FieldNode, FragmentDefinitionNode, GraphQLSchema, OperationDefinitionNode, SelectionNode, SelectionSetNode, ValidationContext, ValidationRule, ValueNode } from "graphql";
import { GraphQLError, Kind, OperationTypeNode, getNamedType, isInterfaceType, isObjectType } from "./graphql-js.js";
import { DEFAULT_HISTORY_PAGE_SIZE, DEFAULT_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE, MAX_IDS, MAX_PAGE_SIZE } from "../../usecases/support.js";

// Query limits and the introspection switch, as validation rules: a query over a limit never runs (REQ-17, ADR-023 "GraphQL
// needs depth limits"). They run next to the rules of the GraphQL specification, in the same pass, and answer with a
// stable code in `extensions.code`. Both walks are memoized per fragment, so a document whose fragments spread each other
// many times (the "billion laughs" shape) costs a walk in proportion to its size, and a fragment cycle (which the
// specification's own rule reports) is cut instead of followed. One more limit cannot be a rule, because the work it
// bounds is the specified rules' own: the repeats of a field under one name (`repeatedFieldError`), which the endpoint
// checks on the parsed document before it validates.

export interface LimitSettings {
  /** Levels of nested fields, introspection excluded. */
  maxDepth: number;
  maxComplexity: number;
  /** Whether `__schema` and `__type` are answered. */
  introspection: boolean;
}

type Variables = Readonly<Record<string, unknown>> | null | undefined;

/** `__schema` and `__type`; `__typename` is an ordinary leaf. */
const isIntrospectionField = (name: string): boolean => name === "__schema" || name === "__type";

// --- depth ----------------------------------------------------------------------------------------------------------

/**
 * The depth of an operation: `{ markets { items { marketId } } }` has depth 3. Fragment spreads and inline fragments add
 * no level of their own. The subtree of `__schema` and `__type` is not counted (the standard introspection query is about
 * ten levels deep); it is refused altogether where introspection is off.
 */
export function operationDepth(operation: OperationDefinitionNode, fragments: ReadonlyMap<string, FragmentDefinitionNode>): number {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const ofSet = (set: SelectionSetNode | undefined): number => {
    let deepest = 0;
    for (const selection of set?.selections ?? []) {
      let depth: number;
      switch (selection.kind) {
        case Kind.FIELD:
          depth = isIntrospectionField(selection.name.value) ? 1 : 1 + ofSet(selection.selectionSet);
          break;
        case Kind.INLINE_FRAGMENT:
          depth = ofSet(selection.selectionSet);
          break;
        default:
          depth = ofFragment(selection.name.value);
      }
      if (depth > deepest) deepest = depth;
    }
    return deepest;
  };
  const ofFragment = (name: string): number => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const fragment = fragments.get(name);
    if (fragment === undefined || visiting.has(name)) return 0;
    visiting.add(name);
    const depth = ofSet(fragment.selectionSet);
    visiting.delete(name);
    memo.set(name, depth);
    return depth;
  };
  return ofSet(operation.selectionSet);
}

// --- complexity -----------------------------------------------------------------------------------------------------

/** What one read of the read model costs besides its fields: a root field is a database round trip. */
export const ROOT_FIELD_COST = 20;

/** The list fields of a page, which cost their fields once per row of the page the parent field asks for. */
const LIST_FIELDS: ReadonlySet<string> = new Set(["MarketPage.items", "PriceHistory.buckets"]);

/** The value of an argument as far as the cost needs it: an integer, a list (its length) or null, from a literal or a variable. */
function valueOf(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case Kind.INT:
      return Number(node.value);
    case Kind.VARIABLE:
      return variables != null && Object.hasOwn(variables, node.name.value) ? variables[node.name.value] : undefined;
    case Kind.LIST:
      return node.values.map((item) => valueOf(item, variables));
    default:
      return undefined;
  }
}

/**
 * The variables of a request as execution sees them. A variable the request does not send takes the default value its
 * operation declares (`query($n: Int = 500)`), so the cost reads the page size that will run and not the field's default; a
 * variable that is sent, null included, is its own value, as in graphql's coercion of variables.
 */
function withDefaults(operation: OperationDefinitionNode, variables: Variables): Variables {
  let merged: Record<string, unknown> | undefined;
  for (const definition of operation.variableDefinitions ?? []) {
    const name = definition.variable.name.value;
    if (definition.defaultValue === undefined || (variables != null && Object.hasOwn(variables, name))) continue;
    merged ??= { ...variables };
    merged[name] = valueOf(definition.defaultValue, undefined);
  }
  return merged ?? variables;
}

function argumentOf(field: FieldNode, name: string, variables: Variables): unknown {
  const argument = field.arguments?.find((candidate) => candidate.name.value === name);
  return argument === undefined ? undefined : valueOf(argument.value, variables);
}

const clamp = (value: unknown, fallback: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.trunc(value))) : fallback;

/** The rows a page field asks for: `first`, or the number of `ids` of a batch (the use case refuses the invalid ones). */
const PAGE_SIZE_OF: Readonly<Record<string, (field: FieldNode, variables: Variables) => number>> = {
  "Query.markets": (field, variables) => {
    const ids = argumentOf(field, "ids", variables);
    if (Array.isArray(ids)) return clamp(ids.length, 1, MAX_IDS);
    return clamp(argumentOf(field, "first", variables), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  },
  "Query.history": (field, variables) => clamp(argumentOf(field, "first", variables), DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE),
};

/**
 * The cost of an operation: every selected field costs 1 (a field selected twice, an alias or a fragment used twice costs
 * twice, as it runs twice), a root field `ROOT_FIELD_COST` more, and the fields of `MarketPage.items` and
 * `PriceHistory.buckets` cost once per row the page asks for (`first`, default 20 or 100, at most 100 or 500; the number of
 * `ids` of a batch). A full page of 100 markets with every field costs 1 824, a full page of 500 buckets with every field
 * 4 029. Variables count with their value, or with the default value of their declaration when the request does not send
 * them. Introspection is free (it is off in production).
 */
export function operationCost(
  operation: OperationDefinitionNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  schema: GraphQLSchema,
  sent: Variables,
): number {
  const variables = withDefaults(operation, sent);
  const rootType = operation.operation === OperationTypeNode.QUERY ? (schema.getQueryType()?.name ?? null) : null;
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const ofSet = (set: SelectionSetNode | undefined, parentType: string | null, pageSize: number): number => {
    let cost = 0;
    for (const selection of set?.selections ?? []) {
      if (selection.kind === Kind.FIELD) {
        const name = selection.name.value;
        if (isIntrospectionField(name)) continue;
        if (name === "__typename") {
          cost += 1;
          continue;
        }
        const key = `${parentType ?? ""}.${name}`;
        const definition = parentType === null ? undefined : fieldOf(schema, parentType, name);
        const childType = definition === undefined ? null : getNamedType(definition.type).name;
        const childPageSize = PAGE_SIZE_OF[key]?.(selection, variables) ?? pageSize;
        const own = 1 + (parentType !== null && parentType === rootType ? ROOT_FIELD_COST : 0);
        const perRow = LIST_FIELDS.has(key) ? pageSize : 1;
        cost += (own + ofSet(selection.selectionSet, childType, childPageSize)) * perRow;
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        cost += ofSet(selection.selectionSet, selection.typeCondition?.name.value ?? parentType, pageSize);
      } else {
        cost += ofFragment(selection.name.value, pageSize);
      }
    }
    return cost;
  };

  const ofFragment = (name: string, pageSize: number): number => {
    const key = `${name}|${pageSize}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const fragment = fragments.get(name);
    if (fragment === undefined || visiting.has(name)) return 0;
    visiting.add(name);
    const cost = ofSet(fragment.selectionSet, fragment.typeCondition.name.value, pageSize);
    visiting.delete(name);
    memo.set(key, cost);
    return cost;
  };

  return ofSet(operation.selectionSet, rootType, 1);
}

function fieldOf(schema: GraphQLSchema, typeName: string, fieldName: string) {
  const type = schema.getType(typeName);
  return isObjectType(type) || isInterfaceType(type) ? type.getFields()[fieldName] : undefined;
}

// --- repeated fields --------------------------------------------------------------------------------------------------

/**
 * How many times a document may select a field under a response name that its level already has (`{ items { status
 * status } }` repeats once; fragments and inline fragments that add the same name to a level count too), all levels and
 * operations together. graphql merges the fields of a level that share a name and, while it validates, compares every pair
 * of them and every pair of their selections: the work grows with the square of the repeats and compounds with the depth
 * (1 400 times `status` is about 250 ms, 250 times `markets { items { status } }` about 235 ms, against 2 ms for a plain
 * query), and neither the length nor the token limit bounds it. A client has no use for a repeat (fragments composed by
 * components repeat a handful), so the limit sits above any real query, and the worst document that fits it (51 times
 * `markets { items { status } }`) validates in about 12 ms.
 */
export const MAX_REPEATED_FIELDS = 50;

/** The most of a response name an error repeats back to the caller. */
const NAME_SHOWN = 64;

/**
 * The 400 error of a document that repeats fields more than `MAX_REPEATED_FIELDS` times, or null. It runs on the parsed
 * document before graphql validates it: the validation rules cannot guard their own pass, because the specified rules run
 * in the same traversal. Fragments are walked once however often they are spread (a cycle is cut, as the rule of the
 * specification reports it), a walk stops at the first repeat over the limit, and the subtree of `__schema` and `__type`
 * is not counted.
 */
export function repeatedFieldError(document: DocumentNode, max: number = MAX_REPEATED_FIELDS): GraphQLError | null {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  const known = new Map<string, ReadonlyMap<string, number>>();
  const visiting = new Set<string>();
  const none: ReadonlyMap<string, number> = new Map();
  const state: { repeats: number; over: { name: string; node: SelectionNode } | null } = { repeats: 0, over: null };

  // The response names selected at one level (the set's own fields, those of its inline fragments and those of the spread
  // fragments), each with how often. A field's own selection is a level of its own.
  const levelOf = (set: SelectionSetNode): ReadonlyMap<string, number> => {
    const names = new Map<string, number>();
    const add = (name: string, count: number, node: SelectionNode): void => {
      const before = names.get(name);
      if (before !== undefined) {
        state.repeats += count;
        if (state.repeats > max && state.over === null) state.over = { name, node };
      }
      names.set(name, (before ?? 0) + count);
    };
    const collect = (current: SelectionSetNode): void => {
      for (const selection of current.selections) {
        if (state.over !== null) return;
        if (selection.kind === Kind.FIELD) {
          add(selection.alias?.value ?? selection.name.value, 1, selection);
          if (selection.selectionSet !== undefined && !isIntrospectionField(selection.name.value)) levelOf(selection.selectionSet);
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          collect(selection.selectionSet);
        } else {
          for (const [name, count] of levelOfFragment(selection.name.value)) add(name, count, selection);
        }
      }
    };
    collect(set);
    return names;
  };

  const levelOfFragment = (name: string): ReadonlyMap<string, number> => {
    const cached = known.get(name);
    if (cached !== undefined) return cached;
    const fragment = fragments.get(name);
    if (fragment === undefined || visiting.has(name)) return none;
    visiting.add(name);
    const names = levelOf(fragment.selectionSet);
    visiting.delete(name);
    known.set(name, names);
    return names;
  };

  for (const definition of document.definitions) {
    if (state.over !== null) break;
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      levelOf(definition.selectionSet);
    } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      // A second fragment of one name (the specification refuses it) is not the one the spreads reach: walk it on its own.
      if (fragments.get(definition.name.value) === definition) levelOfFragment(definition.name.value);
      else levelOf(definition.selectionSet);
    }
  }

  const { over } = state;
  if (over === null) return null;
  const shown = over.name.slice(0, NAME_SHOWN);
  return new GraphQLError(`The query selects a field again under a name its level already has more than ${max} times ("${shown}" is one of them); select each field once`, {
    nodes: [over.node],
    extensions: { code: "complexity_limit_exceeded", status: 400, field: shown, maxRepeatedFields: max },
  });
}

// --- the rules --------------------------------------------------------------------------------------------------------

function limitError(message: string, node: OperationDefinitionNode | FieldNode, code: string, extra: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(message, { nodes: [node], extensions: { code, status: 400, ...extra } });
}

/**
 * The validation rules of the endpoint's limits for one request (`variables` are the request's, for the page sizes the
 * complexity reads): depth, complexity and, where it is off, introspection.
 */
export function limitRules(settings: LimitSettings, variables: Variables): ValidationRule[] {
  const limits = (context: ValidationContext): ASTVisitor => ({
    Document(document) {
      const fragments = new Map<string, FragmentDefinitionNode>();
      for (const definition of document.definitions) if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
      const schema = context.getSchema();
      for (const definition of document.definitions) {
        if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
        const depth = operationDepth(definition, fragments);
        if (depth > settings.maxDepth) {
          context.reportError(limitError(`The query is ${depth} levels deep; the limit is ${settings.maxDepth}`, definition, "depth_limit_exceeded", { depth, maxDepth: settings.maxDepth }));
        }
        const complexity = operationCost(definition, fragments, schema, variables);
        if (complexity > settings.maxComplexity) {
          context.reportError(
            limitError(`The query costs ${complexity}; the limit is ${settings.maxComplexity}`, definition, "complexity_limit_exceeded", { complexity, maxComplexity: settings.maxComplexity }),
          );
        }
      }
    },
  });
  const noIntrospection = (context: ValidationContext): ASTVisitor => ({
    Field(node) {
      if (isIntrospectionField(node.name.value)) {
        context.reportError(limitError("Introspection is disabled on this endpoint; the schema is published as part of the API contract", node, "introspection_disabled"));
      }
    },
  });
  return settings.introspection ? [limits] : [limits, noIntrospection];
}
