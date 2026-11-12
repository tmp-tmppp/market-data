import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import type { ValueNode } from "graphql";
import { GraphQLError, Kind } from "./graphql-js.js";

// The two custom scalars of contracts/graphql/schema.graphql. A value they refuse is `validation_failed` (status 400),
// the code the REST API gives for an invalid query parameter.

function invalid(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "validation_failed", status: 400 } });
}

// The same date-time check as the REST routes (ajv-formats, "full" mode), so both APIs accept exactly the same text.
const ajv = new Ajv();
addFormats.default(ajv);
const isDateTimeText = ajv.compile({ type: "string", format: "date-time" });

const DATE_TIME_HINT = "DateTime must be an RFC 3339 date-time such as 2026-11-11T12:00:00Z";

/**
 * An instant. Output is `toISOString()`, as every date of the REST API. Input is any RFC 3339 date-time; like the REST
 * routes it passes a text that the format accepts but that is no real instant (a leap second, 23:59:60) on as an Invalid
 * Date, which the history use case answers with `validation_failed` on that argument (`checkDate`, MDA-06).
 */
export const dateTimeScalar = {
  serialize(value: unknown): string {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    throw new TypeError("DateTime cannot represent a value that is not a valid Date");
  },
  parseValue(value: unknown): Date {
    if (typeof value !== "string" || !isDateTimeText(value)) throw invalid(DATE_TIME_HINT);
    return new Date(value);
  },
  parseLiteral(node: ValueNode): Date {
    if (node.kind !== Kind.STRING || !isDateTimeText(node.value)) throw invalid(DATE_TIME_HINT);
    return new Date(node.value);
  },
};

const LONG_HINT = "Long must be an integer of the JavaScript safe range";

/** An integer of the JavaScript safe range: volumes, counts and trade sequences, which can pass the 32-bit range of Int. */
export const longScalar = {
  serialize(value: unknown): number {
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    throw new TypeError("Long cannot represent a value that is not a safe integer");
  },
  parseValue(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid(LONG_HINT);
    return value;
  },
  parseLiteral(node: ValueNode): number {
    if (node.kind !== Kind.INT) throw invalid(LONG_HINT);
    const value = Number(node.value);
    if (!Number.isSafeInteger(value)) throw invalid(LONG_HINT);
    return value;
  },
};
