import type { FastifyInstance } from "fastify";
import { TENANT_CREATED_TYPE, readTenantCreated } from "../../domain/tenant.js";
import { readProjectionEvent } from "../../domain/consumed.js";
import { ValidationFailed } from "../../usecases/errors.js";
import type { ConsumerUseCases } from "../../usecases/use-cases.js";
import type { RequestHook } from "../auth.js";
import { schemas } from "../schemas.js";

const rejected = (reason: string) => new ValidationFailed([{ field: "event", message: reason }], `The event is not accepted: ${reason}`);

/**
 * Local mode only (APP_ENV=local without NATS, where no consumer runs): `POST /local/events` takes one CloudEvent and
 * runs it through the use case of its consumer (TenantCreated: ProvisionTenant; a market or trade event, or any other
 * type of the MARKETS and TRADING streams: RecordProjectionEvent with the body as received), so a developer can drive the
 * whole flow with curl. The path is outside /v1, so the gateway never routes it, and it is not in contracts/openapi.yaml:
 * it is never deployed. Any valid bearer token may call it (it is a development tool, and the tenant comes from the
 * event). A consumer would park an event without a usable envelope after a warning; here the caller is told why it was
 * refused (400).
 */
export function registerLocalEventRoutes(app: FastifyInstance, local: ConsumerUseCases, authenticate: RequestHook): void {
  app.post<{ Body: Record<string, unknown> }>("/local/events", { schema: schemas.localEvent, onRequest: authenticate }, async (request) => {
    const body = request.body;
    if (body["type"] === TENANT_CREATED_TYPE) {
      const read = readTenantCreated(body);
      if (read.kind === "ignored") throw rejected(read.reason);
      return { result: await local.provisionTenant.execute(read.notice) };
    }
    const read = readProjectionEvent(body);
    if (read.kind === "unattributable") throw rejected(read.reason);
    return { result: await local.recordProjectionEvent.execute({ event: read, raw: body }) };
  });
}
