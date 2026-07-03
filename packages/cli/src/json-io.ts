/**
 * Reading and writing JSON files with CLI-shaped failures.
 *
 * Writes are atomic (temp file then rename) so a crash mid-write never leaves a truncated
 * artifact a later `view` would try to parse. Every I/O fault maps to the `io` exit code.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { CliError, EXIT } from "./errors";

export function readJsonFile(path: string): unknown {
  const text = readFileText(path);
  return parseJson(text, path);
}

function readFileText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new CliError(EXIT.io, `cannot read ${path}: ${describe(cause)}`);
  }
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new CliError(EXIT.io, `cannot parse ${path} as JSON: ${describe(cause)}`);
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    writeFileSync(temporaryPath, text, "utf8");
    renameSync(temporaryPath, path);
  } catch (cause) {
    throw new CliError(EXIT.io, `cannot write ${path}: ${describe(cause)}`);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
