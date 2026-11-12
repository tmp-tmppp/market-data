import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { formatGraphqlError } from "../../src/web/graphql/errors.js";
import { GraphQLError } from "../../src/web/graphql/graphql-js.js";

// Which errors of graphql are the caller's mistake and which are a bug of the service, on errors built the way graphql builds
// them (the endpoint tests send real requests: tests/web/graphql.test.ts).

function logger() {
  const error = vi.fn();
  return { log: { error } as unknown as FastifyBaseLogger, error };
}

describe("formatGraphqlError", () => {
  it("tells an error that wraps another error of graphql, with no path, as a query error: that is how a variable of the wrong type arrives", () => {
    const inner = new GraphQLError('Int cannot represent non-integer value: "abc"');
    const outer = new GraphQLError('Variable "$n" got invalid value "abc"; Int cannot represent non-integer value: "abc"', { originalError: inner });
    const { log, error } = logger();
    expect(formatGraphqlError(outer, log)).toEqual({ message: outer.message, extensions: { code: "graphql_validation_failed", status: 400 } });
    expect(error).not.toHaveBeenCalled();
  });

  it("follows the whole chain: errors of graphql down to the last one are the caller's, with the suggestion cut when asked", () => {
    const innermost = new GraphQLError('Value "OPEM" does not exist in "MarketStatus" enum. Did you mean the enum value "OPEN"?');
    const middle = new GraphQLError("wrapped", { originalError: innermost });
    const outer = new GraphQLError('Variable "$s" got invalid value "OPEM"; Value "OPEM" does not exist in "MarketStatus" enum. Did you mean the enum value "OPEN"?', { originalError: middle });
    const { log, error } = logger();
    expect(formatGraphqlError(outer, log, true).message).toBe('Variable "$s" got invalid value "OPEM"; Value "OPEM" does not exist in "MarketStatus" enum.');
    expect(formatGraphqlError(outer, log).message).toContain("Did you mean");
    expect(formatGraphqlError(outer, log).extensions).toEqual({ code: "graphql_validation_failed", status: 400 });
    expect(error).not.toHaveBeenCalled();
  });

  it("still hides and logs an error whose chain ends in something that is no error of graphql: a scalar that crashed is a bug", () => {
    const bug = new TypeError("Cannot read properties of undefined");
    const scalar = new GraphQLError('Expected type "Long". Cannot read properties of undefined', { originalError: bug });
    const outer = new GraphQLError('Variable "$a" got invalid value 1; Expected type "Long". Cannot read properties of undefined', { originalError: scalar });
    const { log, error } = logger();
    expect(formatGraphqlError(outer, log)).toEqual({ message: "The service failed to handle the request", extensions: { code: "internal_error", status: 500 } });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ err: bug });
  });

  it("hides and logs an error that is not an error of graphql at all, and a failure of a field whatever its cause", () => {
    const { log, error } = logger();
    const bug = new Error("boom");
    expect(formatGraphqlError(new GraphQLError("boom", { originalError: bug }), log).extensions).toEqual({ code: "internal_error", status: 500 });
    const failedField = new GraphQLError("failed", { originalError: new GraphQLError("inner"), path: ["markets"] });
    expect(formatGraphqlError(failedField, log)).toMatchObject({ message: "The service failed to handle the request", path: ["markets"], extensions: { code: "internal_error", status: 500 } });
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("keeps the code of an error that has one, and tells an error with no cause and no path as a query error", () => {
    const { log, error } = logger();
    const coded = new GraphQLError("DateTime must be an RFC 3339 date-time", { extensions: { code: "validation_failed", status: 400 } });
    expect(formatGraphqlError(new GraphQLError("wrapped", { originalError: coded }), log).extensions).toEqual({ status: 400, code: "validation_failed" });
    expect(formatGraphqlError(new GraphQLError('Cannot query field "x" on type "Query".'), log).extensions).toEqual({ code: "graphql_validation_failed", status: 400 });
    expect(error).not.toHaveBeenCalled();
  });
});
