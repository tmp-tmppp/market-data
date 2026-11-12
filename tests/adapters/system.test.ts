import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/adapters/system.js";

describe("systemClock", () => {
  it("returns the current time as a new Date on every call", () => {
    const before = Date.now();
    const first = systemClock.now();
    const second = systemClock.now();
    const after = Date.now();

    expect(first).toBeInstanceOf(Date);
    expect(first.getTime()).toBeGreaterThanOrEqual(before);
    expect(second.getTime()).toBeLessThanOrEqual(after);
    expect(first).not.toBe(second);
  });
});
