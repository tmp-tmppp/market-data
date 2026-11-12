import { DomainError } from "./errors.js";

// Tenants as market-data sees them: an id from the token or from an event envelope, and the database schema that holds
// the tenant's tables (DM-01: one schema per tenant).

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What tenantSchemaName produces; the shared registry table checks the same pattern. */
export const TENANT_SCHEMA_PATTERN = /^tenant_[0-9a-f]{32}$/;

/** A tenant id is a UUID, as the tenants service issues and validates it. */
export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Returns the tenant id in lower case, or throws a DomainError that names the field. */
export function parseTenantId(value: unknown, field = "tenantId"): string {
  if (!isTenantId(value)) throw new DomainError("invalid_tenant_id", `${field} must be a UUID`, field);
  return value.toLowerCase();
}

/**
 * The schema of a tenant: "tenant_" and the 32 hex digits of its id, the same rule as payments, markets and trading,
 * so every service names a tenant's schema the same way. The only code in market-data that turns a tenant id into a
 * schema name.
 */
export function tenantSchemaName(tenantId: string): string {
  return `tenant_${parseTenantId(tenantId).replaceAll("-", "")}`;
}

/**
 * The schema name as a quoted SQL identifier, for the queries of the PostgreSQL adapter. Safe to put into SQL text:
 * it holds only "tenant_" and hex digits, and it never comes from request input.
 */
export function tenantSchemaIdentifier(tenantId: string): string {
  return `"${tenantSchemaName(tenantId)}"`;
}

// The consumed event TenantCreated of the tenants service (contracts/asyncapi.yaml, channel tenantCreated).

export const TENANT_CREATED_TYPE = "si.chance.tenants.TenantCreated.v1";

/** What market-data takes from a TenantCreated event; every other field is ignored. */
export interface TenantCreatedNotice {
  /** The CloudEvent id: the deduplication key of the inbox. */
  eventId: string;
  eventType: string;
  /** From the "tenantid" extension attribute, in lower case. */
  tenantId: string;
  /** From the "correlationid" extension attribute; null when the event has none. */
  correlationId: string | null;
}

export type ConsumedTenantEvent =
  | { kind: "tenant_created"; notice: TenantCreatedNotice }
  /** Not an event market-data acts on, or a malformed one: the consumer logs a warning and acknowledges it. */
  | { kind: "ignored"; reason: string; eventId: string | null };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads a parsed message body of the TENANTS stream. Unknown fields are ignored; a breaking change would arrive as a new
 * type and is ignored as well. The tenant comes from "tenantid", never from the data alone; a data.tenantId that
 * disagrees with it makes the event malformed.
 */
export function readTenantCreated(body: unknown): ConsumedTenantEvent {
  if (!isObject(body)) return { kind: "ignored", reason: "The message is not a JSON object", eventId: null };
  const eventId = typeof body["id"] === "string" && UUID_PATTERN.test(body["id"]) ? body["id"].toLowerCase() : null;
  if (body["specversion"] !== "1.0") return { kind: "ignored", reason: "The message is not a CloudEvent 1.0", eventId };
  if (body["type"] !== TENANT_CREATED_TYPE) return { kind: "ignored", reason: `Unknown event type ${String(body["type"])}`, eventId };
  if (eventId === null) return { kind: "ignored", reason: "The event id is missing or not a UUID", eventId: null };
  if (!isTenantId(body["tenantid"])) return { kind: "ignored", reason: "The tenantid attribute is missing or not a UUID", eventId };
  const tenantId = body["tenantid"].toLowerCase();
  const data = body["data"];
  const dataTenant = isObject(data) ? data["tenantId"] : undefined;
  if (dataTenant !== undefined && (typeof dataTenant !== "string" || dataTenant.toLowerCase() !== tenantId)) {
    return { kind: "ignored", reason: "data.tenantId differs from the tenantid attribute", eventId };
  }
  const correlationId = typeof body["correlationid"] === "string" && body["correlationid"] !== "" ? body["correlationid"] : null;
  return { kind: "tenant_created", notice: { eventId, eventType: TENANT_CREATED_TYPE, tenantId, correlationId } };
}
