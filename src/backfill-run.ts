import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { containsNul } from "./adapters/nats/message-handlers.js";
import { readProjectionEvent } from "./domain/consumed.js";
import { TENANT_CREATED_TYPE, readTenantCreated } from "./domain/tenant.js";
import type { ConsumerUseCases } from "./usecases/use-cases.js";

// The loop of `npm run backfill` (README "First deployment"), kept apart from the command so that it is tested
// without a database. Each line of the input is one CloudEvent; it takes the same road as a consumed message.

/** Longer lines are reported and skipped: a CloudEvent of this service's contracts is a few hundred bytes. */
export const MAX_LINE_LENGTH = 1024 * 1024;

/** The most problem lines printed one by one; the counts in the last line stay complete. */
export const MAX_PRINTED_PROBLEMS = 100;

export const EXIT_FAILED = 1;

/**
 * The lines of a file, read as a stream (never whole), so that a path such as /dev/stdin works. The stream is opened when
 * the first line is asked for, not before: a readline interface that is created early and iterated later has already
 * dropped the lines it read in between (the migrations of the command take longer than a small file).
 */
export async function* readLines(file: string): AsyncGenerator<string> {
  const input = createReadStream(file, { encoding: "utf8" });
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) yield line;
  } finally {
    input.destroy();
  }
}

export interface BackfillDeps {
  useCases: ConsumerUseCases;
  /** True: read and classify every line, write nothing. */
  dryRun: boolean;
  print: (line: string) => void;
}

export interface BackfillSummary {
  lines: number;
  /** Count of lines per result; see `resultOf`. */
  results: Record<string, number>;
  exitCode: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type Classified =
  | { kind: "tenant_created"; notice: Parameters<ConsumerUseCases["provisionTenant"]["execute"]>[0] }
  | { kind: "event"; event: Parameters<ConsumerUseCases["recordProjectionEvent"]["execute"]>[0] }
  | { kind: "unattributable"; reason: string };

/** What one line is: a TenantCreated, an event for the projections (or one that is only stored), or nothing a tenant can own. */
export function classifyLine(line: string): Classified {
  if (line.length > MAX_LINE_LENGTH) return { kind: "unattributable", reason: `The line is longer than ${String(MAX_LINE_LENGTH)} characters` };
  let body: unknown;
  try {
    body = JSON.parse(line);
  } catch {
    return { kind: "unattributable", reason: "The line is not JSON" };
  }
  const tenant = readTenantCreated(body);
  if (tenant.kind === "tenant_created") return { kind: "tenant_created", notice: tenant.notice };
  if (isRecord(body) && body["type"] === TENANT_CREATED_TYPE) return { kind: "unattributable", reason: tenant.reason };
  const event = readProjectionEvent(body);
  if (event.kind === "unattributable") return { kind: "unattributable", reason: event.reason };
  // The CloudEvent is stored as jsonb, which refuses the NUL character: the consumer parks such a message at once.
  if (containsNul(body)) return { kind: "unattributable", reason: "The event holds a NUL character, which the jsonb copy in consumed_events cannot store" };
  return { kind: "event", event: { event, raw: body as Record<string, unknown> } };
}

const LIFECYCLE_TYPES = { market_opened: "MarketOpened", market_closed: "MarketClosed", market_resolved: "MarketResolved" } as const;

/**
 * The order-free load needs the version the market had at EACH lifecycle transition (a market's `version` rises by 1 per
 * transition: opened V-2, closed V-1, resolved V for a market now at V). The projection changes a status only for a strictly
 * higher version, so two lifecycle lines of one market that carry the same version (an export that stamped the current
 * version on all three) would give a result that depends on the order of the lines. This remembers, per market, the version
 * of each lifecycle type seen so far in the file and names the clash; the caller reports and skips the later line.
 */
function lifecycleClash(seen: Map<string, Map<string, number>>, event: Extract<Classified, { kind: "event" }>["event"]["event"]): string | null {
  if (event.kind !== "market_opened" && event.kind !== "market_closed" && event.kind !== "market_resolved") return null;
  const key = `${event.tenantId}/${event.facts.marketId}`;
  const versions = seen.get(key) ?? new Map<string, number>();
  seen.set(key, versions);
  for (const [kind, version] of versions) {
    if (kind !== event.kind && version === event.facts.version) {
      return `The lifecycle versions of market ${event.facts.marketId} are not distinct: ${LIFECYCLE_TYPES[kind as keyof typeof LIFECYCLE_TYPES]} and ${LIFECYCLE_TYPES[event.kind]} both carry version ${String(version)}; the export must carry the version the market had at each transition (README "First deployment")`;
    }
  }
  versions.set(event.kind, event.facts.version);
  return null;
}

/**
 * Applies every line of `lines` (blank lines are skipped). The result of a line is what the consumer's use case answers
 * (`provisioned`, `duplicate`, `applied`, `stale`, `unprojected`), `unattributable` (reported with its line number and
 * the reason, and skipped) or `failed` (the use case threw: the line is reported with the error and the run goes on).
 * With `dryRun` nothing is written and the result is the kind of the line (`tenant_created`, `event`, `unattributable`).
 * The exit code is 1 when a line failed; unattributable lines are reported but do not fail the run, since no retry can
 * change them (the publisher's export has to). A lifecycle line that carries the same version as another lifecycle type of
 * the same market earlier in the file is `unattributable` too (`lifecycleClash`). Idempotent: an event id seen before is a
 * `duplicate`.
 */
export async function runBackfill(deps: BackfillDeps, lines: AsyncIterable<string>): Promise<BackfillSummary> {
  const { useCases, dryRun, print } = deps;
  const results: Record<string, number> = {};
  const count = (result: string): void => {
    results[result] = (results[result] ?? 0) + 1;
  };
  let number = 0;
  let problems = 0;
  const problem = (fields: object): void => {
    problems += 1;
    if (problems <= MAX_PRINTED_PROBLEMS) print(JSON.stringify(fields));
  };
  const lifecycleVersions = new Map<string, Map<string, number>>();
  for await (const raw of lines) {
    number += 1;
    const line = raw.trim();
    if (line === "") continue;
    const classified = classifyLine(line);
    if (classified.kind === "unattributable") {
      count("unattributable");
      problem({ line: number, result: "unattributable", reason: classified.reason });
      continue;
    }
    const clash = classified.kind === "event" ? lifecycleClash(lifecycleVersions, classified.event.event) : null;
    if (clash !== null) {
      count("unattributable");
      problem({ line: number, result: "unattributable", reason: clash });
      continue;
    }
    if (dryRun) {
      count(classified.kind);
      continue;
    }
    try {
      count(classified.kind === "tenant_created" ? await useCases.provisionTenant.execute(classified.notice) : await useCases.recordProjectionEvent.execute(classified.event));
    } catch (error) {
      count("failed");
      problem({ line: number, result: "failed", error: messageOf(error) });
    }
  }
  if (problems > MAX_PRINTED_PROBLEMS) print(JSON.stringify({ note: `${String(problems - MAX_PRINTED_PROBLEMS)} more problem lines were not printed` }));
  const summary: BackfillSummary = { lines: number, results, exitCode: (results["failed"] ?? 0) > 0 ? EXIT_FAILED : 0 };
  print(JSON.stringify({ dryRun, lines: summary.lines, results: summary.results }));
  return summary;
}
