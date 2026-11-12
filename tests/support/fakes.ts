import { DEFAULT_RUNTIME_SETTINGS } from "../../src/config.js";
import { MARKET_CLOSED_TYPE, MARKET_OPENED_TYPE, MARKET_RESOLVED_TYPE, TRADE_EXECUTED_TYPE, isProjectionEvent, readProjectionEvent } from "../../src/domain/consumed.js";
import type { ProjectionEvent } from "../../src/domain/consumed.js";
import { TENANT_CREATED_TYPE } from "../../src/domain/tenant.js";
import type { Actor, Clock, HistoryRules, HistoryRulesSource, Logger, MarketDataRole } from "../../src/usecases/ports.js";

// Test doubles and event builders shared by the domain, use-case, adapter and web tests.

export const TENANT_A = "018f3c1e-7a00-7000-8000-0000000000aa";
export const TENANT_B = "018f3c1e-7a00-7000-8000-0000000000bb";
export const MARKET_1 = "018f3c1e-7a00-7000-8000-000000000101";
export const MARKET_2 = "018f3c1e-7a00-7000-8000-000000000102";
export const MARKET_3 = "018f3c1e-7a00-7000-8000-000000000103";
export const CREATOR = "admin-1";
export const TRADER = "trader-1";

/** The clock's start; event times in the builders below are relative to it. */
export const T0 = new Date("2026-11-01T10:00:00.000Z");

export class TestClock implements Clock {
  constructor(private current = new Date(T0)) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  /** Moves forward by a millisecond so that rows written one after another sort in a known order. */
  tick(): void {
    this.advanceMs(1);
  }
}

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; fields: object; message: string | undefined }> = [];
  info(fields: object, message?: string): void {
    this.lines.push({ level: "info", fields, message });
  }
  warn(fields: object, message?: string): void {
    this.lines.push({ level: "warn", fields, message });
  }
  error(fields: object, message?: string): void {
    this.lines.push({ level: "error", fields, message });
  }
  messages(level?: string): Array<string | undefined> {
    return this.lines.filter((line) => level === undefined || line.level === level).map((line) => line.message);
  }
}

/** History rules a test can change between calls (the runtime configuration, ADR-037). */
export class TestRules implements HistoryRulesSource {
  rules: HistoryRules = { ...DEFAULT_RUNTIME_SETTINGS.historyRules };
  current(): HistoryRules {
    return this.rules;
  }
}

/** A caller of the public API, as the web layer builds it from a token. */
export function actor(userId: string = TRADER, role: MarketDataRole = "trader", tenantId = TENANT_A): Actor {
  return { userId, role, tenantId, correlationId: `corr-${userId}` };
}

/** `minutes` after T0. */
export function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

// ---- CloudEvents as the publishers send them (markets', trading's and tenants' contracts/asyncapi.yaml) ----

let eventCounter = 0;

/** A fresh, valid, lower-case UUIDv7-like event id: ...e0000001, ...e0000002 */
export function nextEventId(): string {
  eventCounter += 1;
  return `00000000-0000-7000-8000-${String(eventCounter).padStart(12, "0")}`;
}

type Body = Record<string, unknown>;

function envelope(type: string, source: string, subject: string, tenantId: string, data: Body, id: string): Body {
  return {
    specversion: "1.0",
    id,
    source,
    type,
    subject,
    time: T0.toISOString(),
    datacontenttype: "application/json",
    tenantid: tenantId,
    correlationid: `corr-${id}`,
    causationid: `cause-${id}`,
    data,
  };
}

export interface OpenedOptions {
  marketId?: string;
  tenantId?: string;
  version?: number;
  question?: string;
  /** Default: 48 hours after T0. */
  closeTime?: Date;
  startingPrice?: number;
  openedAt?: Date;
  id?: string;
  /** Extra data fields (an invented optional field, as a publisher might add one later). */
  extra?: Body;
}

export function marketOpenedBody(options: OpenedOptions = {}): Body {
  const marketId = options.marketId ?? MARKET_1;
  return envelope(MARKET_OPENED_TYPE, "/chance/markets", `market/${marketId}`, options.tenantId ?? TENANT_A, {
    marketId,
    question: options.question ?? "Will the demo work on the first try?",
    closeTime: (options.closeTime ?? new Date(T0.getTime() + 48 * 3_600_000)).toISOString(),
    startingPrice: options.startingPrice ?? 0.4,
    fundingAmount: 5000,
    creatorId: CREATOR,
    version: options.version ?? 1,
    openedAt: (options.openedAt ?? T0).toISOString(),
    ...options.extra,
  }, options.id ?? nextEventId());
}

export function marketClosedBody(options: { marketId?: string; tenantId?: string; version?: number; closedAt?: Date; id?: string } = {}): Body {
  const marketId = options.marketId ?? MARKET_1;
  return envelope(MARKET_CLOSED_TYPE, "/chance/markets", `market/${marketId}`, options.tenantId ?? TENANT_A, {
    marketId,
    version: options.version ?? 2,
    closedAt: (options.closedAt ?? at(600)).toISOString(),
    closedBy: CREATOR,
  }, options.id ?? nextEventId());
}

export function marketResolvedBody(options: { marketId?: string; tenantId?: string; version?: number; outcome?: "YES" | "NO" | "INVALID"; resolvedAt?: Date; id?: string } = {}): Body {
  const marketId = options.marketId ?? MARKET_1;
  return envelope(MARKET_RESOLVED_TYPE, "/chance/markets", `market/${marketId}`, options.tenantId ?? TENANT_A, {
    marketId,
    outcome: options.outcome ?? "YES",
    version: options.version ?? 3,
    resolvedAt: (options.resolvedAt ?? at(700)).toISOString(),
    resolvedBy: CREATOR,
    creatorId: CREATOR,
  }, options.id ?? nextEventId());
}

export interface TradeOptions {
  marketId?: string;
  tenantId?: string;
  tradeSequence: number;
  /** The YES price in microcredits (grid). */
  yesPriceMicro: number;
  costMicro?: number;
  executedAt?: Date;
  id?: string;
}

/** A YES buy at `yesPriceMicro` (trading's TradeExecuted; the fields market-data ignores are filled consistently). */
export function tradeExecutedBody(options: TradeOptions): Body {
  const marketId = options.marketId ?? MARKET_1;
  const cost = options.costMicro ?? 10_000_000;
  return envelope(TRADE_EXECUTED_TYPE, "/chance/trading", `market/${marketId}`, options.tenantId ?? TENANT_A, {
    tradeId: nextEventId(),
    marketId,
    userId: TRADER,
    side: "YES",
    sharesMicro: Math.floor((cost * 1_000_000) / options.yesPriceMicro),
    costMicro: cost,
    averagePriceMicro: options.yesPriceMicro,
    lastPriceMicro: options.yesPriceMicro,
    yesPriceMicro: options.yesPriceMicro,
    tradeSequence: options.tradeSequence,
    executedAt: (options.executedAt ?? at(options.tradeSequence)).toISOString(),
  }, options.id ?? nextEventId());
}

export function tenantCreatedBody(tenantId: string = TENANT_A, id: string = nextEventId()): Body {
  return {
    specversion: "1.0",
    id,
    source: "/chance/tenants",
    type: TENANT_CREATED_TYPE,
    subject: `tenant/${tenantId}`,
    time: T0.toISOString(),
    datacontenttype: "application/json",
    tenantid: tenantId,
    correlationid: `corr-${id}`,
    causationid: `cause-${id}`,
    data: { tenantId, name: "Software team", slug: "software-team", createdAt: T0.toISOString() },
  };
}

/** Reads a body with the production reader and fails the test when it is not a projection event. */
export function projectionEvent(body: Body): ProjectionEvent {
  const event = readProjectionEvent(body);
  if (!isProjectionEvent(event)) throw new Error(`The test event was not projected: ${event.reason}`);
  return event;
}
