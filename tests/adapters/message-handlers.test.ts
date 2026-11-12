import { describe, expect, it } from "vitest";
import { containsNul, describeError, handleProjectionMessage, handleTenantCreatedMessage, payloadText, settleMessage } from "../../src/adapters/nats/message-handlers.js";
import type { SettleableMessage, SettleOptions } from "../../src/adapters/nats/message-handlers.js";
import { MARKET_OPENED_TYPE, TRADE_EXECUTED_TYPE } from "../../src/domain/consumed.js";
import type { TenantCreatedNotice } from "../../src/domain/tenant.js";
import type { ParkedEvent } from "../../src/usecases/ports.js";
import { PARK_AFTER_DELIVERIES } from "../../src/usecases/support.js";
import type {
  ProvisionResult,
  ProvisionTenantUseCase,
  RecordProjectionEventInput,
  RecordProjectionEventUseCase,
  RecordResult,
} from "../../src/usecases/use-cases.js";
import { MARKET_1, RecordingLogger, TENANT_A, T0, at, marketOpenedBody, tenantCreatedBody, tradeExecutedBody } from "../support/fakes.js";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

class RecordingProvision implements ProvisionTenantUseCase {
  readonly notices: TenantCreatedNotice[] = [];
  result: ProvisionResult = "provisioned";
  failure: Error | null = null;
  execute(notice: TenantCreatedNotice): Promise<ProvisionResult> {
    this.notices.push(notice);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.result);
  }
}

class RecordingRecord implements RecordProjectionEventUseCase {
  readonly inputs: RecordProjectionEventInput[] = [];
  result: RecordResult = "applied";
  failure: unknown = null;
  execute(input: RecordProjectionEventInput): Promise<RecordResult> {
    this.inputs.push(input);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a rejection that is no Error is the case under test
    return this.failure === null ? Promise.resolve(this.result) : Promise.reject(this.failure);
  }
}

describe("handleTenantCreatedMessage (TENANTS)", () => {
  it("provisions the tenant of a TenantCreated event and acknowledges it", async () => {
    const provision = new RecordingProvision();
    const logger = new RecordingLogger();
    const body = tenantCreatedBody(TENANT_A, "00000000-0000-7000-8000-00000000ee01");

    const result = await handleTenantCreatedMessage(encode(body), provision, logger);

    expect(result).toEqual({ kind: "ack" });
    expect(provision.notices).toEqual([{ eventId: "00000000-0000-7000-8000-00000000ee01", eventType: "si.chance.tenants.TenantCreated.v1", tenantId: TENANT_A, correlationId: "corr-00000000-0000-7000-8000-00000000ee01" }]);
    expect(logger.lines[0]).toMatchObject({ level: "info", fields: { tenantId: TENANT_A, result: "provisioned" } });
  });

  it("acknowledges a duplicate delivery", async () => {
    const provision = new RecordingProvision();
    provision.result = "duplicate";

    expect(await handleTenantCreatedMessage(encode(tenantCreatedBody()), provision, new RecordingLogger())).toEqual({ kind: "ack" });
  });

  it("acknowledges and skips a message that is not JSON (a warning), a type it does not act on (info) and a malformed event (a warning)", async () => {
    const provision = new RecordingProvision();
    const logger = new RecordingLogger();

    expect(await handleTenantCreatedMessage(encode("{not json"), provision, logger)).toEqual({ kind: "ack" });
    expect(await handleTenantCreatedMessage(encode({ ...tenantCreatedBody(), type: "si.chance.tenants.TenantRenamed.v1" }), provision, logger)).toEqual({ kind: "ack" });
    expect(await handleTenantCreatedMessage(encode({ ...tenantCreatedBody(), tenantid: "not-a-uuid" }), provision, logger)).toEqual({ kind: "ack" });

    expect(provision.notices).toEqual([]);
    expect(logger.lines.map((line) => line.level)).toEqual(["warn", "info", "warn"]);
  });

  it("naks with the reason when the use case fails, so the broker delivers it again", async () => {
    const provision = new RecordingProvision();
    const logger = new RecordingLogger();
    provision.failure = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

    const result = await handleTenantCreatedMessage(encode(tenantCreatedBody()), provision, logger);

    expect(result).toEqual({ kind: "nak", reason: "ECONNREFUSED: connection refused" });
    expect(logger.lines[0]?.level).toBe("error");
  });
});

describe("handleProjectionMessage (MARKETS and TRADING)", () => {
  it("records a projection event with the parsed body as the raw copy and acknowledges it after the use case returned", async () => {
    const record = new RecordingRecord();
    const logger = new RecordingLogger();
    const body = marketOpenedBody({ id: "00000000-0000-7000-8000-00000000ee02" });

    const result = await handleProjectionMessage(encode(body), record, logger);

    expect(result).toEqual({ kind: "ack" });
    expect(record.inputs).toHaveLength(1);
    expect(record.inputs[0]?.raw).toEqual(body);
    expect(record.inputs[0]?.event).toMatchObject({ kind: "market_opened", eventType: MARKET_OPENED_TYPE, tenantId: TENANT_A, facts: { marketId: MARKET_1 } });
    expect(logger.lines[0]).toMatchObject({ level: "info", fields: { tenantId: TENANT_A, marketId: MARKET_1, eventType: MARKET_OPENED_TYPE, result: "applied" } });
  });

  it("records a trade the same way, whatever result the use case reports (stale, duplicate)", async () => {
    const record = new RecordingRecord();
    const logger = new RecordingLogger();
    const body = tradeExecutedBody({ tradeSequence: 1, yesPriceMicro: 450_000, executedAt: at(5) });

    for (const result of ["applied", "stale", "duplicate"] as const) {
      record.result = result;
      expect(await handleProjectionMessage(encode(body), record, logger)).toEqual({ kind: "ack" });
    }

    expect(record.inputs.map((input) => input.event.kind)).toEqual(["trade_executed", "trade_executed", "trade_executed"]);
    expect(logger.lines.map((line) => (line.fields as { result: string }).result)).toEqual(["applied", "stale", "duplicate"]);
    expect(record.inputs[0]?.event.eventType).toBe(TRADE_EXECUTED_TYPE);
  });

  it("stores an event of another type of the stream (info) and acknowledges it; it is replayed as 'not projected'", async () => {
    const record = new RecordingRecord();
    record.result = "unprojected";
    const logger = new RecordingLogger();
    const body = { ...marketOpenedBody(), type: "si.chance.markets.MarketCreated.v1" };

    expect(await handleProjectionMessage(encode(body), record, logger)).toEqual({ kind: "ack" });

    expect(record.inputs[0]?.event).toMatchObject({ kind: "unprojected", cause: "other_type", marketId: MARKET_1 });
    expect(logger.lines[0]?.level).toBe("info");
  });

  it("stores an event this reader cannot read (a later type version) as a warning with the reason, and acknowledges it (ADR-058)", async () => {
    const record = new RecordingRecord();
    record.result = "unprojected";
    const logger = new RecordingLogger();
    const body = { ...tradeExecutedBody({ tradeSequence: 2, yesPriceMicro: 500_000 }), type: "si.chance.trading.TradeExecuted.v2" };

    expect(await handleProjectionMessage(encode(body), record, logger)).toEqual({ kind: "ack" });

    expect(record.inputs[0]?.event).toMatchObject({ kind: "unprojected", cause: "unreadable" });
    expect(record.inputs[0]?.raw).toEqual(body);
    expect(logger.lines[0]).toMatchObject({ level: "warn", fields: { result: "unprojected" } });
    expect((logger.lines[0]?.fields as { reason: string }).reason).toContain("TradeExecuted.v2");
  });

  it("parks at once a message that is not JSON, not a JSON object, or has no usable envelope, with the reason; nothing is recorded", async () => {
    const record = new RecordingRecord();
    const logger = new RecordingLogger();

    const notJson = await handleProjectionMessage(encode("{broken"), record, logger);
    const array = await handleProjectionMessage(encode([1, 2, 3]), record, logger);
    const noTenant = await handleProjectionMessage(encode({ ...marketOpenedBody(), tenantid: undefined }), record, logger);
    const noType = await handleProjectionMessage(encode({ ...marketOpenedBody(), type: undefined }), record, logger);

    expect(notJson).toEqual({ kind: "park", reason: "The message is not JSON" });
    expect(array).toEqual({ kind: "park", reason: "The message is not a JSON object" });
    expect(noTenant.kind).toBe("park");
    expect(noType.kind).toBe("park");
    expect(record.inputs).toEqual([]);
    expect(logger.lines.every((line) => line.level === "warn")).toBe(true);
  });

  it("parks at once an event with a NUL character anywhere in it: the jsonb copy cannot hold it", async () => {
    const record = new RecordingRecord();
    const logger = new RecordingLogger();
    const withQuestion = marketOpenedBody({ question: "Will it\u0000 work?" });

    const result = await handleProjectionMessage(encode(withQuestion), record, logger);

    expect(result.kind).toBe("park");
    expect(record.inputs).toEqual([]);
    expect(logger.lines[0]?.level).toBe("warn");
  });

  it("naks with the error code and message when the use case fails, and with the text of a value that is no Error", async () => {
    const record = new RecordingRecord();
    const logger = new RecordingLogger();
    const body = marketOpenedBody();

    record.failure = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    expect(await handleProjectionMessage(encode(body), record, logger)).toEqual({ kind: "nak", reason: "40P01: deadlock detected" });

    record.failure = "plain text";
    expect(await handleProjectionMessage(encode(body), record, logger)).toEqual({ kind: "nak", reason: "plain text" });
    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(2);
  });

  it("never puts a token or the body into a log line", async () => {
    const record = new RecordingRecord();
    const logger = new RecordingLogger();
    const body = { ...marketOpenedBody(), authorization: "Bearer secret-token" };

    await handleProjectionMessage(encode(body), record, logger);

    expect(JSON.stringify(logger.lines)).not.toContain("secret-token");
  });
});

describe("containsNul", () => {
  it("finds a NUL character in a nested value, an array element and a key, and nothing in clean data", () => {
    expect(containsNul({ a: { b: ["x", { c: "y\u0000" }] } })).toBe(true);
    expect(containsNul(["fine", ["also fine", "\u0000"]])).toBe(true);
    expect(containsNul({ ["k\u0000"]: 1 })).toBe(true);
    expect(containsNul({ a: ["x", 1, null, true, { b: "ü😀" }] })).toBe(false);
    expect(containsNul("no nul")).toBe(false);
  });

  it("walks a deeply nested body without recursion", () => {
    let nested: unknown = "bottom";
    for (let level = 0; level < 20_000; level += 1) nested = { level: nested };

    expect(containsNul(nested)).toBe(false);
  });
});

describe("describeError and payloadText", () => {
  it("labels an error with its code, else its name, and cuts the text", () => {
    expect(describeError(Object.assign(new Error("bad"), { code: "23505" }))).toBe("23505: bad");
    expect(describeError(new TypeError("worse"))).toBe("TypeError: worse");
    expect(describeError(Object.assign(new Error("empty code"), { code: "" }))).toBe("Error: empty code");
    expect(describeError("x".repeat(900))).toHaveLength(500);
    expect(describeError(new Error("y".repeat(900)))).toHaveLength(500);
  });

  it("decodes the body as text and replaces the NUL character that a text column cannot hold", () => {
    expect(payloadText(encode("hello ü"))).toBe("hello ü");
    expect(payloadText(new Uint8Array([97, 0, 98]))).toBe("a�b");
  });
});

describe("settleMessage", () => {
  const SUBJECT = `chance.markets.MarketOpened.${TENANT_A}`;

  function fixture(deliveryCount: number, body: unknown = marketOpenedBody({ startingPrice: 0.5, openedAt: T0 })) {
    const calls = { ack: 0, nak: [] as Array<number | undefined> };
    const message: SettleableMessage = {
      seq: 42,
      subject: SUBJECT,
      data: encode(body),
      info: { deliveryCount },
      ack: () => {
        calls.ack += 1;
      },
      nak: (millis) => {
        calls.nak.push(millis);
      },
    };
    const parked: ParkedEvent[] = [];
    const logger = new RecordingLogger();
    const options: SettleOptions = {
      consumer: "market-events",
      parkAfter: PARK_AFTER_DELIVERIES,
      nakDelayMs: 5000,
      park: (event) => {
        parked.push(event);
        return Promise.resolve();
      },
      logger,
      now: () => at(1),
    };
    return { message, calls, parked, logger, options };
  }

  it("acknowledges on ack", async () => {
    const { message, calls, parked, options } = fixture(1);

    expect(await settleMessage(message, { kind: "ack" }, options)).toBe("acked");

    expect(calls).toEqual({ ack: 1, nak: [] });
    expect(parked).toEqual([]);
  });

  it("naks with the delay on a failure before the park threshold", async () => {
    const { message, calls, parked, options } = fixture(PARK_AFTER_DELIVERIES - 1);

    expect(await settleMessage(message, { kind: "nak", reason: "database down" }, options)).toBe("naked");

    expect(calls).toEqual({ ack: 0, nak: [5000] });
    expect(parked).toEqual([]);
  });

  it("parks and acknowledges on the delivery number that reaches the threshold, with the payload as text and the last reason", async () => {
    const { message, calls, parked, logger, options } = fixture(PARK_AFTER_DELIVERIES);

    expect(await settleMessage(message, { kind: "nak", reason: "23514: check violated" }, options)).toBe("parked");

    expect(calls).toEqual({ ack: 1, nak: [] });
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ consumer: "market-events", streamSequence: 42, subject: SUBJECT, reason: "23514: check violated", deliveries: PARK_AFTER_DELIVERIES, parkedAt: at(1) });
    expect(JSON.parse(parked[0]?.payload ?? "")).toMatchObject({ type: MARKET_OPENED_TYPE });
    expect(logger.messages("error")[0]).toContain("too many deliveries");
  });

  it("parks and acknowledges a park result on the first delivery", async () => {
    const { message, calls, parked, logger, options } = fixture(1);

    expect(await settleMessage(message, { kind: "park", reason: "The message is not JSON" }, options)).toBe("parked");

    expect(calls).toEqual({ ack: 1, nak: [] });
    expect(parked[0]).toMatchObject({ deliveries: 1, reason: "The message is not JSON" });
    expect(logger.messages("error")[0]).toContain("cannot be stored");
  });

  it("naks when parking fails (the database is down), so the broker keeps the message", async () => {
    const { message, calls, logger, options } = fixture(1);
    const failing: SettleOptions = { ...options, park: () => Promise.reject(new Error("database is down")) };

    expect(await settleMessage(message, { kind: "park", reason: "x" }, failing)).toBe("naked");

    expect(calls).toEqual({ ack: 0, nak: [5000] });
    expect(logger.messages("error")[0]).toContain("could not be parked");
  });

  it("parks the text of a body that is not JSON: the stream sequence identifies the message", async () => {
    const { message, parked, options } = fixture(1, "{broken json");

    await settleMessage(message, { kind: "park", reason: "The message is not JSON" }, options);

    expect(parked[0]?.payload).toBe("{broken json");
    expect(parked[0]?.streamSequence).toBe(42);
  });
});
