// The command line of `replay`, `backfill` and `parked` (README "Commands"): a wrong command line is wrong USE (exit 64 with
// the reason and the usage line), never a failed run (exit 1 is "a tenant failed" or "a line failed"), so a wrapper can tell a
// typo from a failure.

/** Exit code of a command used wrongly: an unknown option, an option without its value, a stray argument, a bad value, no DATABASE_URL. */
export const EXIT_USAGE = 64;

export type CommandLine<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Runs `parse` (a call of `util.parseArgs` with `strict: true`) and turns the errors that function raises for a wrong command
 * line (`ERR_PARSE_ARGS_*`: unknown option, option without its value, unexpected positional) into `{ ok: false, message }`
 * with the usage line appended, to print on stderr before exiting with `EXIT_USAGE`. Any other error is a bug and is thrown on.
 */
export function parseCommandLine<T>(parse: () => T, usage: string): CommandLine<T> {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
    if (error instanceof Error && typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_")) return { ok: false, message: `${error.message}\n${usage}` };
    throw error;
  }
}
