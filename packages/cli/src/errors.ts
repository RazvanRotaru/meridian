/**
 * The CLI's exit-code vocabulary and the carrier error that maps a failure to one.
 *
 * Every command throws `CliError` with the appropriate code; the top-level handler in
 * `bin.ts` reads `exitCode` and terminates. Keeping the numbers here (not scattered as
 * literals) makes the contract auditable in one place.
 */

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  validation: 3,
  extractor: 4,
  io: 5,
  portBind: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly exitCode: ExitCode;
  /** Extra lines (e.g. validation issues) printed under the headline message. */
  readonly details: string[];

  constructor(exitCode: ExitCode, message: string, details: string[] = []) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}
