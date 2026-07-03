/**
 * The `blueprint` entrypoint: build the program, run it, and translate every failure into a
 * stable exit code (0 ok, 1 internal, 2 usage, 3 validation, 4 extractor, 5 I/O, 6 port).
 *
 * `exitOverride` turns commander's own usage failures into throws we catch here, so the
 * exit-code contract lives in exactly one place rather than scattered across commands.
 */

import { CommanderError } from "commander";
import { buildProgram } from "./program";
import { CliError, EXIT } from "./errors";

main();

function main(): void {
  const program = buildProgram();
  program.parseAsync(process.argv).catch(handleError);
}

function handleError(error: unknown): void {
  if (error instanceof CliError) {
    reportCliError(error);
    process.exit(error.exitCode);
  }
  if (error instanceof CommanderError) {
    process.exit(commanderExitCode(error));
  }
  reportUnexpected(error);
  process.exit(EXIT.internal);
}

function reportCliError(error: CliError): void {
  process.stderr.write(`error: ${error.message}\n`);
  for (const line of error.details) {
    process.stderr.write(`${line}\n`);
  }
}

/** Help and version are deliberate, not failures; everything else commander rejects is usage. */
function commanderExitCode(error: CommanderError): number {
  const benign = new Set(["commander.helpDisplayed", "commander.version", "commander.help"]);
  if (error.exitCode === 0 || benign.has(error.code)) {
    return EXIT.ok;
  }
  return EXIT.usage;
}

function reportUnexpected(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`internal error: ${message}\n`);
}
