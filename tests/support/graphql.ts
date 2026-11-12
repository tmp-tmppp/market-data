import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import { TENANT_A } from "./fakes.js";
import { TRADER_GROUP } from "./tokens.js";
import type { TokenOptions } from "./tokens.js";

export const GRAPHQL = "/v1/market-data/graphql";

/** Both harnesses (the fake use cases and the real ones) offer these two. */
export interface AppHarness {
  app: FastifyInstance;
  sign(token?: TokenOptions): Promise<string>;
}

export interface GqlAnswer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: { data?: Record<string, any> | null; errors?: Array<Record<string, any>> } | null;
  /** The answer's text, for the checks of what must not appear in it. */
  text: string;
}

export interface GqlOptions {
  variables?: Record<string, unknown>;
  operationName?: string;
  /** Claims of the bearer token; null sends no Authorization header. Default: a trader of TENANT_A. */
  token?: TokenOptions | null;
  headers?: Record<string, string>;
}

const TRADER: TokenOptions = { sub: "trader-1", memberships: { [TENANT_A]: [TRADER_GROUP] } };

/** One request through the application as a client sends it; `payload` is sent as it is (a string is not touched). */
export async function send(h: AppHarness, method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", url: string, payload: unknown, options: { token?: TokenOptions | null; headers?: Record<string, string> } = {}): Promise<GqlAnswer> {
  const auth = options.token === null ? {} : { authorization: `Bearer ${await h.sign(options.token ?? TRADER)}` };
  const response = await h.app.inject({
    method,
    url,
    headers: { ...auth, ...options.headers },
    ...(payload === undefined ? {} : { payload: payload as string | object }),
  });
  return { status: response.statusCode, headers: response.headers, body: response.body ? (JSON.parse(response.body) as GqlAnswer["body"]) : null, text: response.body };
}

/** A GraphQL query as the JSON body of a POST. */
export function gql(h: AppHarness, query: string, options: GqlOptions = {}): Promise<GqlAnswer> {
  const { variables, operationName, ...rest } = options;
  return send(h, "POST", GRAPHQL, { query, ...(variables === undefined ? {} : { variables }), ...(operationName === undefined ? {} : { operationName }) }, rest);
}

/** The error codes of an answer, in order. */
export const codesOf = (answer: GqlAnswer): unknown[] => (answer.body?.errors ?? []).map((error) => error["extensions"]?.["code"]);
