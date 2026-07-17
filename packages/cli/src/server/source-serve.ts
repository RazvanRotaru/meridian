/**
 * Serving a line-range slice of a source file so the renderer can show a method's code.
 *
 * Path containment is the whole point: the requested file is resolved under a fixed source root
 * and any `..` (or absolute-path) escape is rejected before a single byte is read — the same
 * check `repository-source.ts` uses on a subdir. Because `web` serves managed repository
 * worktrees, containment is checked on the *canonical* (symlink-resolved) paths — a symlink inside
 * the checkout that points outside it
 * cannot smuggle an external file out. The slice is line-based and exact: review callers fold the
 * unchanged rows client-side, so a response cap here would silently erase a later diff zone.
 * `readSourceSlice` is pure so the containment and slicing rules unit-test without a socket.
 */

import {
  SOURCE_TEXT_MAX_BYTES,
  serializeSourceTextMetadata,
  type SourceTextMetadata,
} from "@meridian/core";
import { isUtf8 } from "node:buffer";
import { constants, readFileSync, realpathSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson } from "./http-response";
import { sourceTextReservationBytes, type SourceTextAdmission } from "./source-text-admission";
import { WebError } from "./web-error";

export interface SourceSlice {
  file: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  code: string;
  truncated: boolean;
}

interface SourceByteSlice extends Omit<SourceSlice, "code"> {
  body: Buffer;
}

interface ResolvedSourceFile {
  path: string;
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface SendSourceOptions {
  admission: SourceTextAdmission;
  signal?: AbortSignal;
}

export async function sendSource(
  response: ServerResponse,
  sourceRoot: string | null,
  query: URLSearchParams,
  options: SendSourceOptions,
): Promise<void> {
  if (sourceRoot === null) {
    sendJson(response, 404, { error: "source not available" });
    return;
  }
  let slice: SourceByteSlice;
  let lease: ReturnType<SourceTextAdmission["tryAcquire"]> = null;
  try {
    const file = requireFile(query.get("file"));
    options.signal?.throwIfAborted();
    const resolved = resolveWithinRoot(sourceRoot, file);
    lease = options.admission.tryAcquire(sourceTextReservationBytes(resolved.size));
    if (lease === null) {
      response.setHeader("retry-after", "1");
      sendJson(response, 503, { error: "source memory budget is busy; retry later" });
      return;
    }
    slice = await readSourceByteSliceAsync(
      resolved,
      file,
      query.get("start"),
      query.get("end"),
      options.signal,
    );
  } catch (error) {
    lease?.release();
    if (options.signal?.aborted) {
      abortResponse(response, options.signal.reason);
      return;
    }
    sendSourceError(response, error);
    return;
  }
  try {
    await sendSourceBytes(response, slice, options.signal);
  } catch (error) {
    if (options.signal?.aborted) {
      abortResponse(response, options.signal.reason);
      return;
    }
    throw error;
  } finally {
    lease.release();
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
  return file;
}

/** Read `file` (resolved under `sourceRoot`) and return the inclusive `start..end` line range. */
export function readSourceSlice(
  sourceRoot: string,
  file: string,
  start: string | null,
  end: string | null,
): SourceSlice {
  const resolved = resolveWithinRoot(sourceRoot, file);
  const slice = sliceSourceBytes(file, readFileSync(resolved.path), start, end);
  return { ...withoutBody(slice), code: slice.body.toString("utf8") };
}

/** Production reads raw bytes asynchronously, scans line boundaries in constant auxiliary memory,
 * and returns a Buffer view unless CRLF normalization requires one bounded output allocation. */
async function readSourceByteSliceAsync(
  resolved: ResolvedSourceFile,
  file: string,
  start: string | null,
  end: string | null,
  signal?: AbortSignal,
): Promise<SourceByteSlice> {
  signal?.throwIfAborted();
  let handle: FileHandle;
  try {
    // The canonical containment check happens before admission. O_NOFOLLOW closes the final-link
    // swap window between that check and opening the inode we actually read.
    handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new WebError(409, "source file changed before it could be read");
  }
  try {
    const before = await handle.stat();
    assertSameSourceFile(before, resolved);
    const source = await readExactSourceFile(handle, resolved.size, signal);
    signal?.throwIfAborted();
    const after = await handle.stat();
    assertSameSourceFile(after, resolved);
    return sliceSourceBytes(file, source, start, end);
  } finally {
    await handle.close();
  }
}

const SOURCE_READ_CHUNK_BYTES = 1024 * 1024;

/** Read only the inode admitted above, into one exact allocation, with bounded cancellation lag. */
async function readExactSourceFile(
  handle: FileHandle,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const source = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    signal?.throwIfAborted();
    const length = Math.min(SOURCE_READ_CHUNK_BYTES, expectedBytes - offset);
    const { bytesRead } = await handle.read(source, offset, length, offset);
    if (bytesRead === 0) throw new WebError(409, "source file changed while it was being read");
    offset += bytesRead;
  }
  signal?.throwIfAborted();
  const overflow = Buffer.allocUnsafe(1);
  const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, expectedBytes);
  if (overflowBytes !== 0) throw new WebError(409, "source file changed while it was being read");
  return source;
}

/** Write a strict v1 source body. No JSON or compatibility shape is accepted by the renderer. */
export async function sendSourceText(
  response: ServerResponse,
  payload: Pick<SourceSlice, "startLine" | "endLine" | "lineCount" | "code" | "truncated">,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const body = Buffer.from(payload.code, "utf8");
  if (body.byteLength > SOURCE_TEXT_MAX_BYTES) {
    throw new WebError(413, "source response exceeds the 32MB display limit");
  }
  await sendSourceBytes(response, { ...payload, body }, signal);
}

async function sendSourceBytes(
  response: ServerResponse,
  payload: Pick<SourceByteSlice, "startLine" | "endLine" | "lineCount" | "body" | "truncated">,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    abortResponse(response, signal.reason);
    return;
  }
  if (payload.body.byteLength > SOURCE_TEXT_MAX_BYTES) {
    throw new WebError(413, "source response exceeds the 32MB display limit");
  }
  const metadata: Omit<SourceTextMetadata, "version"> = {
    startLine: payload.startLine,
    endLine: payload.endLine,
    lineCount: payload.lineCount,
    truncated: payload.truncated,
  };
  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(payload.body.byteLength),
    "cache-control": "no-store",
    ...serializeSourceTextMetadata(metadata),
  });
  await endResponse(response, payload.body, signal);
}

function abortResponse(response: ServerResponse, reason: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.destroy(reason instanceof Error ? reason : undefined);
}

function sliceSourceBytes(
  file: string,
  source: Buffer,
  start: string | null,
  end: string | null,
): SourceByteSlice {
  if (!isUtf8(source)) {
    throw new WebError(415, "source file is not valid UTF-8");
  }
  if (source.byteLength === 0) {
    return { file, startLine: 1, endLine: 0, lineCount: 0, body: Buffer.alloc(0), truncated: false };
  }
  let newlineCount = 0;
  for (const byte of source) {
    if (byte === 0x0a) newlineCount += 1;
  }
  const totalLines = source.at(-1) === 0x0a ? newlineCount : newlineCount + 1;
  const range = clampRange(start, end, totalLines);
  let line = 1;
  let rawStart = 0;
  let rawEnd = source.byteLength;
  for (let index = 0; index < source.byteLength; index += 1) {
    if (source[index] !== 0x0a) continue;
    if (line < range.startLine) rawStart = index + 1;
    if (line === range.endLine) {
      rawEnd = index > rawStart && source[index - 1] === 0x0d ? index - 1 : index;
      break;
    }
    line += 1;
  }
  const body = normalizeCrlf(source.subarray(rawStart, rawEnd));
  return {
    file,
    startLine: range.startLine,
    endLine: range.endLine,
    lineCount: range.endLine - range.startLine + 1,
    body,
    truncated: false,
  };
}

function normalizeCrlf(source: Buffer): Buffer {
  let crlfCount = 0;
  for (let index = 0; index + 1 < source.byteLength; index += 1) {
    if (source[index] === 0x0d && source[index + 1] === 0x0a) crlfCount += 1;
  }
  if (crlfCount === 0) return source;
  const normalized = Buffer.allocUnsafe(source.byteLength - crlfCount);
  let output = 0;
  for (let input = 0; input < source.byteLength; input += 1) {
    if (source[input] === 0x0d && source[input + 1] === 0x0a) continue;
    normalized[output] = source[input]!;
    output += 1;
  }
  return normalized;
}

function withoutBody(slice: SourceByteSlice): Omit<SourceSlice, "code"> {
  return {
    file: slice.file,
    startLine: slice.startLine,
    endLine: slice.endLine,
    lineCount: slice.lineCount,
    truncated: slice.truncated,
  };
}

// Two gates guard the read. The lexical gate rejects a `..`/absolute-path escape up front (400),
// exactly as before. The canonical gate then resolves symlinks with realpathSync — because `web`
// serves untrusted repositories, a link *inside* the checkout can point at an external file, and only the
// real path reveals where the bytes actually live. Both the root and the target are canonicalized
// so the comparison is apples-to-apples.
function resolveWithinRoot(sourceRoot: string, file: string): ResolvedSourceFile {
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
  const stat = statSync(real);
  if (!stat.isFile()) {
    throw new WebError(404, "source file not found");
  }
  // Never synchronously allocate/split an attacker-sized checkout blob. Unlike the historical prefix
  // truncation, this fails explicitly before reading and therefore cannot hide a later diff zone
  // behind a plausible partial document. Ordinary multi-megabyte source remains supported.
  if (stat.size > SOURCE_TEXT_MAX_BYTES) {
    throw new WebError(413, "source file exceeds the 32MB display limit");
  }
  return {
    path: real,
    size: stat.size,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function assertSameSourceFile(
  actual: { isFile(): boolean; size: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number },
  expected: ResolvedSourceFile,
): void {
  if (!actual.isFile()
    || actual.size !== expected.size
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.mtimeMs !== expected.mtimeMs
    || actual.ctimeMs !== expected.ctimeMs) {
    throw new WebError(409, "source file changed while it was being read");
  }
}

// The checkout root may itself sit under a symlink (macOS `/tmp` → `/private/tmp`), so canonicalize it
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

function endResponse(response: ServerResponse, body: Buffer, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolveEnd, rejectEnd) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      response.off("error", onError);
      if (error === undefined) resolveEnd();
      else rejectEnd(error);
    };
    const onError = (error: Error) => finish(error);
    const onAbort = () => {
      response.destroy(signal?.reason instanceof Error ? signal.reason : undefined);
      finish();
    };
    response.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    response.end(body, () => finish());
  });
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
