import { STATUS_CODES } from "node:http";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UseCaseError, Unavailable } from "../usecases/errors.js";
import type { FieldError, UseCaseErrorKind } from "../usecases/errors.js";

// RFC 9457 problem details (GP-6.14). Use-case errors are mapped to HTTP here and nowhere else (GP-6.28).
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** The API paths: what the gateway routes and what carries tenant data. The health probes are outside it. */
const API_PATH = /^\/v1(?:[/?]|$)/;

/**
 * INF-02: no cache, shared or private, keeps an answer that holds a tenant's data. Every /v1/ answer carries it,
 * problem details and the 404 of an unknown path included; the health probes carry none.
 */
export function noStoreForApi(request: FastifyRequest, reply: FastifyReply): void {
  if (API_PATH.test(request.url)) reply.header("cache-control", "private, no-store");
}

/** An error that is already an HTTP answer: authentication, authorization, a missing route. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The members every problem has; an extension member of the same name is never copied over them. */
const STANDARD_MEMBERS = ["type", "title", "status", "detail", "instance", "code", "errors"] as const;

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  errors?: FieldError[];
  /** Extension members (RFC 9457 section 3.2) such as lastTradeSequence or maxPoints, copied from the error's details. */
  [extension: string]: unknown;
}

// No 422: market-data has no rule that is valid in form and refused by its state (it only reads).
const STATUS_BY_KIND: Record<UseCaseErrorKind, number> = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
};

/** Dates become ISO 8601 text, so a problem's extension member reads like the same field of a normal answer. */
function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, jsonSafe(member)]));
  }
  return value;
}

export function extensionMembers(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const members: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(details)) {
    if (!(STANDARD_MEMBERS as readonly string[]).includes(name)) members[name] = jsonSafe(value);
  }
  return members;
}

function problem(
  request: FastifyRequest,
  status: number,
  code: string,
  detail: string,
  errors?: FieldError[],
  details: Readonly<Record<string, unknown>> = {},
): Problem {
  return {
    ...extensionMembers(details),
    type: `urn:chance:problem:${code.replaceAll("_", "-")}`,
    title: STATUS_CODES[status] ?? "Error",
    status,
    detail,
    instance: request.url.split("?")[0] ?? request.url,
    code,
    ...(errors ? { errors } : {}),
  };
}

function send(reply: FastifyReply, body: Problem, headers: Record<string, string> = {}): FastifyReply {
  return reply.code(body.status).headers(headers).type(PROBLEM_CONTENT_TYPE).send(body);
}

/** Field errors of a failed JSON schema validation, named by the field the caller sent. */
export function validationErrors(error: FastifyError): FieldError[] {
  return (error.validation ?? []).map((issue) => {
    const params = issue.params as { missingProperty?: string; additionalProperty?: string };
    const path = issue.instancePath.replace(/^\//, "").replaceAll("/", ".");
    const field = [path, params.missingProperty ?? params.additionalProperty].filter(Boolean).join(".");
    return { field: field || error.validationContext || "request", message: issue.message ?? "is invalid" };
  });
}

/**
 * Errors that Fastify raises before a route matches (a path parameter over the limit, a malformed URL) are problem
 * details as well, with a fixed text: the message of Fastify repeats the whole URL.
 */
export function frameworkErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  // The onSend hook of the application does not run for these answers, so the header is set here.
  noStoreForApi(request, reply);
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  if (status === 414) {
    send(reply, problem(request, 414, "uri_too_long", "A path parameter is too long"));
  } else if (status >= 400 && status < 500) {
    send(reply, problem(request, status, "bad_request", "The request URL is invalid"));
  } else {
    send(reply, problem(request, 500, "internal_error", "The service failed to handle the request"));
  }
  // These answers bypass the hooks of the application, so the metrics are told here (src/adapters/metrics/metrics.ts).
  request.server.recordFrameworkError?.(request, reply);
}

/**
 * What an error means to a caller, whatever the transport: the one place that maps an error to a status and a stable
 * code. The REST routes render it as a problem (below), the GraphQL endpoint as a GraphQL error with the same `code`
 * (src/web/graphql), so the two APIs cannot drift apart.
 */
export interface ErrorDescription {
  status: number;
  /** The stable machine-readable code, for example `not_found` or `tenant_not_ready`. */
  code: string;
  detail: string;
  /** Field errors of a validation failure. */
  errors?: FieldError[];
  /** Extension members of the use case error (lastTradeSequence, maxPoints), not yet filtered; see extensionMembers. */
  details: Readonly<Record<string, unknown>>;
  /** Response headers of a REST answer: Retry-After, WWW-Authenticate. */
  headers: Record<string, string>;
  /** True for an error nobody expected: the caller gets a fixed text and the service logs the error. */
  unexpected: boolean;
}

export function describeError(error: FastifyError | HttpError | UseCaseError): ErrorDescription {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, detail: error.message, details: {}, headers: error.headers, unexpected: false };
  }
  if (error instanceof UseCaseError) {
    return {
      status: STATUS_BY_KIND[error.kind],
      code: error.code,
      detail: error.message,
      ...(error.fields.length ? { errors: [...error.fields] } : {}),
      details: error.details,
      // A 503 always says when to come back (plan section 9): the tenant is being set up, the history is paused.
      headers: error instanceof Unavailable ? { "retry-after": String(error.retryAfterSeconds) } : {},
      unexpected: false,
    };
  }
  if ("validation" in error && error.validation) {
    const errors = validationErrors(error);
    const detail = `The request is invalid: ${errors.map((issue) => `${issue.field} ${issue.message}`).join("; ")}`;
    return { status: 400, code: "validation_failed", detail, errors, details: {}, headers: {}, unexpected: false };
  }
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  if (status >= 400 && status < 500) {
    return { status, code: "bad_request", detail: error.message, details: {}, headers: {}, unexpected: false };
  }
  return { status: 500, code: "internal_error", detail: "The service failed to handle the request", details: {}, headers: {}, unexpected: true };
}

/** The answer for a path or method no route has, a problem like every other API answer. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return send(reply, problem(request, 404, "not_found", "No such resource"));
}

export function registerProblemHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler(notFoundHandler);

  app.setErrorHandler((error: FastifyError | HttpError | UseCaseError, request, reply) => {
    const described = describeError(error);
    if (described.unexpected) request.log.error({ err: error }, "Unhandled error");
    return send(reply, problem(request, described.status, described.code, described.detail, described.errors, described.details), described.headers);
  });
}
