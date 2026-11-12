import { storedMarketOf } from "../domain/consumed.js";
import { applyToVersion } from "./apply-event.js";
import type { ProjectionObserver, UseCaseDeps } from "./ports.js";
import { consumerOf } from "./support.js";
import type { RecordProjectionEventInput, RecordProjectionEventUseCase, RecordResult } from "./use-cases.js";

/**
 * One message of the MARKETS or the TRADING consumer, in one transaction of its tenant (DM-09, DM-10, ADR-032, ADR-058).
 * The order of the steps is load-bearing:
 * 1. the inbox entry (`market-events` or `trade-events`, by the publisher of the type): a redelivery is "duplicate";
 * 2. consumed_events: EVERY event with a usable envelope is stored, projected or not, so a replay with a fixed or extended
 *    reader recovers what this one could not read; a stored event id is "duplicate" (the inbox is purged after 31 days,
 *    consumed_events never is);
 * 3. an unprojected event stops here ("unprojected"): it takes no projection lock, and a replay skips it the same way;
 * 4. `checkpoints.targets()`: the tenant's projection lock (shared) and the versions to write, read AFTER the append, so
 *    this event either has a position at or below a starting replay's high water mark (the replay applies it) or sees the
 *    new building version (this transaction applies it): never neither, never both unbalanced;
 * 5. the active version, then the building one, through `applyToVersion`, the same code the replay runs (ADR-032: "the same
 *    handlers"). The rules commute (DM-04, DM-10), so a replay racing with this transaction gives the same projection.
 * The tenant comes from a trusted publisher, so `ensureTenant`: TenantNotReady never happens here, and a tenant created
 * before market-data's TENANTS consumer existed is never stuck. An error rolls the whole transaction back (the broker
 * redelivers, the consumer parks the message after 20 deliveries).
 * An optional observer (the metrics) hears the result after the transaction committed, with, for a trade that changed the
 * active version, the trade-sequence gap of its market: the trades below the highest sequence seen that have not arrived.
 */
export class RecordProjectionEvent implements RecordProjectionEventUseCase {
  constructor(private readonly deps: UseCaseDeps & { observer?: ProjectionObserver }) {}

  async execute({ event, raw }: RecordProjectionEventInput): Promise<RecordResult> {
    const { store, clock, logger } = this.deps;
    const tenant = await store.ensureTenant(event.tenantId, clock.now());
    let version: number | null = null;
    const seen: { gap: number | null } = { gap: null };
    const result = await tenant.transaction(async (repositories): Promise<RecordResult> => {
      const now = clock.now();
      seen.gap = null; // a transaction that runs again starts over
      const fresh = await repositories.inbox.record({ consumer: consumerOf(event), eventId: event.eventId, eventType: event.eventType, processedAt: now });
      if (!fresh) return "duplicate";
      const position = await repositories.consumedEvents.append({ eventId: event.eventId, eventType: event.eventType, marketId: storedMarketOf(event), event: raw, receivedAt: now });
      if (position === null) return "duplicate";
      if (event.kind === "unprojected") return "unprojected";

      const targets = await repositories.checkpoints.targets();
      version = targets.active;
      const active = await applyToVersion(repositories.projections, targets.active, event, now, (summary) => {
        if (event.kind === "trade_executed") seen.gap = summary.lastTradeSequence - summary.tradeCount;
      });
      if (targets.building !== null) await applyToVersion(repositories.projections, targets.building, event, now);
      return active === "stale" ? "stale" : "applied";
    });

    this.deps.observer?.recorded(result, seen.gap);

    const fields = { tenantId: event.tenantId, marketId: storedMarketOf(event), eventId: event.eventId, version, result };
    // A stored event of a projected type that this reader could not read is worth a warning: a replay after a fix recovers
    // it. Another type (MarketCreated and the like) is normal and not logged: the stored row is its record.
    if (event.kind === "unprojected") {
      if (event.cause === "unreadable" && result === "unprojected") logger.warn({ ...fields, reason: event.reason }, "Event stored but not projected: this reader cannot read it");
    } else {
      logger.info(fields, "Projection event processed");
    }
    return result;
  }
}
