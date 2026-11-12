import { createRequire } from "node:module";
import type * as GraphqlTypes from "graphql";

// graphql ships two builds, an ES module and a CommonJS one, and mercurius (a CommonJS package) loads the CommonJS build.
// An import of "graphql" from this ES module package would load the other build, and the two do not recognise each other's
// objects: `isObjectType(schema type)` and `error instanceof GraphQLError` are false across them, and graphql refuses
// the mix with "Cannot use GraphQLObjectType from another module or realm". So every runtime value of graphql that this
// endpoint uses comes from here, from the build mercurius uses. Types need no such care.
const nodeRequire = createRequire(import.meta.url);
const graphql = nodeRequire("graphql") as typeof GraphqlTypes;

export const GraphQLError = graphql.GraphQLError;
export type GraphQLError = InstanceType<typeof graphql.GraphQLError>;
// buildSchema is for the tests of the limits, which need a schema of this build.
export const { Kind, OperationTypeNode, buildSchema, getNamedType, isInterfaceType, isObjectType, parse } = graphql;
