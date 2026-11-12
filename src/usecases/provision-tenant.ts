import type { TenantCreatedNotice } from "../domain/tenant.js";
import type { Clock, Logger, Store } from "./ports.js";
import { TENANT_CREATED_CONSUMER } from "./support.js";
import type { ProvisionResult, ProvisionTenantUseCase } from "./use-cases.js";

/**
 * Handles one TenantCreated event, as markets and trading do: the inbox entry, the tenant's schema with all tenant
 * migrations (projection version 1 active) and the registration commit together or not at all. A redelivered event finds
 * its id in the inbox and changes nothing (DM-06); an error propagates, the consumer naks and the broker redelivers, so a
 * crash between the steps never leaves a half-provisioned tenant. TenantCreated is not a replay input: a missed one is
 * covered by `ensureTenant` when the tenant's first market or trade event arrives.
 */
export class ProvisionTenant implements ProvisionTenantUseCase {
  constructor(private readonly deps: { store: Store; clock: Clock; logger: Logger }) {}

  async execute(notice: TenantCreatedNotice): Promise<ProvisionResult> {
    const { store, clock, logger } = this.deps;
    const now = clock.now();
    const result = await store.transaction(async (repositories): Promise<ProvisionResult> => {
      const fresh = await repositories.inbox.record({
        consumer: TENANT_CREATED_CONSUMER,
        eventId: notice.eventId,
        eventType: notice.eventType,
        processedAt: now,
      });
      if (!fresh) return "duplicate";
      await repositories.tenants.provision(notice.tenantId, now);
      return "provisioned";
    });
    const fields = { tenantId: notice.tenantId, eventId: notice.eventId, correlationId: notice.correlationId };
    if (result === "duplicate") logger.info(fields, "TenantCreated was processed before; nothing changed");
    else logger.info(fields, "Tenant provisioned");
    return result;
  }
}
