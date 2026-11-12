import { errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isTenantId } from "../domain/tenant.js";
import type { MarketDataRole } from "../usecases/ports.js";
import { HttpError } from "./problems.js";

/** What verifying a bearer token needs. */
export interface BearerOptions {
  issuer: string;
  audience: string;
  /** Resolves the signing key of a token: the identity provider's JWKS in production, a local key in tests. */
  getKey: JWTVerifyGetKey;
}

export interface AuthOptions extends BearerOptions {
  /** Dot path of the realm roles in the token, for example "realm_access.roles". Only `platform-admin` is read from it. */
  rolesClaim: string;
  /**
   * Dot path of the organization claim, for example "organization": an object keyed by the organization alias, whose
   * entry holds the organization's `groups` (token contract v2).
   */
  tenantClaim: string;
}

export interface AuthContext {
  userId: string;
  /** The realm roles of the token. A tenant role is never read from here (token contract v2): see `tenantRole`. */
  realmRoles: readonly string[];
  /** The tenant of the token: the single organization alias, or null when the token has none. */
  tenantId: string | null;
  /** The role in that organization: its one group, `/tenant-admin` or `/trader`. Null when it is anything else. */
  tenantRole: MarketDataRole | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
    correlationId: string;
  }
}

// Only asymmetric algorithms: a token can never be accepted with a shared secret or without a signature.
const ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256", "PS384", "PS512", "EdDSA"];

export function unauthorized(detail: string, challenge: string): HttpError {
  return new HttpError(401, "unauthorized", detail, { "www-authenticate": challenge });
}

/** Seconds a client is told to wait when the signing keys cannot be fetched; the key fetch has its own timeout. */
export const KEYS_RETRY_AFTER_SECONDS = 5;

/** The tokens cannot be checked because the identity provider's signing keys are not available: 503, not 401. */
function keysUnavailable(): HttpError {
  return new HttpError(
    503,
    "identity_provider_unavailable",
    "The signing keys of the identity provider cannot be fetched; try again shortly",
    { "retry-after": String(KEYS_RETRY_AFTER_SECONDS) },
  );
}

/** A failure to fetch the signing keys, as opposed to a token that is wrong. Thrown by the key resolver only. */
class SigningKeysUnavailable extends Error {
  constructor(cause: unknown) {
    super("The signing keys cannot be fetched", { cause });
    this.name = "SigningKeysUnavailable";
  }
}

/**
 * Whether an error of the key resolver means the key set could not be fetched or read: a timeout, a key set that
 * is malformed, a bad HTTP status or body (jose throws its base class JOSEError, with no subclass, only for these
 * two), or anything that is not a jose error at all (a network error is a TypeError). Errors about the token
 * itself (an unknown or ambiguous key id) are JOSEError subclasses and stay 401.
 */
function isKeyFetchFailure(error: unknown): boolean {
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) return true;
  if (!(error instanceof errors.JOSEError)) return true;
  return error.code === errors.JOSEError.code;
}

/** Marks the failures of the key resolver, so that they are told apart from the errors about the token. */
function marked(getKey: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    try {
      return await getKey(protectedHeader, token);
    } catch (error) {
      throw isKeyFetchFailure(error) ? new SigningKeysUnavailable(error) : error;
    }
  };
}

/** The value at a dot path of the token's claims, or undefined. */
export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function rolesOf(payload: JWTPayload, claim: string): string[] {
  const value = readPath(payload, claim);
  return Array.isArray(value) ? value.filter((role): role is string => typeof role === "string") : [];
}

/** The organization claim is an array of aliases or an object keyed by alias. Exactly one tenant is allowed. */
function tenantOf(payload: JWTPayload, claim: string): string | null {
  const value = readPath(payload, claim);
  let aliases: string[] = [];
  if (typeof value === "string") aliases = [value];
  else if (Array.isArray(value)) aliases = value.filter((alias): alias is string => typeof alias === "string");
  else if (typeof value === "object" && value !== null) aliases = Object.keys(value);
  if (aliases.length > 1) {
    throw unauthorized("The token belongs to more than one organization", 'Bearer error="invalid_token"');
  }
  return aliases[0] ?? null;
}

/** The organization groups that carry a tenant role, as Keycloak writes a top-level group's path. */
const TENANT_ROLE_OF_GROUP: ReadonlyMap<string, MarketDataRole> = new Map<string, MarketDataRole>([
  ["/tenant-admin", "tenant-admin"],
  ["/trader", "trader"],
]);

/**
 * The tenant role of token contract v2: the groups of the token's organization, `organization.<alias>.groups`, must be
 * exactly one entry, `/tenant-admin` or `/trader`. Zero groups, several (also both), an unknown group, a claim that is
 * not an object keyed by alias or an entry without a `groups` array all give null: the caller has no tenant role.
 */
function tenantRoleOf(payload: JWTPayload, claim: string, tenantId: string | null): MarketDataRole | null {
  if (tenantId === null) return null;
  const organization = readPath(payload, claim);
  if (typeof organization !== "object" || organization === null || Array.isArray(organization)) return null;
  const entry = new Map(Object.entries(organization as Record<string, unknown>)).get(tenantId);
  if (typeof entry !== "object" || entry === null) return null;
  const groups = (entry as Record<string, unknown>)["groups"];
  if (!Array.isArray(groups) || groups.length !== 1) return null;
  const [group] = groups as unknown[];
  return typeof group === "string" ? (TENANT_ROLE_OF_GROUP.get(group) ?? null) : null;
}

/**
 * The verification of every token: the Authorization header, the signature, the issuer, the audience and a required
 * `exp` (without it, a token that carries none would never expire). 401 for a token that is wrong, 503 when the signing
 * keys cannot be fetched. Returns the claims of a token that has a subject.
 */
export function bearerVerifier(options: BearerOptions): (request: FastifyRequest) => Promise<JWTPayload> {
  const getKey = marked(options.getKey);
  return async (request) => {
    const header = request.headers.authorization;
    if (!header) throw unauthorized("A bearer token is required", "Bearer");
    const [scheme, token, ...rest] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) {
      throw unauthorized("The Authorization header must be: Bearer <token>", "Bearer");
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ALGORITHMS,
        requiredClaims: ["exp"],
      }));
    } catch (error) {
      if (error instanceof SigningKeysUnavailable) {
        request.log.warn({ err: error.cause }, "The signing keys of the identity provider cannot be fetched");
        throw keysUnavailable();
      }
      request.log.info({ reason: error instanceof Error ? error.name : "unknown" }, "A token was rejected");
      throw unauthorized("The token is not valid", 'Bearer error="invalid_token"');
    }
    if (!payload.sub) throw unauthorized("The token has no subject", 'Bearer error="invalid_token"');
    return payload;
  };
}

/** onRequest hook: verifies the bearer token and puts the caller on the request. */
export function authenticate(options: AuthOptions) {
  const verify = bearerVerifier(options);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const payload = await verify(request);
    const tenantId = tenantOf(payload, options.tenantClaim);
    const auth: AuthContext = {
      userId: payload.sub ?? "",
      realmRoles: rolesOf(payload, options.rolesClaim),
      tenantId,
      tenantRole: tenantRoleOf(payload, options.tenantClaim, tenantId),
    };
    request.auth = auth;
    request.log = reply.log = request.log.child({ userId: auth.userId, tenantId: auth.tenantId });
  };
}

/**
 * The tenant label of the request metrics: the tenant id of the token this service verified, or null. `request.auth` is
 * set only after the token check succeeded, so a request without a valid token is "none"; a header or the body is
 * never read. src/main.ts and the tests use this one function.
 */
export function tenantOfRequest(request: FastifyRequest): string | null {
  return request.auth?.tenantId ?? null;
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized("A bearer token is required", "Bearer");
  return request.auth;
}

export interface Member {
  userId: string;
  /** The tenant of the token, a UUID in lower case. */
  tenantId: string;
  role: MarketDataRole;
}

/**
 * Guard of every public market-data endpoint: the caller is a trader or a tenant admin of the tenant named by the token;
 * both roles read everything here. The role is the one group of that organization (token contract v2); a realm role
 * `trader` or `tenant-admin` counts for nothing. A platform admin (a realm role) sees no tenant's data (403, even when
 * the token also names a tenant), and so does a token without a tenant, with a tenant that is not a UUID, or without
 * exactly one valid group, both groups included. The tenant is always the token's, never the request's.
 */
export function requireMember(request: FastifyRequest): Member {
  const auth = requireAuth(request);
  if (auth.realmRoles.includes("platform-admin")) {
    throw new HttpError(403, "forbidden", "The platform-admin role has no access to a tenant's market data");
  }
  if (auth.tenantId === null || !isTenantId(auth.tenantId)) {
    throw new HttpError(403, "forbidden", "The token does not belong to a tenant");
  }
  if (auth.tenantRole === null) {
    throw new HttpError(403, "forbidden", "The organization must give the caller exactly one group, /trader or /tenant-admin");
  }
  return { userId: auth.userId, tenantId: auth.tenantId.toLowerCase(), role: auth.tenantRole };
}

/** The checks above as async hooks: Fastify waits for the returned promise, and a thrown error becomes the answer. */
export type RequestHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** preValidation hook of the read routes: answers 403 before the query or the path is validated. */
export const memberHook: RequestHook = (request) =>
  Promise.resolve().then(() => {
    requireMember(request);
  });
