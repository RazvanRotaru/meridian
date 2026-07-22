/**
 * Serving a line-range slice of a source file so the renderer can show a method's code.
 *
 * Path containment is the whole point: the requested file is resolved under a fixed source root
 * and any `..` (or absolute-path) escape is rejected before a single byte is read — the same
 * check `clone.ts` uses on a subdir. Because `web` clones arbitrary repos, containment is checked
 * on the *canonical* (symlink-resolved) paths — a symlink inside the clone that points outside it
 * cannot smuggle an external file out. The slice is line-based and exact: review callers fold the
 * unchanged rows client-side, so a response cap here would silently erase a later diff zone.
 * `readSourceSlice` is pure so the containment and slicing rules unit-test without a socket.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson } from "./http-response";
import { WebError } from "./web-error";

const SOURCE_FILE_MAX_BYTES = 32 * 1024 * 1024;

export interface SourceSlice {
  file: string;
  startLine: number;
  endLine: number;
  lineCount: number;
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
  // Git permits leading/trailing whitespace (and even an all-space basename). Presence, not a
  // normalized spelling, is the API boundary; containment below handles hostile path syntax.
  if (file === null || file.length === 0) {
    throw new WebError(400, "file query parameter is required");
  }
  // A linked Git worktree stores `.git` as a regular text file containing the absolute path to
  // shared administrative state. It is never repository source and must not cross the API boundary.
  if (isGitAdministrativePath(file)) {
    throw new WebError(404, "source file not found");
  }
  return file;
}

export function isGitAdministrativePath(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return file.split(/[\\/]/).some((rawComponent) => {
    let component = rawComponent;
    if (platform === "win32") {
      // Win32 aliases trailing dots/spaces and NTFS alternate streams to the same filesystem entry.
      component = component.split(":", 1)[0]!.replace(/[. ]+$/g, "");
    }
    return component.toLowerCase() === ".git";
  });
}

/** Read `file` (resolved under `sourceRoot`) and return the inclusive `start..end` line range. */
export function readSourceSlice(
  sourceRoot: string,
  file: string,
  start: string | null,
  end: string | null,
): SourceSlice {
  const sourceFile = requireFile(file);
  const lines = readSourceLines(resolveWithinRoot(sourceRoot, sourceFile));
  if (lines.length === 0) {
    return { file: sourceFile, startLine: 1, endLine: 0, lineCount: 0, code: "", truncated: false };
  }
  const range = clampRange(start, end, lines.length);
  const requested = lines.slice(range.startLine - 1, range.endLine);
  return {
    file: sourceFile,
    startLine: range.startLine,
    endLine: range.startLine - 1 + requested.length,
    lineCount: requested.length,
    code: requested.join("\n"),
    truncated: false,
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
  // The request spelling was checked above, but a repository-controlled symlink can give an
  // innocuous name to the checkout's `.git` file/directory. Re-check the canonical target relative
  // to the canonical source root so Git administration never crosses the source API boundary.
  if (isGitAdministrativePath(relative(root, real))) {
    throw new WebError(404, "source file not found");
  }
  const stat = statSync(real);
  if (!stat.isFile()) {
    throw new WebError(404, "source file not found");
  }
  // Never synchronously allocate/split an attacker-sized clone blob. Unlike the historical prefix
  // truncation, this fails explicitly before reading and therefore cannot hide a later diff zone
  // behind a plausible partial document. Ordinary multi-megabyte source remains supported.
  if (stat.size > SOURCE_FILE_MAX_BYTES) {
    throw new WebError(413, "source file exceeds the 32MB display limit");
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

// Read the complete file before applying the response cap to the requested range. Capping the file
// prefix would make a valid node near the end of a large file look empty (or, worse, like another
// line), while the endpoint contract is specifically a line-addressed slice.
function readSourceLines(path: string): string[] {
  const source = readFileSync(path, "utf8");
  if (source.length === 0) return [];
  const lines = source.split(/\r?\n/);
  // Splitting a complete newline-terminated file leaves an empty sentinel that is not a source
  // row. Remove exactly that sentinel, so a second terminal newline still represents a blank line.
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
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
