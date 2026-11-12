import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JWK, JWTVerifyGetKey } from "jose";

export const ISSUER = "http://localhost:8081/realms/test";
export const AUDIENCE = "chance-test";
/** The key id in the header of every token the test keys sign, and in the key set they publish. */
export const KEY_ID = "test-key";

/** The groups of an organization that carry a tenant role (token contract v2): the path of a top-level group. */
export const TENANT_ADMIN_GROUP = "/tenant-admin";
export const TRADER_GROUP = "/trader";

/**
 * The `organization` claim of contract v2 as Keycloak sends it: an object keyed by the organization alias, whose entry
 * holds the organization's id and the caller's groups in it. `memberships` maps an alias to its groups.
 */
export function organizationClaim(memberships: Record<string, string[]>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(memberships).map(([alias, groups]) => [alias, { id: `org-${alias}`, groups }]));
}

export interface TokenOptions {
  sub?: string;
  /**
   * Realm roles (realm_access.roles); default none. The services read only `platform-admin` from here: since contract
   * v2 the tenant role is a group of the organization (see `memberships`), and a realm role `trader` or `tenant-admin`
   * is the old shape that must be refused.
   */
  roles?: string[];
  /**
   * Organization memberships in contract v2: alias to the groups of that organization, for example
   * `{ [tenant]: [TRADER_GROUP] }`. Several aliases build a token of several organizations. Not with `organization`.
   */
  memberships?: Record<string, string[]>;
  /** A raw organization claim, for the odd shapes: an array of aliases, a string, an object keyed by alias. */
  organization?: string[] | Record<string, unknown> | string | null;
  issuer?: string;
  audience?: string;
  /** Seconds from now; negative = already expired. Default 300. */
  expiresIn?: number;
  /** Leave the exp claim out altogether (expiresIn is then ignored). */
  noExpiry?: boolean;
  /** The "kid" in the token header. Default KEY_ID. */
  kid?: string;
}

/** A local RSA key pair: tokens are really signed and really verified, only the JWKS fetch is replaced. */
export async function createTestKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const getKey: JWTVerifyGetKey = () => Promise.resolve(publicKey);
  /** The key set the identity provider would publish at its JWKS URL. */
  const jwks = async (): Promise<{ keys: JWK[] }> => ({ keys: [{ ...(await exportJWK(publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" }] });

  async function sign(options: TokenOptions = {}, key = privateKey): Promise<string> {
    const claims: Record<string, unknown> = { realm_access: { roles: options.roles ?? [] } };
    if (options.memberships !== undefined && options.organization !== undefined) {
      throw new Error("A test token takes either memberships or a raw organization claim, not both");
    }
    if (options.memberships !== undefined) claims["organization"] = organizationClaim(options.memberships);
    else if (options.organization !== undefined && options.organization !== null) claims["organization"] = options.organization;
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: options.kid ?? KEY_ID })
      .setSubject(options.sub ?? "user-1")
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt();
    if (!options.noExpiry) jwt.setExpirationTime(Math.floor(Date.now() / 1000) + (options.expiresIn ?? 300));
    return jwt.sign(key);
  }

  /** A token signed with a key the service does not trust. */
  const signWithOtherKey = (options: TokenOptions = {}) => sign(options, other.privateKey);

  return { getKey, jwks, sign, signWithOtherKey };
}
