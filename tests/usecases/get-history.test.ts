import { describe, expect, it } from "vitest";
import { HistoryPaused, NotFound, TenantNotReady, Updating, UseCaseError, ValidationFailed } from "../../src/usecases/errors.js";
import { MARKET_1, MARKET_2, T0, TENANT_B, actor, at, marketOpenedBody, tradeExecutedBody } from "../support/fakes.js";
import { consume, consumeAll, createCore } from "./core.js";
import type { Core } from "./core.js";

const trader = actor();
const HOUR = 3_600_000;

const failure = async (promise: Promise<unknown>): Promise<UseCaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UseCaseError) return error;
    throw error;
  }
  throw new Error("The call did not fail");
};

/**
 * Market 1 opened at 10:00 (starting price 0.40) with four trades: 10:10 and 10:20 in the first hour, 11:05 in the
 * second, 13:30 in the fourth; the clock stands at 14:00. In 1h buckets: 10:00 (three points), 11:00, 13:00; 12:00 is empty.
 */
async function seeded(): Promise<Core> {
  const core = createCore();
  await consumeAll(core, [
    marketOpenedBody({ marketId: MARKET_1 }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 450_000, costMicro: 10_000_000, executedAt: at(10) }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 2, yesPriceMicro: 500_000, costMicro: 20_000_000, executedAt: at(20) }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 3, yesPriceMicro: 480_000, costMicro: 5_000_000, executedAt: at(65) }),
    tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 4, yesPriceMicro: 520_000, costMicro: 1_000_000, executedAt: at(210) }),
  ]);
  core.clock.advanceMs(4 * HOUR);
  return core;
}

describe("GetHistory (plan 6.3, EP-4)", () => {
  it("returns sparse hourly buckets with open, high, low, close by trade sequence, volume and trades", async () => {
    const core = await seeded();
    const history = await core.getHistory.execute({ actor: trader, marketId: MARKET_1 });
    expect(history).toMatchObject({ marketId: MARKET_1, interval: "1h", from: T0, to: at(240), previousCloseYesMicro: null, nextCursor: null });
    expect(history.buckets).toEqual([
      // The opening point (the starting price, no volume, not a trade) opens the first bucket.
      { start: T0, openYesMicro: 400_000, highYesMicro: 500_000, lowYesMicro: 400_000, closeYesMicro: 500_000, volumeMicro: 30_000_000, trades: 2 },
      { start: at(60), openYesMicro: 480_000, highYesMicro: 480_000, lowYesMicro: 480_000, closeYesMicro: 480_000, volumeMicro: 5_000_000, trades: 1 },
      // 12:00 has no point and no bucket.
      { start: at(180), openYesMicro: 520_000, highYesMicro: 520_000, lowYesMicro: 520_000, closeYesMicro: 520_000, volumeMicro: 1_000_000, trades: 1 },
    ]);
  });

  it("groups by 5 minutes and by day, aligned to the Unix epoch in UTC", async () => {
    const core = await seeded();
    const five = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, interval: "5m" });
    expect(five.buckets.map((bucket) => bucket.start)).toEqual([T0, at(10), at(20), at(65), at(210)]);
    const day = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, interval: "1d" });
    expect(day.from).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(day.buckets).toEqual([
      { start: new Date("2026-11-01T00:00:00.000Z"), openYesMicro: 400_000, highYesMicro: 520_000, lowYesMicro: 400_000, closeYesMicro: 520_000, volumeMicro: 36_000_000, trades: 4 },
    ]);
  });

  it("pages to the end with a cursor, and the later page's previousCloseYesMicro is the latest point before it", async () => {
    const core = await seeded();
    const first = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 2 });
    expect(first.buckets.map((bucket) => bucket.start)).toEqual([T0, at(60)]);
    expect(first.previousCloseYesMicro).toBeNull();
    expect(first.nextCursor).not.toBeNull();

    const second = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.buckets.map((bucket) => bucket.start)).toEqual([at(180)]);
    // The latest point before 13:00 is the trade of 11:05.
    expect(second.previousCloseYesMicro).toBe(480_000);
    expect(second.nextCursor).toBeNull();
    expect([second.from, second.to]).toEqual([first.from, first.to]);

    const single = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 1 });
    const walked = [single];
    for (let page = single; page.nextCursor !== null; ) {
      page = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 1, cursor: page.nextCursor });
      walked.push(page);
    }
    expect(walked.flatMap((page) => page.buckets.map((bucket) => bucket.start))).toEqual([T0, at(60), at(180)]);
  });

  it("continues page 1's range on page 2 after the clock moved on with `to` omitted, even when the range is now above HISTORY_MAX_POINTS", async () => {
    const core = await seeded();
    core.rules.rules.maxPoints = 10;
    const first = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 1 });
    expect(first.to).toEqual(at(240));

    // A day and a half later page 1's `to` (now) would span far more than 10 buckets; the cursor keeps the old range.
    core.clock.advanceMs(36 * HOUR);
    const second = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.buckets.map((bucket) => bucket.start)).toEqual([at(60)]);
    expect([second.from, second.to]).toEqual([first.from, first.to]);

    // A new page 1 now starts at the newest 10 buckets, which hold no point: the last close is carried forward.
    const fresh = await core.getHistory.execute({ actor: trader, marketId: MARKET_1 });
    expect(fresh.buckets).toEqual([]);
    expect(fresh.previousCloseYesMicro).toBe(520_000);
  });

  it("answers an explicit range [from, to): from rounded down to its bucket, to as sent", async () => {
    const core = await seeded();
    const history = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, from: at(65), to: at(200) });
    expect(history).toMatchObject({ from: at(60), to: at(200), previousCloseYesMicro: 500_000 });
    // The trade of 13:30 lies after `to`: only 11:05 is in the range.
    expect(history.buckets.map((bucket) => bucket.start)).toEqual([at(60)]);
    // A range that holds no point is an empty page, not an error.
    expect((await core.getHistory.execute({ actor: trader, marketId: MARKET_1, from: at(120), to: at(170) })).buckets).toEqual([]);
  });

  it("refuses a range of more than HISTORY_MAX_POINTS buckets with the limit in the problem, but accepts the last N intervals at any time", async () => {
    const core = await seeded();
    core.rules.rules.maxPoints = 10;
    const tooLarge = await failure(core.getHistory.execute({ actor: trader, marketId: MARKET_1, from: at(240 - 11 * 60) }));
    expect(tooLarge).toBeInstanceOf(ValidationFailed);
    expect(tooLarge).toMatchObject({ kind: "validation", fields: [expect.objectContaining({ field: "from" })], details: { maxPoints: 10 } });
    // Exactly 10 hours as sent is accepted although rounding `from` down adds a partial bucket.
    const accepted = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, from: at(240 - 10 * 60 + 30) });
    expect(accepted.from).toEqual(at(240 - 10 * 60));
    expect((await core.getHistory.execute({ actor: trader, marketId: MARKET_1, from: at(240 - 10 * 60) })).from).toEqual(at(240 - 10 * 60));
  });

  it("returns an empty history for a market that has just opened", async () => {
    const core = createCore();
    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    const history = await core.getHistory.execute({ actor: trader, marketId: MARKET_1 });
    expect(history).toMatchObject({ buckets: [], previousCloseYesMicro: null, nextCursor: null, from: at(-60), to: T0 });
  });

  it("refuses a from that is not before to, and a date that is no time (a leap second), each on its own field", async () => {
    const core = await seeded();
    const field = async (input: { from?: Date; to?: Date; cursor?: string }) => {
      const error = await failure(core.getHistory.execute({ actor: trader, marketId: MARKET_1, ...input }));
      expect(error).toBeInstanceOf(ValidationFailed);
      return error.fields[0]?.field;
    };
    expect(await field({ from: at(240), to: at(240) })).toBe("from");
    expect(await field({ from: at(300) })).toBe("from");
    // new Date("2016-12-31T23:59:60Z") is what the web layer passes on for a leap second: an Invalid Date.
    const leapSecond = new Date(Number.NaN);
    expect(await field({ from: leapSecond })).toBe("from");
    expect(await field({ to: leapSecond })).toBe("to");
    const first = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 1 });
    expect(await field({ from: leapSecond, cursor: first.nextCursor ?? undefined })).toBe("from");
    expect(await field({ to: leapSecond, cursor: first.nextCursor ?? undefined })).toBe("to");
  });

  it("refuses a cursor of another interval, a range that disagrees with it and a crafted one, on the cursor field", async () => {
    const core = await seeded();
    const first = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 1, from: at(0), to: at(240) });
    const cursor = first.nextCursor ?? "";
    const field = async (input: { interval?: string; from?: Date; to?: Date; cursor: string }) => {
      const error = await failure(core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 1, ...input }));
      expect(error).toBeInstanceOf(ValidationFailed);
      return error.fields[0]?.field;
    };
    expect(await field({ cursor, interval: "5m" })).toBe("cursor");
    expect(await field({ cursor, from: at(-120), to: at(240) })).toBe("cursor");
    expect(await field({ cursor, from: at(0), to: at(239) })).toBe("cursor");
    expect(await field({ cursor: "garbage" })).toBe("cursor");
    expect(await field({ cursor: Buffer.from(JSON.stringify({ b: 1, i: "1h", f: 0, t: 1 })).toString("base64url") })).toBe("cursor");
    // The same range sent again with the cursor is fine.
    const next = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 1, from: at(0), to: at(240), cursor });
    expect(next.buckets.map((bucket) => bucket.start)).toEqual([at(60)]);
  });

  it("answers history paused (503) before it looks at the tenant or the market, and works again when enabled", async () => {
    const core = await seeded();
    core.rules.rules.enabled = false;
    const paused = await failure(core.getHistory.execute({ actor: actor("trader-x", "trader", TENANT_B), marketId: MARKET_2 }));
    expect(paused).toBeInstanceOf(HistoryPaused);
    expect(paused).toMatchObject({ kind: "unavailable", code: "history_paused", retryAfterSeconds: 30 });
    // A malformed request is still a 400: shape comes first.
    expect(await failure(core.getHistory.execute({ actor: trader, marketId: MARKET_1, limit: 0 }))).toBeInstanceOf(ValidationFailed);

    core.rules.rules.enabled = true;
    expect((await core.getHistory.execute({ actor: trader, marketId: MARKET_1 })).buckets).toHaveLength(3);
  });

  it("answers 404 for an unknown market, another tenant's market and a market that is not opened, then 409 for afterSequence, then 200", async () => {
    const core = await seeded();
    await consume(core, tradeExecutedBody({ marketId: MARKET_2, tradeSequence: 1, yesPriceMicro: 450_000 }));
    await expect(core.getHistory.execute({ actor: trader, marketId: MARKET_2 })).rejects.toBeInstanceOf(NotFound);
    await expect(core.getHistory.execute({ actor: trader, marketId: "018f3c1e-7a00-7000-8000-0000000000ff", afterSequence: 9 })).rejects.toBeInstanceOf(NotFound);
    await consume(core, marketOpenedBody({ tenantId: TENANT_B, marketId: MARKET_1, question: "Tenant B's market?" }));
    expect((await core.getHistory.execute({ actor: actor("trader-b", "trader", TENANT_B), marketId: MARKET_1 })).buckets).toHaveLength(1);
    await expect(core.getHistory.execute({ actor: actor("trader-b", "trader", TENANT_B), marketId: MARKET_2 })).rejects.toBeInstanceOf(NotFound);

    expect((await core.getHistory.execute({ actor: trader, marketId: MARKET_1, afterSequence: 4 })).buckets).toHaveLength(3);
    const updating = await failure(core.getHistory.execute({ actor: trader, marketId: MARKET_1, afterSequence: 5 }));
    expect(updating).toBeInstanceOf(Updating);
    expect(updating).toMatchObject({ code: "updating", details: { lastTradeSequence: 4 } });
    await consume(core, tradeExecutedBody({ marketId: MARKET_1, tradeSequence: 5, yesPriceMicro: 530_000, executedAt: at(230) }));
    const history = await core.getHistory.execute({ actor: trader, marketId: MARKET_1, afterSequence: 5 });
    expect(history.buckets.at(-1)).toMatchObject({ start: at(180), closeYesMicro: 530_000, trades: 2 });
  });

  it("shows a tenant its own history of a market id that two tenants share", async () => {
    const core = await seeded();
    await consumeAll(core, [
      marketOpenedBody({ tenantId: TENANT_B, marketId: MARKET_1, openedAt: at(30), startingPrice: 0.6 }),
      tradeExecutedBody({ tenantId: TENANT_B, marketId: MARKET_1, tradeSequence: 1, yesPriceMicro: 650_000, costMicro: 1_000_000, executedAt: at(40) }),
    ]);
    const history = await core.getHistory.execute({ actor: actor("trader-b", "trader", TENANT_B), marketId: MARKET_1 });
    expect(history.buckets).toEqual([{ start: T0, openYesMicro: 600_000, highYesMicro: 650_000, lowYesMicro: 600_000, closeYesMicro: 650_000, volumeMicro: 1_000_000, trades: 1 }]);
  });

  it("refuses malformed shapes with a field error before it looks at the tenant", async () => {
    const core = createCore();
    const field = async (input: { marketId?: string; interval?: string; limit?: number; afterSequence?: number }) => {
      const error = await failure(core.getHistory.execute({ actor: trader, marketId: MARKET_1, ...input }));
      expect(error).toBeInstanceOf(ValidationFailed);
      return error.fields[0]?.field;
    };
    expect(await field({ marketId: "nope" })).toBe("marketId");
    expect(await field({ interval: "2h" })).toBe("interval");
    expect(await field({ limit: 0 })).toBe("limit");
    expect(await field({ limit: 501 })).toBe("limit");
    expect(await field({ afterSequence: 0 })).toBe("afterSequence");
    // A well-formed request of a tenant without a schema is tenant-not-ready.
    await expect(core.getHistory.execute({ actor: trader, marketId: MARKET_1 })).rejects.toBeInstanceOf(TenantNotReady);
  });
});
