import type { SourceLocation } from "graphql";
import type { FastifyBaseLogger, FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { UseCaseError } from "../../usecases/errors.js";
import { describeError, extensionMembers, notFoundHandler } from "../problems.js";
import type { ErrorDescription, HttpError } from "../problems.js";
import { GraphQLError } from "./graphql-js.js";

// How every failure of the GraphQL endpoint is told to the caller. The rule: one error shape, a GraphQL error
// `{ message, locations?, path?, extensions: { code, status, ... } }`, never problem+json, and the `code` of the REST
// problem for the same condition (src/web/problems.ts `describeError` is the one place that decides it).
//
// extensions.code    stable: the REST codes (`validation_failed`, `forbidden`, `not_found`, `updating`, `history_paused`,
//                    `tenant_not_ready`, `unauthorized`, `identity_provider_unavailable`, `bad_request`, `internal_error`)
//                    and the codes of this endpoint: `graphql_syntax_error`, `graphql_validation_failed` (a variable of the
//                    wrong type too), `depth_limit_exceeded`, `complexity_limit_exceeded` (the repeated fields too),
//                    `introspection_disabled`, `method_not_allowed`.
// extensions.status  the HTTP status the REST API gives for the same condition (informational for a field error: the
//                    answer to a query that ran is 200, with the failed field null).
// extensions.fields  the field errors of a validation failure, named by the argument the caller sent.
// extensions.retryAfterSeconds, and members such as lastTradeSequence and maxPoints, as in the REST problem.

export interface FormattedError {
  message: string;
  locations?: readonly SourceLocation[];
  path?: ReadonlyArray<string | number>;
  extensions: Record<string, unknown>;
}

/** The extensions of an error: the members of the use case error first, so none of them can replace the standard ones. */
export function extensionsOf(described: ErrorDescription): Record<string, unknown> {
  const retryAfter = described.headers["retry-after"];
  return {
    ...extensionMembers(described.details),
    code: described.code,
    status: described.status,
    ...(described.errors ? { fields: described.errors } : {}),
    ...(retryAfter === undefined ? {} : { retryAfterSeconds: Number(retryAfter) }),
  };
}

const errorBody = (error: FormattedError) => ({ errors: [error] });

/** An error of the transport, before or around a query: the same shape as a field error. */
export function transportError(described: ErrorDescription): { errors: FormattedError[] } {
  return errorBody({ message: described.detail, extensions: extensionsOf(described) });
}

/** The suggestion graphql adds to an unknown name: `Did you mean "markets"?`. */
const SUGGESTION = /\s*Did you mean .*\?$/s;

/**
 * Where a chain of `originalError`s ends. graphql wraps the refusal of a variable (`Variable "$n" got invalid value ...`)
 * around the error of the scalar or the enum, which is itself an error of graphql: such a chain ends in a GraphQLError and
 * is the caller's mistake. One that ends in anything else (a scalar that threw a TypeError, a resolver's own error) is a bug.
 */
function causeOf(error: GraphQLError): unknown {
  let cause: unknown = error;
  for (let step = 0; step < 16 && cause instanceof GraphQLError && cause.originalError !== undefined && cause.originalError !== null; step++) cause = cause.originalError;
  return cause;
}

/**
 * One error of a query as the caller sees it. A resolver error that nobody expected is logged and not shown. With
 * `hideSuggestions` (introspection is off) the "Did you mean ..." of a query error is cut, so the error texts do not hand
 * out the names of a schema that is not introspectable.
 */
export function formatGraphqlError(error: GraphQLError, log: FastifyBaseLogger, hideSuggestions = false): FormattedError {
  const where = { ...(error.locations ? { locations: error.locations } : {}), ...(error.path ? { path: error.path } : {}) };
  const original = error.originalError;
  if (original instanceof UseCaseError) {
    return { message: original.message, ...where, extensions: extensionsOf(describeError(original)) };
  }
  const code = error.extensions["code"];
  if (typeof code === "string") {
    // A rule of this endpoint (limits, introspection) or a scalar that refused a value.
    return { message: error.message, ...where, extensions: { status: 400, ...error.extensions } };
  }
  const cause = causeOf(error);
  if (error.path !== undefined || (original !== undefined && original !== null && !(cause instanceof GraphQLError))) {
    // A resolver that threw something unexpected, a value a scalar cannot represent, a null in a non-null field: a bug or
    // corrupt data, never the caller's fault.
    log.error({ err: cause, path: error.path }, "A GraphQL resolver failed");
    return { message: "The service failed to handle the request", ...where, extensions: { code: "internal_error", status: 500 } };
  }
  // The rest is a query that does not fit the schema: a field that does not exist, a missing argument, a value of the
  // wrong type (a variable of the wrong type arrives as an error of graphql around the error of the scalar or the enum),
  // an operation that cannot be chosen.
  return { message: hideSuggestions ? error.message.replace(SUGGESTION, "") : error.message, ...where, extensions: { code: "graphql_validation_failed", status: 400 } };
}

/** The errors an `app.graphql()` call throws for a query that cannot run (mercurius: `errors` on the thrown error), or null. */
export function requestErrorsOf(error: unknown): GraphQLError[] | null {
  const list = typeof error === "object" && error !== null ? (error as { errors?: unknown }).errors : undefined;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.map((item) => (item instanceof GraphQLError ? item : new GraphQLError(item instanceof Error ? item.message : "The query is invalid")));
}

/** A query that does not parse. */
export function syntaxError(error: unknown): FormattedError {
  const where = error instanceof GraphQLError && error.locations ? { locations: error.locations } : {};
  const message = error instanceof Error ? error.message : "The query is not valid GraphQL";
  return { message, ...where, extensions: { code: "graphql_syntax_error", status: 400 } };
}

/**
 * mercurius' error formatter, for a query that ran: field errors with data, or an error without any data (an operation
 * that cannot be chosen, a variable of the wrong type), which is a 400 without `data`. Everything else of a query that ran
 * is a 200, as GraphQL over HTTP has it: the failed field is null and its error says why.
 */
export function createErrorFormatter(hideSuggestions: boolean) {
  return (
    execution: { data?: unknown; errors: readonly GraphQLError[] },
    context: { reply?: FastifyReply; app: { log: FastifyBaseLogger } },
  ): { statusCode: number; response: { data?: Record<string, unknown> | null; errors: FormattedError[] } } => {
    const log = context.reply?.log ?? context.app.log;
    const errors = execution.errors.map((error) => formatGraphqlError(error, log, hideSuggestions));
    // graphql-js answers an operation it cannot start (an unknown or ambiguous operation name, a root type the schema does
    // not have: no mutation, no subscription) with no data or `data: null`, and errors that belong to no field (no path).
    const ran = execution.data != null || execution.errors.some((error) => error.path !== undefined);
    return { statusCode: ran ? 200 : 400, response: { ...(ran ? { data: (execution.data as Record<string, unknown> | null) ?? null } : {}), errors } };
  };
}

/**
 * The error handler of the endpoint's scope: the failures of the hooks and of Fastify around a query (a missing or wrong
 * token 401, a caller without rights 403, keys that cannot be fetched 503, a body that is not JSON or not the right shape
 * 400 or 415, one over the size limit 413) keep the status and the headers they have in the REST API, with the GraphQL
 * error shape.
 */
export function graphqlErrorHandler(error: FastifyError | HttpError | UseCaseError, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const described = describeError(error);
  if (described.unexpected) request.log.error({ err: error }, "Unhandled error");
  return reply.code(described.status).headers(described.headers).send(transportError(described));
}

/** The endpoint answers POST only: any other method is 405, and every other path below it is the same 404 as elsewhere. */
export function graphqlNotFoundHandler(path: string) {
  return (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    if (request.url.split("?")[0] !== path) return notFoundHandler(request, reply);
    const described: ErrorDescription = { status: 405, code: "method_not_allowed", detail: "The GraphQL endpoint accepts POST only", details: {}, headers: { allow: "POST" }, unexpected: false };
    return reply.code(405).header("allow", "POST").send(transportError(described));
  };
}

/**
 * The `extensions.code` of each error in a serialized answer of the GraphQL endpoint, in order. An answer without an
 * `errors` list, or that is not JSON, has none. Reads the text the endpoint is about to send: nothing is parsed unless
 * the text mentions "errors".
 */
export function graphqlErrorCodes(payload: unknown): Array<string | undefined> {
  if (typeof payload !== "string" || !payload.includes('"errors"')) return [];
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return [];
  }
  const errors = typeof body === "object" && body !== null ? (body as { errors?: unknown }).errors : undefined;
  if (!Array.isArray(errors)) return [];
  return errors.map((error: unknown) => {
    const extensions = typeof error === "object" && error !== null ? (error as { extensions?: unknown }).extensions : undefined;
    const code = typeof extensions === "object" && extensions !== null ? (extensions as { code?: unknown }).code : undefined;
    return typeof code === "string" ? code : undefined;
  });
}
