import { describe, expect, it } from "vitest";
import { TENANT_CREATED_TYPE } from "../../src/domain/tenant.js";
import { TENANT_CREATED_CONSUMER } from "../../src/usecases/support.js";
import { MARKET_1, TENANT_A, TENANT_B, T0, marketOpenedBody, tradeExecutedBody } from "../support/fakes.js";
import { consume, createCore } from "./core.js";

const notice = (eventId: string, tenantId = TENANT_A) => ({ eventId, eventType: TENANT_CREATED_TYPE, tenantId, correlationId: "corr-1" as string | null });

describe("ProvisionTenant (DM-01, DM-06)", () => {
  it("registers the tenant, records the event in the inbox and creates projection version 1, in one commit", async () => {
    const core = createCore();
    expect(await core.store.forTenant(TENANT_A)).toBeNull();

    expect(await core.provisionTenant.execute(notice("event-1"))).toBe("provisioned");

    const state = core.store.snapshot();
    expect(state.tenants).toEqual([TENANT_A]);
    expect(state.inbox).toEqual([{ consumer: TENANT_CREATED_CONSUMER, eventId: "event-1", eventType: TENANT_CREATED_TYPE, processedAt: T0 }]);
    expect(state.tenantData[TENANT_A]?.checkpoints.map((row) => [row.version, row.state])).toEqual([[1, "active"]]);
    expect(await core.store.forTenant(TENANT_A)).not.toBeNull();
    expect(core.logger.lines).toEqual([expect.objectContaining({ level: "info", fields: { tenantId: TENANT_A, eventId: "event-1", correlationId: "corr-1" }, message: "Tenant provisioned" })]);
  });

  it("changes nothing for a redelivered event, and keeps the data of a tenant that another TenantCreated names again", async () => {
    const core = createCore();
    await core.provisionTenant.execute(notice("event-1"));
    await consume(core, marketOpenedBody({ marketId: MARKET_1 }));
    const before = core.store.snapshot();

    expect(await core.provisionTenant.execute(notice("event-1"))).toBe("duplicate");
    expect(core.store.snapshot()).toEqual(before);
    expect(core.logger.messages().at(-1)).toBe("TenantCreated was processed before; nothing changed");

    // Another event id for the same tenant (a republished TenantCreated): provisioning is idempotent, the rows stay.
    expect(await core.provisionTenant.execute(notice("event-2"))).toBe("provisioned");
    const after = core.store.snapshot();
    expect(after.tenants).toEqual([TENANT_A]);
    expect(after.tenantData[TENANT_A]).toEqual(before.tenantData[TENANT_A]);
  });

  it("leaves no inbox entry when the provisioning fails, so the redelivery provisions", async () => {
    const core = createCore();
    core.store.hooks.onOperation = (operation) => {
      if (operation === "tenants.provision") throw new Error("schema creation failed");
    };
    await expect(core.provisionTenant.execute(notice("event-1"))).rejects.toThrow("schema creation failed");
    expect(core.store.snapshot().inbox).toEqual([]);
    expect(await core.store.forTenant(TENANT_A)).toBeNull();

    core.store.hooks.onOperation = undefined;
    expect(await core.provisionTenant.execute(notice("event-1"))).toBe("provisioned");
  });

  it("provisions each tenant on its own: a tenant stays unknown until its own TenantCreated", async () => {
    const core = createCore();
    await core.provisionTenant.execute(notice("event-1", TENANT_A));
    expect(await core.store.forTenant(TENANT_B)).toBeNull();
    await core.provisionTenant.execute(notice("event-2", TENANT_B));
    expect(await core.store.repositories.tenants.list()).toEqual([TENANT_A, TENANT_B]);
    // A trade of tenant B changes nothing of tenant A.
    await consume(core, tradeExecutedBody({ tenantId: TENANT_B, tradeSequence: 1, yesPriceMicro: 500_000 }));
    expect(core.store.snapshot().tenantData[TENANT_A]?.consumedEvents).toEqual([]);
  });
});
