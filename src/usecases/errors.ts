import { DomainError } from "../domain/errors.js";

// Transport-agnostic errors of the use cases. Only src/web maps them to HTTP status codes (GP-6.28): validation 400,
// forbidden 403, not_found 404, conflict 409, unavailable 503 with Retry-After. The problem type of an answer is
// urn:chance:problem:<code with dashes>, for example ...:history-paused; `details` become extension members of the
// problem (RFC 9457), for example {"lastTradeSequence": 41} of updating.
export type UseCaseErrorKind = "validation" | "forbidden" | "not_found" | "conflict" | "unavailable";

export interface FieldError {
  field: string;
  message: string;
}

export class UseCaseError extends Error {
  constructor(
    readonly kind: UseCaseErrorKind,
    /** Stable machine-readable code, for example "tenant_not_ready". */
    readonly code: string,
    message: string,
    readonly fields: readonly FieldError[] = [],
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationFailed extends UseCaseError {
  constructor(fields: readonly FieldError[], message = "The request is invalid", code = "validation_failed", details: Readonly<Record<string, unknown>> = {}) {
    super("validation", code, message, fields, details);
  }
}

/** The caller's role does not allow the action. */
export class Forbidden extends UseCaseError {
  constructor(message: string) {
    super("forbidden", "forbidden", message);
  }
}

/** No such market in the caller's tenant (another tenant's market, or one whose MarketOpened has not arrived yet). */
export class NotFound extends UseCaseError {
  constructor(message = "No such market") {
    super("not_found", "not_found", message);
  }
}

export class Conflict extends UseCaseError {
  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("conflict", code, message, [], details);
  }
}

/**
 * DM-17 read-your-writes: the request named `afterSequence` (the trade sequence of the caller's order answer) and that
 * trade is not in the read model yet. The client asks again for up to about 2 s (DM-13), then shows "updating".
 */
export class Updating extends Conflict {
  constructor(lastTradeSequence: number) {
    super("updating", "The market data does not include that trade yet; ask again shortly", { lastTradeSequence });
  }
}

/** Worth retrying after `retryAfterSeconds` (HTTP 503 with Retry-After). */
export class Unavailable extends UseCaseError {
  constructor(
    code: string,
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super("unavailable", code, message);
  }
}

/** Seconds a client waits when its tenant's schema does not exist yet. */
export const TENANT_NOT_READY_RETRY_AFTER_SECONDS = 5;

/** The tenant's TenantCreated event has not been processed yet, so it has no schema (plan section 9). */
export class TenantNotReady extends Unavailable {
  constructor(retryAfterSeconds = TENANT_NOT_READY_RETRY_AFTER_SECONDS) {
    super("tenant_not_ready", "The tenant is being set up in this service; try again shortly", retryAfterSeconds);
  }
}

/** The runtime setting HISTORY_ENABLED=false pauses the history endpoint (ADR-037). */
export class HistoryPaused extends Unavailable {
  constructor(retryAfterSeconds = 30) {
    super("history_paused", "Price history is paused; try again later", retryAfterSeconds);
  }
}

/** Turns a rule violation of the domain into the use-case error a caller can act on. */
export function fromDomainError(error: DomainError): Error {
  const field = error.field ?? "request";
  switch (error.code) {
    case "invalid_market_id":
    case "invalid_tenant_id":
    case "invalid_price":
    case "invalid_interval":
    case "invalid_sequence":
      return new ValidationFailed([{ field, message: error.message }]);
    case "invalid_range":
      return new ValidationFailed([{ field, message: error.message }], error.message, "validation_failed", error.details ?? {});
    case "amount_out_of_range":
    case "invariant_violated":
      // A bug or corrupt data, never the caller's fault: an internal error (500), logged with the stack.
      return new Error(`${error.code}: ${error.message}`, { cause: error });
  }
}

/** Runs domain code and reports its rule violations as use-case errors. */
export function guardDomain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DomainError) throw fromDomainError(error);
    throw error;
  }
}
