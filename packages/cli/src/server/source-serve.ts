/**
 * Serving a line-range slice of a source file so the renderer can show a method's code.
 *
 * Path containment is the whole point: the requested file is resolved under a fixed source root
 * and any `..` (or absolute-path) escape is rejected before a single byte is read — the same
 * check `clone.ts` uses on a subdir. Because `web` clones arbitrary repos, containment is checked
 * on the *canonical* (symlink-resolved) paths — a symlink inside the clone that points outside it
 * cannot smuggle an external file out. The slice is line-based and doubly capped (file bytes and
 * returned lines) so a huge file can never blow up a response. `readSourceSlice` is pure so the
 * containment and slicing rules unit-test without a socket.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson } from "./http-response";
import { WebError } from "./web-error";

const MAX_FILE_BYTES = 2_000_000;
const MAX_SLICE_LINES = 2000;

export interface SourceSlice {
  file: string;
  startLine: number;
  endLine: number;
  code: string;
  truncated: boolean;
}

export function sendSource(response: ServerResponse, sourceRoot: string | null, query: URLSearchParams): void {
  if (sourceRoot === null) {
    sendJson(response, 404, { error: "source not available" });
    return;
  }
  try {
    const file = requireFile(query.get("file"));
    sendJson(response, 200, readSourceSlice(sourceRoot, file, query.get("start"), query.get("end")));
  } catch (error) {
    sendSourceError(response, error);
  }
}

function sendSourceError(response: ServerResponse, error: unknown): void {
  if (error instanceof WebError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  sendJson(response, 500, { error: "failed to read source" });
}

function requireFile(file: string | null): string {
  const trimmed = file?.trim();
  if (!trimmed) {
    throw new WebError(400, "file query parameter is required");
  }
  return trimmed;
}

/** Read `file` (resolved under `sourceRoot`) and return the inclusive `start..end` line range. */
export function readSourceSlice(
  sourceRoot: string,
  file: string,
  start: string | null,
  end: string | null,
): SourceSlice {
  const lines = readCappedLines(resolveWithinRoot(sourceRoot, file));
  const range = clampRange(start, end, lines.length);
  const requested = lines.slice(range.startLine - 1, range.endLine);
  const truncated = requested.length > MAX_SLICE_LINES;
  const slice = truncated ? requested.slice(0, MAX_SLICE_LINES) : requested;
  return {
    file,
    startLine: range.startLine,
    endLine: range.startLine - 1 + slice.length,
    code: slice.join("\n"),
    truncated,
  };
}

// Two gates guard the read. The lexical gate rejects a `..`/absolute-path escape up front (400),
// exactly as before. The canonical gate then resolves symlinks with realpathSync — because `web`
// clones untrusted repos, a link *inside* the clone can point at an external file, and only the
// real path reveals where the bytes actually live. Both the root and the target are canonicalized
// so the comparison is apples-to-apples.
function resolveWithinRoot(sourceRoot: string, file: string): string {
  const root = canonicalRoot(sourceRoot);
  const candidate = resolve(root, file);
  assertWithinRoot(candidate, root); // lexical gate: `..`/absolute escapes never reach the disk
  let real: string;
  try {
    real = realpathSync(candidate); // follows symlinks; throws if the path is missing
  } catch {
    throw new WebError(404, "source file not found");
  }
  assertWithinRoot(real, root); // canonical gate: a symlink cannot smuggle a file out of the root
  if (!statSync(real).isFile()) {
    throw new WebError(404, "source file not found");
  }
  return real;
}

// The clone root may itself sit under a symlink (macOS `/tmp` → `/private/tmp`), so canonicalize it
// once; a root that doesn't exist degrades to a clean 404 rather than an uncaught realpath throw.
function canonicalRoot(sourceRoot: string): string {
  try {
    return realpathSync(resolve(sourceRoot));
  } catch {
    throw new WebError(404, "source not available");
  }
}

function assertWithinRoot(path: string, root: string): void {
  if (path !== root && !path.startsWith(root + sep)) {
    throw new WebError(400, "source path escapes the source root");
  }
}

// Cap the bytes read so a pathologically large file cannot be pulled whole into a response.
function readCappedLines(path: string): string[] {
  const bytes = readFileSync(path);
  const capped = bytes.length > MAX_FILE_BYTES ? bytes.subarray(0, MAX_FILE_BYTES) : bytes;
  return capped.toString("utf8").split("\n");
}

// Missing/NaN bounds default to the whole file; the range is then confined to 1..totalLines with
// end never below start, so callers can pass a method's raw span without producing an empty slice.
function clampRange(start: string | null, end: string | null, totalLines: number): { startLine: number; endLine: number } {
  const startLine = confine(parseLine(start, 1), 1, totalLines);
  const endLine = confine(parseLine(end, totalLines), startLine, totalLines);
  return { startLine, endLine };
}

function parseLine(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function confine(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
