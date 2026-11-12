import { INTERVALS } from "../domain/history.js";
import { MARKET_STATUSES } from "../domain/projection.js";
import { OUTCOMES } from "../domain/units.js";

// JSON schemas of the routes: they validate the input and shape the output. They mirror contracts/openapi.yaml, and
// tests/contracts compares the routes with that file. What the domain decides (the market exists, the range is allowed,
// the trade is in the read model) is the use cases' answer.
//
// The query schemas carry no `default`: ajv would fill it in before the route runs, and `ids` together with a defaulted
// `limit` would look like a request that sent both. The use cases apply the defaults.
//
// A response schema also lists what may leave: a field that is not named here is dropped by the serializer.
const uuid = { type: "string", format: "uuid" } as const;
const dateTime = { type: "string", format: "date-time" } as const;
const nullableDateTime = { type: ["string", "null"] } as const;
const integer = { type: "integer" } as const;
const nullableInteger = { type: ["integer", "null"] } as const;
const marketStatus = { type: "string", enum: [...MARKET_STATUSES] } as const;
const nullableOutcome = { type: ["string", "null"], enum: [...OUTCOMES, null] } as const;
const interval = { type: "string", enum: Object.keys(INTERVALS) } as const;

const fieldError = {
  type: "object",
  properties: { field: { type: "string" }, message: { type: "string" } },
} as const;

// A problem carries extension members (lastTradeSequence, maxPoints): any member may be added to the fixed ones.
export const problemSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: integer,
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
    errors: { type: "array", items: fieldError },
  },
} as const;

const errorResponses = { "4xx": problemSchema, "5xx": problemSchema } as const;

const market = {
  type: "object",
  properties: {
    marketId: uuid,
    question: { type: "string" },
    status: marketStatus,
    closeTime: dateTime,
    openedAt: dateTime,
    closedAt: nullableDateTime,
    resolvedAt: nullableDateTime,
    outcome: nullableOutcome,
    startingPriceYesMicro: integer,
    lastPriceYesMicro: nullableInteger,
    currentPriceYesMicro: integer,
    volumeMicro: integer,
    tradeCount: integer,
    lastTradeSequence: integer,
    lastTradeAt: nullableDateTime,
    version: integer,
    updatedAt: dateTime,
  },
} as const;

const bucket = {
  type: "object",
  properties: {
    start: dateTime,
    openYesMicro: integer,
    highYesMicro: integer,
    lowYesMicro: integer,
    closeYesMicro: integer,
    volumeMicro: integer,
    trades: integer,
  },
} as const;

const marketIdParams = {
  type: "object",
  required: ["marketId"],
  properties: { marketId: uuid },
} as const;

const cursor = { type: "string", minLength: 1, maxLength: 200 } as const;
const afterSequence = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;

export const schemas = {
  listMarkets: {
    querystring: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: marketStatus,
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor,
        ids: { type: "string", minLength: 36, maxLength: 3800 },
      },
    },
    response: {
      200: { type: "object", properties: { items: { type: "array", items: market }, nextCursor: { type: ["string", "null"] } } },
      ...errorResponses,
    },
  },
  getMarket: {
    params: marketIdParams,
    querystring: { type: "object", additionalProperties: false, properties: { afterSequence } },
    response: { 200: market, ...errorResponses },
  },
  getHistory: {
    params: marketIdParams,
    querystring: {
      type: "object",
      additionalProperties: false,
      properties: {
        interval,
        from: dateTime,
        to: dateTime,
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor,
        afterSequence,
      },
    },
    response: {
      200: {
        type: "object",
        properties: {
          marketId: uuid,
          interval,
          from: dateTime,
          to: dateTime,
          previousCloseYesMicro: nullableInteger,
          buckets: { type: "array", items: bucket },
          nextCursor: { type: ["string", "null"] },
        },
      },
      ...errorResponses,
    },
  },
  health: {
    response: {
      200: { type: "object", properties: { status: { type: "string" } } },
      ...errorResponses,
    },
  },
  // One CloudEvent: its shape is read by the same reader the consumers use, so the schema only asks for an object.
  localEvent: {
    body: { type: "object" },
    response: { 200: { type: "object", properties: { result: { type: "string" } } }, ...errorResponses },
  },
} as const;
