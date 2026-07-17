/**
 * Strict client transport for POST /api/pr/prepare.
 *
 * The request identifies a repository and revision pair directly. The v1 NDJSON response returns
 * immutable endpoints for bounded HEAD and merge-base projections; no browser-session graph id or
 * complete-artifact compatibility path is accepted here.
 */

import {
  PR_PREPARE_MAX_LINE_BYTES,
  PR_PREPARE_PROTOCOL_VERSION,
  PR_PREPARE_STAGES,
  PR_PREPARE_V1_FIELDS,
  compareCanonicalPrPreparePaths,
  hasExactPrPrepareFields,
  isPrPrepareElapsedMs,
  isPrPrepareStage,
  normalizePrPrepareChangedFiles,
  normalizePrPrepareTimings,
  normalizePrPrepareWarnings,
  type PrPrepareStage,
  type PrPrepareTimings,
} from "@meridian/core";

const MAX_PATH_LENGTH = 4_096;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

export type { PrPrepareStage } from "@meridian/core";

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
  searchUrl: string;
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

export interface PreparedReviewPair {
  head: PreparedGraphDescriptor;
  mergeBase: PreparedGraphDescriptor;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  changedFiles: PreparedChangedFile[];
  cache: "hit" | "miss";
  timings: PrPrepareTimings;
  warnings: string[];
}

export interface PreparedReviewHandoffLink {
  id: string;
  url: string;
  viewUrl: string;
}

export interface PrPreparationResult extends PreparedReviewPair {
  handoff: PreparedReviewHandoffLink;
}

export interface PreparedReviewHandoff extends PreparedReviewPair {
  request: PrPrepareRequest;
}

/** Read one immutable, server-validated review handoff. This is deliberately a separate JSON
 * contract from the streaming POST: a shared review URL must either consume this exact v1 pair or
 * fail closed; it may never silently start a second preparation job. */
export async function fetchPreparedReviewHandoff(
  preparedReviewUrl: string,
  signal?: AbortSignal,
): Promise<PreparedReviewHandoff> {
  const response = await fetch(new URL(preparedReviewUrl, requestOrigin()), {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(await handoffErrorMessage(response));
  const contentType = responseMediaType(response);
  if (contentType !== "application/json") {
    await cancelResponseBody(response, "prepared review handoff content type is invalid");
    throw new Error("invalid prepared review handoff: expected application/json");
  }
  const body = await readBoundedTextResponse(
    response,
    PR_PREPARE_MAX_LINE_BYTES,
    "prepared review handoff",
  );
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("invalid prepared review handoff: expected JSON");
  }
  if (!isRecord(value) || value.version !== PR_PREPARE_PROTOCOL_VERSION) {
    throw new Error("invalid prepared review handoff: expected protocol version 1");
  }
  if (!hasExactPrPrepareFields(value, PR_PREPARE_V1_FIELDS.handoffDocument)) {
    throw new Error("invalid prepared review handoff: fields do not match protocol version 1");
  }
  return { request: parseHandoffRequest(value.request), ...parsePreparedPair(value) };
}

export async function streamPrPreparation(
  prepareUrl: string,
  request: PrPrepareRequest,
  onStage: (stage: PrPrepareStage, elapsedMs: number) => void,
  signal?: AbortSignal,
): Promise<PrPreparationResult> {
  const canonical = canonicalRequest(request);
  const response = await postPreparation(prepareUrl, canonical, signal);
  const result = await drainPreparationStream(response, onStage);
  const view = new URL(result.handoff.viewUrl, "http://meridian.local");
  if (view.searchParams.get("prn") !== String(canonical.prNumber)) {
    throw invalidDone("handoff.viewUrl PR number");
  }
  return result;
}

/** Opaque coordinate for one canonical handoff entry; no path is replayed to graph transport. */
export function preparedReviewFileCursor(
  files: readonly PreparedChangedFile[],
  path?: string,
): string | null {
  if (path === undefined || files.length === 0) return null;
  const index = files.findIndex((file) => file.path === path);
  if (index < 0) return null;
  return `file:${index}`;
}

/** Resolve one opaque prepared-review coordinate back to its canonical manifest entry. The cursor
 * grammar is intentionally strict: coordinates are immutable protocol identities, not user input
 * to coerce or partially parse. */
export function preparedReviewFileForCursor(
  files: readonly PreparedChangedFile[],
  cursor: string | null,
): PreparedChangedFile | null {
  if (cursor === null) return null;
  const match = /^file:(0|[1-9]\d*)$/.exec(cursor);
  if (match === null) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? files[index] ?? null : null;
}

/** Carry the currently inspected semantic file into a refreshed canonical manifest. Exact current
 * paths win. A rename is followed only through one unique current/previous-path match; ambiguity or
 * disappearance deliberately falls back to the source-only overview. */
export function remapPreparedReviewFilePath(
  previousFiles: readonly PreparedChangedFile[],
  previousCursor: string | null,
  nextFiles: readonly PreparedChangedFile[],
): string | null {
  const previous = preparedReviewFileForCursor(previousFiles, previousCursor);
  if (previous === null) return null;
  const exact = nextFiles.find((file) => file.path === previous.path);
  if (exact !== undefined) return exact.path;

  const aliases = new Set([previous.path, previous.previousPath].filter((path): path is string => path !== undefined));
  const renamed = nextFiles.filter((file) => file.status === "renamed"
    && file.previousPath !== undefined
    && aliases.has(file.previousPath));
  if (renamed.length === 1) return renamed[0]!.path;

  // A later manifest can describe the same file after rename metadata has collapsed back to a
  // normal modified/deleted row. Accept the old-side alias only when it identifies one unique row.
  if (previous.previousPath !== undefined) {
    const priorPath = nextFiles.filter((file) => file.path === previous.previousPath);
    if (priorPath.length === 1) return priorPath[0]!.path;
  }
  return null;
}

/** Sum only protocol-defined stages; an empty timing record means no elapsed observation exists. */
export function totalPrPrepareElapsedMs(timings: PrPrepareTimings): number | null {
  let total = 0;
  let observed = false;
  for (const stage of PR_PREPARE_STAGES) {
    const elapsedMs = timings[stage];
    if (elapsedMs === undefined) continue;
    observed = true;
    total += elapsedMs;
  }
  return observed ? total : null;
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
  const contentType = responseMediaType(response);
  if (contentType !== "application/x-ndjson") {
    await cancelResponseBody(response, "PR preparation content type is invalid");
    throw new Error("invalid PR preparation response: expected application/x-ndjson");
  }
  return response;
}

async function drainPreparationStream(
  response: Response,
  onStage: (stage: PrPrepareStage, elapsedMs: number) => void,
): Promise<PrPreparationResult> {
  if (response.body === null) {
    throw new Error("invalid PR preparation response: body is required");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let result: PrPreparationResult | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      try {
        buffer += decoder.decode(value, { stream: true });
      } catch {
        throw new Error("invalid PR preparation stream: expected UTF-8");
      }
      if (utf8ByteLength(buffer) > PR_PREPARE_MAX_LINE_BYTES && !buffer.includes("\n")) {
        throw new Error("invalid PR preparation stream: NDJSON line is too large");
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        assertLineSize(line);
        result = applyLine(line.trim(), onStage, result);
      }
    }
    try {
      buffer += decoder.decode();
    } catch {
      throw new Error("invalid PR preparation stream: expected UTF-8");
    }
    assertLineSize(buffer);
    result = applyLine(buffer.trim(), onStage, result);
    if (result === null) throw new Error("PR preparation ended without a v1 done line.");
    return result;
  } catch (error) {
    try {
      await reader.cancel(error instanceof Error ? error.message : "invalid PR preparation stream");
    } catch {
      // Preserve the protocol or transport failure that made the body unusable.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
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
  if (!isRecord(value) || value.version !== PR_PREPARE_PROTOCOL_VERSION) {
    throw new Error("invalid PR preparation stream: expected protocol version 1");
  }
  if (value.type === "progress") {
    if (!hasExactPrPrepareFields(value, PR_PREPARE_V1_FIELDS.progress)) {
      throw new Error("invalid PR preparation stream: progress fields do not match protocol version 1");
    }
    if (!isPrPrepareStage(value.stage)) {
      throw new Error("invalid PR preparation stream: progress.stage");
    }
    if (!isPrPrepareElapsedMs(value.elapsedMs)) {
      throw new Error("invalid PR preparation stream: progress.elapsedMs");
    }
    return { type: "progress", stage: value.stage, elapsedMs: value.elapsedMs };
  }
  if (value.type === "done") {
    if (!hasExactPrPrepareFields(value, PR_PREPARE_V1_FIELDS.done)) {
      throw new Error("invalid PR preparation stream: done fields do not match protocol version 1");
    }
    return { type: "done", result: parseDoneLine(value) };
  }
  if (value.type === "error") {
    if (!hasExactPrPrepareFields(value, PR_PREPARE_V1_FIELDS.error)) {
      throw new Error("invalid PR preparation stream: error fields do not match protocol version 1");
    }
    return { type: "error", message: requiredString(value.message, "error.message") };
  }
  throw new Error("invalid PR preparation stream: unsupported v1 line type");
}

function parseDoneLine(line: Record<string, unknown>): PrPreparationResult {
  const pair = parsePreparedPair(line);
  return {
    ...pair,
    handoff: parseHandoffLink(line.handoff, pair.head.graphId),
  };
}

function parsePreparedPair(line: Record<string, unknown>): PreparedReviewPair {
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

function parseHandoffLink(value: unknown, headGraphId: string): PreparedReviewHandoffLink {
  if (!hasExactPrPrepareFields(value, PR_PREPARE_V1_FIELDS.handoffLink)) throw invalidDone("handoff");
  const id = requiredString(value.id, "handoff.id");
  const url = requiredString(value.url, "handoff.url");
  const viewUrl = requiredString(value.viewUrl, "handoff.viewUrl");
  const parsedUrl = strictRelativeUrl(url, "/api/pr/prepared", ["id"], "handoff.url");
  const parsedView = strictRelativeUrl(
    viewUrl,
    "/view",
    ["id", "view", "prn", "rev", "prepared"],
    "handoff.viewUrl",
  );
  if (
    parsedUrl.searchParams.get("id") !== id
    || parsedView.searchParams.get("id") !== headGraphId
    || parsedView.searchParams.get("view") !== "modules"
    || parsedView.searchParams.get("rev") !== "1"
    || parsedView.searchParams.get("prepared") !== id
    || !/^[1-9]\d*$/.test(parsedView.searchParams.get("prn") ?? "")
  ) {
    throw invalidDone("handoff");
  }
  return { id, url, viewUrl };
}

function strictRelativeUrl(
  value: string,
  pathname: string,
  expectedKeys: readonly string[],
  label: string,
): URL {
  const separatorIndex = value.search(/[?#]/);
  const rawPathname = separatorIndex < 0 ? value : value.slice(0, separatorIndex);
  if (!value.startsWith("/") || value.startsWith("//") || rawPathname !== pathname) {
    throw invalidDone(label);
  }
  const parsed = new URL(value, "http://meridian.local");
  const keys = [...parsed.searchParams.keys()].sort();
  if (
    parsed.origin !== "http://meridian.local"
    || parsed.pathname !== pathname
    || value.includes("#")
    || keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== [...expectedKeys].sort()[index])
  ) {
    throw invalidDone(label);
  }
  return parsed;
}

function parseHandoffRequest(value: unknown): PrPrepareRequest {
  if (!isRecord(value)) throw new Error("invalid prepared review handoff: request");
  try {
    const fields = Object.prototype.hasOwnProperty.call(value, "subdir")
      ? PR_PREPARE_V1_FIELDS.requestWithSubdir
      : PR_PREPARE_V1_FIELDS.request;
    if (!hasExactPrPrepareFields(value, fields)) {
      throw new Error("request fields do not match protocol version 1");
    }
    return canonicalRequest({
      owner: requiredString(value.owner, "request.owner"),
      repo: requiredString(value.repo, "request.repo"),
      ...(Object.prototype.hasOwnProperty.call(value, "subdir")
        ? { subdir: requiredString(value.subdir, "request.subdir") }
        : {}),
      prNumber: nonNegativeInteger(value.prNumber, "request.prNumber"),
      baseRef: requiredString(value.baseRef, "request.baseRef"),
      headRef: requiredString(value.headRef, "request.headRef"),
    });
  } catch {
    throw new Error("invalid prepared review handoff: request");
  }
}

function parseGraphDescriptor(value: unknown, label: string): PreparedGraphDescriptor {
  if (!hasExactPrPrepareFields(value, PR_PREPARE_V1_FIELDS.descriptor)) {
    throw invalidDone(`${label} descriptor`);
  }
  if (!hasExactPrPrepareFields(value.graphSummary, PR_PREPARE_V1_FIELDS.graphSummary)) {
    throw invalidDone(`${label}.graphSummary`);
  }
  const graphId = requiredString(value.graphId, `${label}.graphId`);
  return {
    graphId,
    manifestUrl: parseDescriptorEndpoint(
      value.manifestUrl,
      graphId,
      "/api/graph/manifest",
      `${label}.manifestUrl`,
    ),
    projectionUrl: parseDescriptorEndpoint(
      value.projectionUrl,
      graphId,
      "/api/graph/projection",
      `${label}.projectionUrl`,
    ),
    searchUrl: parseDescriptorEndpoint(
      value.searchUrl,
      graphId,
      "/api/graph/search",
      `${label}.searchUrl`,
    ),
    sourceUrl: parseDescriptorEndpoint(value.sourceUrl, graphId, "/api/source", `${label}.sourceUrl`),
    metaUrl: parseDescriptorEndpoint(value.metaUrl, graphId, "/api/meta", `${label}.metaUrl`),
    graphSummary: {
      schemaVersion: requiredString(value.graphSummary.schemaVersion, `${label}.graphSummary.schemaVersion`),
      generatedAt: requiredString(value.graphSummary.generatedAt, `${label}.graphSummary.generatedAt`),
      nodeCount: nonNegativeInteger(value.graphSummary.nodeCount, `${label}.graphSummary.nodeCount`),
      edgeCount: nonNegativeInteger(value.graphSummary.edgeCount, `${label}.graphSummary.edgeCount`),
    },
  };
}

function parseDescriptorEndpoint(
  value: unknown,
  graphId: string,
  pathname: string,
  label: string,
): string {
  const endpoint = requiredString(value, label);
  const parsed = strictRelativeUrl(endpoint, pathname, ["id"], label);
  if (parsed.searchParams.get("id") !== graphId) throw invalidDone(label);
  return endpoint;
}

function parseChangedFiles(value: unknown): PreparedChangedFile[] {
  const files = normalizePrPrepareChangedFiles(value);
  if (files === null) throw invalidDone("changedFiles");
  if (files.some((file, index) => index > 0
    && compareCanonicalPrPreparePaths(files[index - 1]!.path, file.path) >= 0)) {
    throw invalidDone("changedFiles canonical order");
  }
  return files;
}

function parseTimings(value: unknown): PrPrepareTimings {
  const timings = normalizePrPrepareTimings(value);
  if (timings === null) throw invalidDone("timings");
  return timings;
}

function parseWarnings(value: unknown): string[] {
  const warnings = normalizePrPrepareWarnings(value);
  if (warnings === null) throw invalidDone("warnings");
  return warnings;
}

function canonicalRequest(request: PrPrepareRequest): PrPrepareRequest {
  const fields = typeof request === "object" && request !== null
    && Object.prototype.hasOwnProperty.call(request, "subdir")
    ? PR_PREPARE_V1_FIELDS.requestWithSubdir
    : PR_PREPARE_V1_FIELDS.request;
  if (!hasExactPrPrepareFields(request, fields)) {
    throw new TypeError("PR preparation request fields do not match protocol version 1");
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidDone(field: string): Error {
  return new Error(`invalid PR preparation done line: ${field}`);
}

function assertLineSize(line: string): void {
  if (utf8ByteLength(line) + 1 > PR_PREPARE_MAX_LINE_BYTES) {
    throw new Error("invalid PR preparation stream: NDJSON line is too large");
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function cancelResponseBody(response: Response, reason: string): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch {
    // Preserve the contract failure; transport cleanup cannot make an invalid response valid.
  }
}

async function requestErrorMessage(response: Response): Promise<string> {
  try {
    if (responseMediaType(response) !== "application/json") {
      await cancelResponseBody(response, "PR preparation error response content type is invalid");
      throw new Error("invalid error response media type");
    }
    const data = JSON.parse(await readBoundedTextResponse(
      response,
      MAX_ERROR_RESPONSE_BYTES,
      "PR preparation error response",
    )) as { error?: unknown };
    if (typeof data.error === "string" && data.error.length > 0) return data.error;
  } catch {
    // Non-JSON response: use the bounded generic message below.
  }
  return `PR preparation request failed (${response.status}).`;
}

async function handoffErrorMessage(response: Response): Promise<string> {
  try {
    if (responseMediaType(response) !== "application/json") {
      await cancelResponseBody(response, "prepared review error response content type is invalid");
      throw new Error("invalid error response media type");
    }
    const data = JSON.parse(await readBoundedTextResponse(
      response,
      MAX_ERROR_RESPONSE_BYTES,
      "prepared review error response",
    )) as { error?: unknown };
    if (typeof data.error === "string" && data.error.length > 0) return data.error;
  } catch {
    // Non-JSON response: use the bounded generic message below.
  }
  return `Prepared review handoff request failed (${response.status}).`;
}

async function readBoundedTextResponse(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const advertised = Number(contentLength);
    if (!Number.isSafeInteger(advertised) || advertised < 0) {
      await cancelResponseBody(response, `invalid ${label} content length`);
      throw new Error(`invalid ${label}: content-length is malformed`);
    }
    if (advertised > maxBytes) {
      await cancelResponseBody(response, `${label} exceeded its byte limit`);
      throw new Error(`invalid ${label}: response is too large`);
    }
  }
  if (response.body === null) throw new Error(`invalid ${label}: body is required`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - byteLength) {
        try {
          await reader.cancel(`${label} exceeded its byte limit`);
        } catch {
          // Preserve the bounded-transport failure below.
        }
        throw new Error(`invalid ${label}: response is too large`);
      }
      byteLength += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (contentLength !== null && Number(contentLength) !== byteLength) {
    throw new Error(`invalid ${label}: content-length does not match the body`);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`invalid ${label}: expected UTF-8`);
  }
}

function responseMediaType(response: Response): string | null {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function requestOrigin(): string {
  return typeof window === "undefined" ? "http://meridian.local" : window.location.origin;
}
