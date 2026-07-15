/**
 * Strict client transport for POST /api/pr/prepare.
 *
 * The request identifies a repository and revision pair directly. The v1 NDJSON response returns
 * immutable endpoints for bounded HEAD and merge-base projections; no browser-session graph id or
 * complete-artifact compatibility path is accepted here.
 */

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 100_000;
const MAX_PROJECTION_FILE_PATHS = 512;
const MAX_PATH_LENGTH = 4_096;
const MAX_TIMINGS = 256;
const MAX_WARNINGS = 256;
const MAX_WARNING_LENGTH = 4_096;

export type PrPrepareStage = "resolve" | "git" | "extract-head" | "extract-merge-base" | "publish";

export interface PrPrepareRequest {
  owner: string;
  repo: string;
  subdir?: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
}

export interface PreparedGraphSummary {
  schemaVersion: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
}

export interface PreparedGraphDescriptor {
  graphId: string;
  manifestUrl: string;
  projectionUrl: string;
  sourceUrl: string;
  metaUrl: string;
  graphSummary: PreparedGraphSummary;
}

export type PreparedChangedFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface PreparedChangedFile {
  path: string;
  status: PreparedChangedFileStatus;
  previousPath?: string;
}

export interface PrPreparationResult {
  head: PreparedGraphDescriptor;
  mergeBase: PreparedGraphDescriptor;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  changedFiles: PreparedChangedFile[];
  cache: "hit" | "miss";
  timings: Record<string, number>;
  warnings: string[];
}

export async function streamPrPreparation(
  prepareUrl: string,
  request: PrPrepareRequest,
  onStage: (stage: PrPrepareStage, elapsedMs: number) => void,
  signal?: AbortSignal,
): Promise<PrPreparationResult> {
  const response = await postPreparation(prepareUrl, canonicalRequest(request), signal);
  return drainPreparationStream(response, onStage);
}

/** Canonical changed paths sent to both review projections. Renames address both tree locations. */
export function changedFileProjectionPaths(files: readonly PreparedChangedFile[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file.path);
    if (file.status === "renamed") paths.add(file.previousPath!);
  }
  if (paths.size > MAX_PROJECTION_FILE_PATHS) {
    throw new Error(
      `This pull request changes ${paths.size} paths; narrow the inspected subdirectory to at most ${MAX_PROJECTION_FILE_PATHS} paths.`,
    );
  }
  return [...paths].sort();
}

async function postPreparation(
  prepareUrl: string,
  request: PrPrepareRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(new URL(prepareUrl, requestOrigin()), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(await requestErrorMessage(response));
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-ndjson") {
    throw new Error("invalid PR preparation response: expected application/x-ndjson");
  }
  return response;
}

async function drainPreparationStream(
  response: Response,
  onStage: (stage: PrPrepareStage, elapsedMs: number) => void,
): Promise<PrPreparationResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: PrPreparationResult | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (utf8ByteLength(buffer) > MAX_LINE_BYTES && !buffer.includes("\n")) {
        throw new Error("invalid PR preparation stream: NDJSON line is too large");
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        assertLineSize(line);
        result = applyLine(line.trim(), onStage, result);
      }
    }
    buffer += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  assertLineSize(buffer);
  result = applyLine(buffer.trim(), onStage, result);
  if (result === null) throw new Error("PR preparation ended without a v1 done line.");
  return result;
}

function applyLine(
  line: string,
  onStage: (stage: PrPrepareStage, elapsedMs: number) => void,
  result: PrPreparationResult | null,
): PrPreparationResult | null {
  if (line.length === 0) return result;
  if (result !== null) throw new Error("invalid PR preparation stream: data followed the done line");
  const parsed = parseLine(line);
  if (parsed.type === "progress") {
    onStage(parsed.stage, parsed.elapsedMs);
    return null;
  }
  if (parsed.type === "error") throw new Error(parsed.message);
  return parsed.result;
}

type ParsedLine =
  | { type: "progress"; stage: PrPrepareStage; elapsedMs: number }
  | { type: "done"; result: PrPreparationResult }
  | { type: "error"; message: string };

function parseLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("invalid PR preparation stream: expected NDJSON");
  }
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) {
    throw new Error("invalid PR preparation stream: expected protocol version 1");
  }
  if (value.type === "progress") {
    const stage = prepareStage(value.stage);
    const elapsedMs = nonNegativeFinite(value.elapsedMs, "progress.elapsedMs");
    return { type: "progress", stage, elapsedMs };
  }
  if (value.type === "done") return { type: "done", result: parseDoneLine(value) };
  if (value.type === "error") {
    return { type: "error", message: requiredString(value.message, "error.message") };
  }
  throw new Error("invalid PR preparation stream: unsupported v1 line type");
}

function parseDoneLine(line: Record<string, unknown>): PrPreparationResult {
  return {
    head: parseGraphDescriptor(line.head, "head"),
    mergeBase: parseGraphDescriptor(line.mergeBase, "mergeBase"),
    headSha: commitSha(line.headSha, "headSha"),
    baseSha: commitSha(line.baseSha, "baseSha"),
    mergeBaseSha: commitSha(line.mergeBaseSha, "mergeBaseSha"),
    changedFiles: parseChangedFiles(line.changedFiles),
    cache: cacheResult(line.cache),
    timings: parseTimings(line.timings),
    warnings: parseWarnings(line.warnings),
  };
}

function parseGraphDescriptor(value: unknown, label: string): PreparedGraphDescriptor {
  if (!isRecord(value)) throw invalidDone(`${label} descriptor`);
  if (!isRecord(value.graphSummary)) throw invalidDone(`${label}.graphSummary`);
  return {
    graphId: requiredString(value.graphId, `${label}.graphId`),
    manifestUrl: requiredString(value.manifestUrl, `${label}.manifestUrl`),
    projectionUrl: requiredString(value.projectionUrl, `${label}.projectionUrl`),
    sourceUrl: requiredString(value.sourceUrl, `${label}.sourceUrl`),
    metaUrl: requiredString(value.metaUrl, `${label}.metaUrl`),
    graphSummary: {
      schemaVersion: requiredString(value.graphSummary.schemaVersion, `${label}.graphSummary.schemaVersion`),
      generatedAt: requiredString(value.graphSummary.generatedAt, `${label}.graphSummary.generatedAt`),
      nodeCount: nonNegativeInteger(value.graphSummary.nodeCount, `${label}.graphSummary.nodeCount`),
      edgeCount: nonNegativeInteger(value.graphSummary.edgeCount, `${label}.graphSummary.edgeCount`),
    },
  };
}

function parseChangedFiles(value: unknown): PreparedChangedFile[] {
  if (!Array.isArray(value) || value.length > MAX_CHANGED_FILES) throw invalidDone("changedFiles");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw invalidDone(`changedFiles[${index}]`);
    const path = safeRelativePath(entry.path, `changedFiles[${index}].path`);
    if (seen.has(path)) throw invalidDone(`changedFiles[${index}].path is duplicated`);
    seen.add(path);
    const status = changedFileStatus(entry.status, `changedFiles[${index}].status`);
    const hasPreviousPath = Object.prototype.hasOwnProperty.call(entry, "previousPath");
    if (status === "renamed") {
      if (!hasPreviousPath) throw invalidDone(`changedFiles[${index}].previousPath`);
      const previousPath = safeRelativePath(entry.previousPath, `changedFiles[${index}].previousPath`);
      if (previousPath === path) throw invalidDone(`changedFiles[${index}].previousPath matches path`);
      return {
        path,
        status,
        previousPath,
      };
    }
    if (hasPreviousPath) throw invalidDone(`changedFiles[${index}].previousPath is only valid for renamed files`);
    return { path, status };
  });
}

function parseTimings(value: unknown): Record<string, number> {
  if (!isRecord(value) || Object.keys(value).length > MAX_TIMINGS) throw invalidDone("timings");
  const result: Record<string, number> = {};
  for (const [key, timing] of Object.entries(value)) {
    if (key.length === 0 || key.length > 128) throw invalidDone("timings key");
    result[key] = nonNegativeFinite(timing, `timings.${key}`);
  }
  return result;
}

function parseWarnings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_WARNINGS) throw invalidDone("warnings");
  return value.map((warning, index) => {
    const parsed = requiredString(warning, `warnings[${index}]`);
    if (parsed.length > MAX_WARNING_LENGTH) throw invalidDone(`warnings[${index}]`);
    return parsed;
  });
}

function canonicalRequest(request: PrPrepareRequest): PrPrepareRequest {
  const owner = requiredRequestString(request.owner, "owner");
  const repo = requiredRequestString(request.repo, "repo");
  const baseRef = requiredRequestString(request.baseRef, "baseRef");
  const headRef = requiredRequestString(request.headRef, "headRef");
  if (!Number.isSafeInteger(request.prNumber) || request.prNumber <= 0) {
    throw new TypeError("prNumber must be a positive safe integer");
  }
  const subdir = request.subdir === undefined ? undefined : safeSubdir(request.subdir);
  return { owner, repo, ...(subdir === undefined ? {} : { subdir }), prNumber: request.prNumber, baseRef, headRef };
}

function safeSubdir(value: string): string {
  const subdir = requiredRequestString(value, "subdir");
  safeRelativePath(subdir, "subdir");
  return subdir;
}

function safeRelativePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (path.length > MAX_PATH_LENGTH || path.includes("\\") || path.includes("\0") || path.startsWith("/")
    || /^[A-Za-z]:/.test(path)) {
    throw invalidDone(label);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw invalidDone(label);
  }
  return path;
}

function prepareStage(value: unknown): PrPrepareStage {
  if (value === "resolve" || value === "git" || value === "extract-head"
    || value === "extract-merge-base" || value === "publish") return value;
  throw new Error("invalid PR preparation stream: progress.stage");
}

function changedFileStatus(value: unknown, label: string): PreparedChangedFileStatus {
  if (value === "added" || value === "modified" || value === "deleted" || value === "renamed") return value;
  throw invalidDone(label);
}

function cacheResult(value: unknown): "hit" | "miss" {
  if (value === "hit" || value === "miss") return value;
  throw invalidDone("cache");
}

function requiredRequestString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value.trim();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalidDone(label);
  return value;
}

function commitSha(value: unknown, label: string): string {
  const sha = requiredString(value, label);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) throw invalidDone(label);
  return sha.toLowerCase();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalidDone(label);
  return Number(value);
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalidDone(label);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidDone(field: string): Error {
  return new Error(`invalid PR preparation done line: ${field}`);
}

function assertLineSize(line: string): void {
  if (utf8ByteLength(line) > MAX_LINE_BYTES) {
    throw new Error("invalid PR preparation stream: NDJSON line is too large");
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function requestErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json() as { error?: unknown };
    if (typeof data.error === "string" && data.error.length > 0) return data.error;
  } catch {
    // Non-JSON response: use the bounded generic message below.
  }
  return `PR preparation request failed (${response.status}).`;
}

function requestOrigin(): string {
  return typeof window === "undefined" ? "http://meridian.local" : window.location.origin;
}
