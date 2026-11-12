import { UseCaseError } from "./usecases/errors.js";
import { MAX_REPLAY_BATCH_SIZE } from "./usecases/support.js";
import type { Store } from "./usecases/ports.js";
import type { ReplayProjectionsUseCase } from "./usecases/use-cases.js";

// The loop of `npm run replay` (DM-09, REQ-12), kept apart from the command so that it is tested without a database.

/** Exit codes of the command: 0 all switched (or status printed), 1 a tenant failed, 2 none failed but one was held, 64 wrong use (EXIT_USAGE of command-line.ts). */
export const EXIT_FAILED = 1;
export const EXIT_HELD = 2;

export interface ReplayCommand {
  tenant: string | null;
  batchSize: number | undefined;
  keepOld: boolean;
  allowUnreadable: boolean;
  status: boolean;
}

export const REPLAY_USAGE = "Usage: replay [--tenant <tenantId>] [--batch-size <1-" + String(MAX_REPLAY_BATCH_SIZE) + ">] [--keep-old] [--allow-unreadable] [--status]";

/** The options of `parseArgs` the command accepts. */
export const REPLAY_OPTIONS = {
  tenant: { type: "string" },
  "batch-size": { type: "string" },
  "keep-old": { type: "boolean", default: false },
  "allow-unreadable": { type: "boolean", default: false },
  status: { type: "boolean", default: false },
} as const;

type ReplayValues = { [K in keyof typeof REPLAY_OPTIONS]?: string | boolean | undefined };

/** The command from parsed options, or the reason the options are wrong (the batch size is checked here, the rest by the use case). */
export function replayCommandOf(values: ReplayValues): ReplayCommand | string {
  let batchSize: number | undefined;
  const rawBatch = values["batch-size"];
  if (typeof rawBatch === "string") {
    batchSize = /^[0-9]{1,6}$/.test(rawBatch) ? Number(rawBatch) : Number.NaN;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_REPLAY_BATCH_SIZE) return `--batch-size must be an integer from 1 to ${String(MAX_REPLAY_BATCH_SIZE)}`;
  }
  const tenant = values.tenant;
  return {
    tenant: typeof tenant === "string" && tenant.trim() !== "" ? tenant.trim() : null,
    batchSize,
    keepOld: values["keep-old"] === true,
    allowUnreadable: values["allow-unreadable"] === true,
    status: values.status === true,
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface ReplayRunDeps {
  store: Store;
  replay: ReplayProjectionsUseCase;
  /** One JSON line of the report per tenant. */
  print: (line: string) => void;
  /** Notes for the operator that are not reports. */
  note: (line: string) => void;
}

/**
 * `--status`: the checkpoints and the row counts of every version of each tenant, changing nothing. Otherwise: replays each
 * tenant in turn (the rows of its consumed_events into a new projection version, then the switch) and prints the
 * ReplayReport as one JSON line. A tenant that fails (not registered, the database refuses) is reported and the next
 * one still runs, so one bad tenant never hides the others. Returns the exit code.
 */
export async function runReplay(deps: ReplayRunDeps, command: ReplayCommand): Promise<number> {
  const { store, replay, print, note } = deps;
  const tenants = command.tenant === null ? await store.repositories.tenants.list() : [command.tenant];
  if (tenants.length === 0) note("No tenant is registered.");
  let failed = 0;
  let held = 0;
  for (const tenantId of tenants) {
    try {
      if (command.status) {
        print(JSON.stringify(await statusOf(store, tenantId)));
        continue;
      }
      const report = await replay.execute({
        tenantId,
        ...(command.batchSize === undefined ? {} : { batchSize: command.batchSize }),
        keepOld: command.keepOld,
        allowUnreadable: command.allowUnreadable,
      });
      print(JSON.stringify(report));
      if (report.outcome === "held") held += 1;
    } catch (error) {
      failed += 1;
      // A use case's refusal carries a code and the fields it refused; the operator needs both.
      const reason = error instanceof UseCaseError ? { code: error.code, ...(error.fields.length > 0 ? { fields: error.fields } : {}) } : {};
      print(JSON.stringify({ tenantId, outcome: "failed", error: messageOf(error), ...reason }));
    }
  }
  if (failed > 0) return EXIT_FAILED;
  return held > 0 ? EXIT_HELD : 0;
}

/** The checkpoints of a tenant with the row counts of each version. */
async function statusOf(store: Store, tenantId: string): Promise<{ tenantId: string; versions: object[] }> {
  const tenant = await store.forTenant(tenantId);
  if (tenant === null) throw new Error("The tenant is not registered");
  const checkpoints = await tenant.repositories.checkpoints.list();
  const versions: object[] = [];
  for (const checkpoint of checkpoints) {
    const rows = await tenant.repositories.projections.countVersion(checkpoint.version);
    versions.push({ ...checkpoint, summaries: rows.summaries, points: rows.points });
  }
  return { tenantId, versions };
}
