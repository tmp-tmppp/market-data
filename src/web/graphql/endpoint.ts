import { readFileSync } from "node:fs";
import type { DocumentNode } from "graphql";
import mercurius from "mercurius";
import type { MercuriusOptions } from "mercurius";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { GraphqlSettings } from "../../config.js";
import type { MarketDataUseCases } from "../../usecases/use-cases.js";
import { memberHook } from "../auth.js";
import type { RequestHook } from "../auth.js";
import { actorOf } from "../context.js";
import { createErrorFormatter, formatGraphqlError, graphqlErrorCodes, graphqlErrorHandler, graphqlNotFoundHandler, requestErrorsOf, syntaxError } from "./errors.js";
import { parse } from "./graphql-js.js";
import { limitRules, repeatedFieldError } from "./limits.js";
import { createResolvers } from "./resolvers.js";
import type { GraphqlContext } from "./resolvers.js";

/** The one path of the GraphQL endpoint, below the gateway's prefix `/v1/market-data` (so the gateway routes it as it is). */
export const GRAPHQL_PATH = "/v1/market-data/graphql";

/** The contract. The build copies nothing: the file is read from `contracts/` next to `src/` or `dist/` (the image carries it). */
export const SCHEMA_FILE = new URL("../../../contracts/graphql/schema.graphql", import.meta.url);

export function readSchemaFile(file: URL = SCHEMA_FILE): string {
  return readFileSync(file, "utf8");
}

// mercurius is an async Fastify plugin (it awaits its cache) that its type declaration shows as returning void.
const mercuriusPlugin = mercurius as unknown as FastifyPluginAsync<MercuriusOptions>;

/** A query longer than this is refused before it is parsed; the body limit of the application (16 KiB) is the outer bound. */
const MAX_QUERY_LENGTH = 10_000;
/** The parser stops at this many tokens (the standard introspection query has about 1 000). */
const MAX_TOKENS = 2_000;
/** The validation stops reporting at this many errors. */
const MAX_VALIDATION_ERRORS = 10;

const requestBody = {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH },
    variables: { type: ["object", "null"] },
    operationName: { type: ["string", "null"], maxLength: 200 },
    // Accepted and ignored, as clients send it for their own purposes (persisted queries are not supported).
    extensions: { type: ["object", "null"] },
  },
} as const;

interface RequestBody {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

/**
 * The GraphQL query endpoint (REQ-17, ADR-023): `POST /v1/market-data/graphql`, mercurius as the engine over the schema of
 * contracts/graphql/schema.graphql, and nothing of its own HTTP layer (`routes: false`): the route below is ours, so the
 * endpoint is POST only (a GET, which a page of another site could trigger, is 405 and never runs a query), has the
 * token checks of the REST routes before the body is read, and never answers with GraphiQL, a persisted-query lookup or a
 * batch (the body must be one object).
 *
 * The queries call the same use cases as the REST routes (resolvers.ts), the tenant and the role come from the token only
 * (actorOf, the same member check as the REST preValidation hook), and every failure has the one error shape of errors.ts
 * with the code of the REST problem. The answer carries `Cache-Control: private, no-store` and `X-Correlation-Id` like every
 * `/v1/` answer (hooks of the application).
 */
export function registerGraphqlEndpoint(
  app: FastifyInstance,
  useCases: MarketDataUseCases,
  authenticate: RequestHook,
  settings: GraphqlSettings,
  onErrors?: (codes: ReadonlyArray<string | undefined>) => void,
): void {
  // Read here, not in the plugin, so a missing file stops buildApp at once.
  const schema = readSchemaFile();

  void app.register(
    async (scope) => {
      await scope.register(mercuriusPlugin, {
        schema,
        resolvers: createResolvers(useCases),
        routes: false,
        graphiql: false,
        ide: false,
        subscription: false,
        // Complexity depends on the variables of the request, so a parsed query cannot be cached by its text.
        cache: false,
        graphql: { validateOptions: { maxErrors: MAX_VALIDATION_ERRORS } },
        validationRules: ({ variables }) => limitRules(settings, variables),
        errorFormatter: createErrorFormatter(!settings.introspection),
      });
      scope.setErrorHandler(graphqlErrorHandler);
      scope.setNotFoundHandler(graphqlNotFoundHandler(GRAPHQL_PATH));
      // The errors of every answer in the GraphQL error shape (a field error, a refused query, a failed hook, the 405),
      // counted by code in one place, without the operation name. A problem+json answer (an unknown path) is not one.
      if (onErrors) {
        scope.addHook("onSend", (_request, reply, payload, done) => {
          if (String(reply.getHeader("content-type") ?? "").startsWith("application/json")) {
            const codes = graphqlErrorCodes(payload);
            if (codes.length > 0) onErrors(codes);
          }
          done(null, payload);
        });
      }

      scope.post<{ Body: RequestBody }>(
        "/",
        // Authentication first (401, 503), then the role (403): both before the body is read, so a caller without rights
        // learns nothing from a validation error and costs no parsing.
        { schema: { body: requestBody }, onRequest: [authenticate, memberHook], prefixTrailingSlash: "no-slash" },
        async (request, reply) => {
          const { query, variables, operationName } = request.body;
          let document: DocumentNode;
          try {
            document = parse(query, { maxTokens: MAX_TOKENS });
          } catch (error) {
            return reply.code(400).send({ errors: [syntaxError(error)] });
          }
          // Before graphql validates: the pairs it compares for a field repeated under one name are work the other limits
          // (checked in the same pass as the specified rules) cannot stop.
          const repeated = repeatedFieldError(document);
          if (repeated !== null) return reply.code(400).send({ errors: [formatGraphqlError(repeated, request.log, !settings.introspection)] });
          const context: GraphqlContext = { actor: actorOf(request), reply };
          try {
            return await scope.graphql(document, context, variables ?? undefined, operationName ?? undefined);
          } catch (error) {
            // A query that cannot run: it does not fit the schema, a variable has the wrong type, a limit is exceeded.
            const errors = requestErrorsOf(error);
            if (errors === null) throw error;
            return reply.code(400).send({ errors: errors.map((item) => formatGraphqlError(item, request.log, !settings.introspection)) });
          }
        },
      );
    },
    { prefix: GRAPHQL_PATH },
  );
}
