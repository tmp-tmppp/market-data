import { describe, expect, it } from "vitest";
import { isLifecycleEvent, isProjectionEvent, isProjectionFamily, marketOf, parseMarketId, questionLength, readProjectionEvent, storedMarketOf } from "../../src/domain/consumed.js";
import type { ReadResult } from "../../src/domain/consumed.js";
import { DomainError } from "../../src/domain/errors.js";
import { readTenantCreated, tenantSchemaIdentifier, tenantSchemaName } from "../../src/domain/tenant.js";
import { MARKET_1, T0, TENANT_A, at, marketClosedBody, marketOpenedBody, marketResolvedBody, projectionEvent, tenantCreatedBody, tradeExecutedBody } from "../support/fakes.js";

const openedData = (): object => marketOpenedBody()["data"] as object;
const RAIN = String.fromCodePoint(0x1f327);

function kindOf(read: ReadResult): string {
  return read.kind === "unprojected" ? `unprojected:${read.cause}` : read.kind;
}

describe("readProjectionEvent", () => {
  it("reads the four event types with the facts the read model needs", () => {
    const opened = projectionEvent(marketOpenedBody({ startingPrice: 0.37, extra: { sharing: { whoMayShare: "admins" } } }));
    expect(opened).toMatchObject({ kind: "market_opened", tenantId: TENANT_A, facts: { marketId: MARKET_1, version: 1, startingPriceYesMicro: 370_000, openedAt: T0 } });
    expect(projectionEvent(marketClosedBody())).toMatchObject({ kind: "market_closed", facts: { version: 2, closedAt: at(600) } });
    expect(projectionEvent(marketResolvedBody({ outcome: "NO" }))).toMatchObject({ kind: "market_resolved", facts: { outcome: "NO", version: 3 } });
    expect(projectionEvent(marketResolvedBody({ outcome: "INVALID" }))).toMatchObject({ kind: "market_resolved", facts: { outcome: "INVALID", version: 3 } });
    const trade = projectionEvent(tradeExecutedBody({ tradeSequence: 4, yesPriceMicro: 550_000, costMicro: 7_000_000 }));
    expect(trade).toMatchObject({ kind: "trade_executed", facts: { tradeSequence: 4, priceYesMicro: 550_000, volumeMicro: 7_000_000, executedAt: at(4) } });
    expect(marketOf(trade)).toBe(MARKET_1);
    expect(storedMarketOf(trade)).toBe(MARKET_1);
    expect(isLifecycleEvent(trade)).toBe(false);
    expect(isLifecycleEvent(opened)).toBe(true);
  });

  it("lower-cases ids and keeps the correlation id", () => {
    const body = marketClosedBody({ marketId: MARKET_1.toUpperCase(), tenantId: TENANT_A.toUpperCase() });
    const event = projectionEvent(body);
    expect(event.tenantId).toBe(TENANT_A);
    expect(event.facts.marketId).toBe(MARKET_1);
    expect(event.correlationId).toBe(`corr-${String(body["id"])}`);
  });

  it("counts the question in code points after trimming, as markets and char_length do", () => {
    const question = (text: string): Record<string, unknown> => ({ ...marketOpenedBody(), data: { ...openedData(), question: text } });
    const prefix = "Will it rain tomorrow? ";
    const rainy = prefix + RAIN.repeat(100);
    expect(questionLength(rainy)).toBe(123);
    expect(rainy.length).toBe(223);
    expect(projectionEvent(question(rainy)).facts).toMatchObject({ question: rainy });
    expect(projectionEvent(question(RAIN.repeat(200))).kind).toBe("market_opened");
    expect(projectionEvent(question(`  ${"a".repeat(198)}${RAIN}${RAIN}  `)).facts).toMatchObject({ question: `${"a".repeat(198)}${RAIN}${RAIN}` });
    expect(kindOf(readProjectionEvent(question(RAIN.repeat(201))))).toBe("unprojected:unreadable");
    expect(kindOf(readProjectionEvent(question("   ")))).toBe("unprojected:unreadable");
  });

  it("accepts every trade price trading's contract allows, not only the grid", () => {
    expect(projectionEvent(tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 555_000 })).facts).toMatchObject({ priceYesMicro: 555_000 });
    expect(projectionEvent(tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 10_000 })).kind).toBe("trade_executed");
    expect(kindOf(readProjectionEvent(tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 995_000 })))).toBe("unprojected:unreadable");
    expect(kindOf(readProjectionEvent(tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 550_000.5 })))).toBe("unprojected:unreadable");
  });

  it("keeps a projection-family event it cannot read as unreadable, with the envelope to store it", () => {
    const cases: Record<string, unknown>[] = [
      { ...marketClosedBody(), data: [] },
      { ...marketClosedBody(), data: { ...(marketClosedBody()["data"] as object), tenantId: "018f3c1e-7a00-7000-8000-0000000000bb" } },
      { ...marketOpenedBody(), data: { ...openedData(), startingPrice: 0.405 } },
      { ...marketOpenedBody(), data: { ...openedData(), question: "" } },
      { ...marketOpenedBody(), data: { ...openedData(), closeTime: "tomorrow" } },
      { ...marketOpenedBody(), data: { ...openedData(), openedAt: "2016-12-31T23:59:60Z" } },
      { ...marketResolvedBody(), data: { ...(marketResolvedBody()["data"] as object), outcome: "MAYBE" } },
      { ...marketResolvedBody(), data: { ...(marketResolvedBody()["data"] as object), outcome: "invalid" } },
      { ...marketClosedBody(), data: { ...(marketClosedBody()["data"] as object), version: 0 } },
      tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 550_000, costMicro: -1 }),
      { ...tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 550_000 }), type: "si.chance.trading.TradeExecuted.v2" },
      { ...marketOpenedBody(), type: "si.chance.markets.MarketOpened.v7" },
    ];
    for (const body of cases) {
      const read = readProjectionEvent(body);
      expect(kindOf(read), JSON.stringify(body)).toBe("unprojected:unreadable");
      if (read.kind !== "unprojected") continue;
      expect(read).toMatchObject({ eventId: String(body["id"]).toLowerCase(), eventType: body["type"], tenantId: TENANT_A });
      expect(read.reason.length).toBeGreaterThan(0);
      expect(storedMarketOf(read)).toBe(Array.isArray(body["data"]) ? null : MARKET_1);
    }
    const noMarket = readProjectionEvent({ ...tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 550_000 }), data: { marketId: "x" } });
    expect(noMarket).toMatchObject({ kind: "unprojected", cause: "unreadable", marketId: null });
  });

  it("keeps other types of the streams as other_type, stored but never projected", () => {
    for (const type of ["si.chance.trading.MarketSettled.v1", "si.chance.markets.MarketCreated.v1", "si.chance.markets.MarketOpenedLater.v1"]) {
      const read = readProjectionEvent({ ...marketClosedBody(), type });
      expect(read).toMatchObject({ kind: "unprojected", cause: "other_type", eventType: type, marketId: MARKET_1 });
      expect(isProjectionEvent(read)).toBe(false);
    }
    expect(isProjectionFamily("si.chance.trading.TradeExecuted.v12")).toBe(true);
    expect(isProjectionFamily("si.chance.trading.TradeExecuted")).toBe(false);
  });

  it("reports an event without a usable envelope as unattributable, never throwing", () => {
    const cases: unknown[] = [
      "text",
      null,
      [],
      { ...marketClosedBody(), specversion: "0.3" },
      { ...marketClosedBody(), id: "not-a-uuid" },
      { ...marketClosedBody(), tenantid: "acme" },
      { ...marketClosedBody(), type: 7 },
      { ...marketClosedBody(), type: "" },
      { ...marketClosedBody(), type: `si.chance.markets.${"X".repeat(200)}` },
    ];
    for (const body of cases) expect(readProjectionEvent(body).kind, JSON.stringify(body)).toBe("unattributable");
    expect(readProjectionEvent({ ...marketClosedBody(), tenantid: "acme" })).toMatchObject({ eventId: expect.any(String) as unknown });
  });

  it("parses market ids", () => {
    expect(parseMarketId(MARKET_1.toUpperCase())).toBe(MARKET_1);
    expect(() => parseMarketId("x")).toThrow(DomainError);
  });
});

describe("tenants", () => {
  it("names the tenant schema as every other service does", () => {
    expect(tenantSchemaName(TENANT_A.toUpperCase())).toBe("tenant_018f3c1e7a00700080000000000000aa");
    expect(tenantSchemaIdentifier(TENANT_A)).toBe('"tenant_018f3c1e7a00700080000000000000aa"');
    expect(() => tenantSchemaName("public")).toThrow(DomainError);
  });

  it("reads TenantCreated and ignores anything else", () => {
    expect(readTenantCreated(tenantCreatedBody())).toMatchObject({ kind: "tenant_created", notice: { tenantId: TENANT_A } });
    expect(readTenantCreated(marketOpenedBody()).kind).toBe("ignored");
    expect(readTenantCreated({ ...tenantCreatedBody(), data: { tenantId: "018f3c1e-7a00-7000-8000-0000000000bb" } }).kind).toBe("ignored");
    expect(readTenantCreated(null).kind).toBe("ignored");
  });
});
