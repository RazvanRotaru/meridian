/**
 * Immutable, restart-safe navigation handoffs for prepared pull-request reviews.
 *
 * Handoffs contain only bounded JSON metadata. Graph artifacts and source files remain behind the
 * existing per-graph projection/source endpoints. Every URL id content-addresses the exact canonical
 * v1 JSON bytes served after restart; comparison reuse remains keyed independently by HEAD +
 * merge-base in the PR cache, so moving-base provenance and diagnostics cannot alias immutable
 * navigation bytes. Reads retain no in-memory registry.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ChangedFileManifestEntry } from "@meridian/core";
import type { InspectionGraphSummary } from "./inspection-snapshot-store";
import type { PrPrepareTimings } from "./web-pr-cache";
import { parsePrPrepareRequest, type PrPrepareRequest } from "./web-pr-request";

export const PREPARED_REVIEW_HANDOFF_VERSION = 1 as const;
export const MAX_PREPARED_REVIEW_HANDOFF_BYTES = 2 * 1024 * 1024;

const HANDOFF_DIRECTORY = "prepared-review-handoffs";
const VERSION_DIRECTORY = `v${PREPARED_REVIEW_HANDOFF_VERSION}`;
const HANDOFF_FILE = "handoff.json";
const INTEGRITY_FILE = "sha256";
const HANDOFF_ID = /^prh-v1-[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHARD = /^[0-9a-f]{2}$/;
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_CHANGED_FILES = 100_000;
const MAX_CHANGED_PATH_BYTES = 4_096;
const MAX_CHANGED_MANIFEST_PATH_BYTES = 1024 * 1024;
const TIMING_KEYS = new Set(["resolve", "git", "extract-head", "extract-merge-base", "publish"]);
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export interface PreparedReviewGraphDescriptor {
  readonly graphId: string;
  readonly manifestUrl: string;
  readonly projectionUrl: string;
  readonly sourceUrl: string;
  readonly metaUrl: string;
  readonly graphSummary: InspectionGraphSummary;
}

export interface PreparedReviewHandoffDocument {
  readonly version: typeof PREPARED_REVIEW_HANDOFF_VERSION;
  readonly request: PrPrepareRequest;
  readonly headSha: string;
  /** Request provenance only. The immutable comparison identity is `mergeBaseSha`. */
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly changedFiles: ChangedFileManifestEntry[];
  readonly head: PreparedReviewGraphDescriptor;
  readonly mergeBase: PreparedReviewGraphDescriptor;
  readonly cache: "hit" | "miss";
  readonly timings: PrPrepareTimings;
  readonly warnings: string[];
}

export type PreparedReviewHandoffInput = Omit<PreparedReviewHandoffDocument, "version">;

export interface PreparedReviewHandoffReference {
  readonly id: string;
  readonly url: string;
  readonly viewUrl: string;
}

export interface PreparedReviewHandoffCandidate {
  readonly id: string;
  readonly document: PreparedReviewHandoffDocument;
  readonly serialized: string;
  readonly contentSha256: string;
  readonly reference: PreparedReviewHandoffReference;
}

export interface ResolvedPreparedReviewHandoff {
  readonly document: PreparedReviewHandoffDocument;
  /** Exact digest-validated bytes that the HTTP route must serve; never graph/artifact bytes. */
  readonly bytes: Buffer;
  readonly size: number;
  /** Digest of `bytes`, used as the representation ETag. */
  readonly sha256: string;
}

export interface PreparedReviewHandoffStoreOptions {
  readonly cacheRoot: string;
  /** Tests/deployments may lower, but never raise, the protocol's 2 MiB ceiling. */
  readonly maxDocumentBytes?: number;
  /** Maximum immutable handoff directories retained on disk. */
  readonly maxEntries?: number;
  /** Maximum JSON + integrity bytes retained on disk. */
  readonly maxCacheBytes?: number;
  /** Idle TTL renewed by publication and successful navigation reads. */
  readonly maxAgeMs?: number;
  /** Deterministic clock injection for pruning tests. */
  readonly now?: () => number;
}

export interface PreparedReviewHandoffScavengeResult {
  readonly entries: number;
  readonly bytes: number;
  readonly removed: number;
}

export class PreparedReviewHandoffStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedReviewHandoffStoreError";
  }
}

export class PreparedReviewHandoffStore {
  private readonly root: string;
  private readonly maxDocumentBytes: number;
  private readonly maxEntries: number;
  private readonly maxCacheBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: PreparedReviewHandoffStoreOptions) {
    if (!options.cacheRoot.trim()) throw new TypeError("prepared-review cache root is required");
    const configured = options.maxDocumentBytes ?? MAX_PREPARED_REVIEW_HANDOFF_BYTES;
    if (!Number.isSafeInteger(configured) || configured <= 0 || configured > MAX_PREPARED_REVIEW_HANDOFF_BYTES) {
      throw new RangeError("prepared-review document limit must be between 1 byte and 2 MiB");
    }
    this.maxDocumentBytes = configured;
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "entry limit");
    this.maxCacheBytes = positiveInteger(options.maxCacheBytes, DEFAULT_MAX_CACHE_BYTES, "cache byte limit");
    if (this.maxCacheBytes < this.maxDocumentBytes + 65) {
      throw new RangeError("prepared-review cache byte limit must fit one maximum document and digest");
    }
    this.maxAgeMs = positiveInteger(options.maxAgeMs, DEFAULT_MAX_AGE_MS, "maximum age");
    this.now = options.now ?? Date.now;

    const requestedCacheRoot = resolve(options.cacheRoot);
    mkdirSync(requestedCacheRoot, { recursive: true, mode: 0o700 });
    const cacheRoot = realpathSync(requestedCacheRoot);
    const handoffRoot = requirePlainDirectory(join(cacheRoot, HANDOFF_DIRECTORY), cacheRoot);
    this.root = requirePlainDirectory(join(handoffRoot, VERSION_DIRECTORY), handoffRoot);
    this.scavenge();
  }

  /**
   * Build the exact immutable record and URLs without touching disk. Callers use this preview to
   * enforce the terminal NDJSON line bound before atomically publishing the handoff.
   */
  prepare(input: PreparedReviewHandoffInput): PreparedReviewHandoffCandidate {
    const document = normalizeDocument({ version: PREPARED_REVIEW_HANDOFF_VERSION, ...input });
    if (!document) throw new PreparedReviewHandoffStoreError("prepared-review handoff is invalid");
    const serialized = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(serialized) > this.maxDocumentBytes) {
      throw new PreparedReviewHandoffStoreError("PR preparation result exceeds the 2 MiB handoff limit");
    }
    const id = handoffId(document);
    const contentSha256 = createHash("sha256").update(serialized).digest("hex");
    const encodedId = encodeURIComponent(id);
    return {
      id,
      document,
      serialized,
      contentSha256,
      reference: {
        id,
        url: `/api/pr/prepared?id=${encodedId}`,
        viewUrl: `/view?id=${encodeURIComponent(document.head.graphId)}`
          + `&view=modules&prn=${document.request.prNumber}&rev=1&prepared=${encodedId}`,
      },
    };
  }

  /** Atomically publish a bounded candidate. The same exact representation is idempotent. */
  publish(candidate: PreparedReviewHandoffCandidate): PreparedReviewHandoffReference {
    const verified = this.prepare(candidate.document);
    if (verified.id !== candidate.id
      || verified.serialized !== candidate.serialized
      || verified.contentSha256 !== candidate.contentSha256) {
      throw new PreparedReviewHandoffStoreError("prepared-review handoff candidate was modified");
    }
    const shard = requirePlainDirectory(join(this.root, shardFor(candidate.id)), this.root);
    const destination = join(shard, candidate.id);
    const stage = mkdtempSync(join(shard, ".stage-"));
    chmodSync(stage, 0o700);
    writeFileSync(join(stage, HANDOFF_FILE), candidate.serialized, { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(stage, INTEGRITY_FILE), `${candidate.contentSha256}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(stage, destination);
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      if (!existsSync(destination)) throw error;
      const existing = this.readEntry(candidate.id, false);
      if (!existing) {
        throw new PreparedReviewHandoffStoreError("prepared-review handoff id is already bound to invalid data");
      }
    }
    this.touch(candidate.id);
    this.scavenge(candidate.id);
    return candidate.reference;
  }

  /** Resolve and validate one immutable JSON file. No result is retained in process memory. */
  resolve(id: string | null | undefined): ResolvedPreparedReviewHandoff | null {
    const resolved = this.readEntry(id, true);
    return resolved ? {
      document: resolved.document,
      bytes: resolved.bytes,
      size: resolved.bytes.byteLength,
      sha256: resolved.sha256,
    } : null;
  }

  /** Deterministically remove malformed, expired, least-recently-used, and excess-byte entries. */
  scavenge(protectedId?: string): PreparedReviewHandoffScavengeResult {
    let removed = 0;
    const entries: Array<{ id: string; path: string; bytes: number; touchedAt: number }> = [];
    for (const shardEntry of readdirSync(this.root, { withFileTypes: true })) {
      const shardPath = join(this.root, shardEntry.name);
      if (!SHARD.test(shardEntry.name) || !shardEntry.isDirectory() || shardEntry.isSymbolicLink()) {
        removeCacheEntry(shardPath);
        removed += 1;
        continue;
      }
      for (const handoffEntry of readdirSync(shardPath, { withFileTypes: true })) {
        const path = join(shardPath, handoffEntry.name);
        if (!isPreparedReviewHandoffId(handoffEntry.name)
          || shardFor(handoffEntry.name) !== shardEntry.name
          || !handoffEntry.isDirectory()
          || handoffEntry.isSymbolicLink()) {
          removeCacheEntry(path);
          removed += 1;
          continue;
        }
        const resolved = this.readEntry(handoffEntry.name, false);
        if (!resolved) {
          removeCacheEntry(path);
          removed += 1;
          continue;
        }
        const touchedAt = statSync(path).mtimeMs;
        if (this.now() - touchedAt > this.maxAgeMs) {
          removeCacheEntry(path);
          removed += 1;
          continue;
        }
        entries.push({
          id: handoffEntry.name,
          path,
          bytes: resolved.bytes.byteLength + 65,
          touchedAt,
        });
      }
    }
    entries.sort((left, right) => {
      if (left.id === protectedId) return 1;
      if (right.id === protectedId) return -1;
      return left.touchedAt - right.touchedAt || left.id.localeCompare(right.id);
    });
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let retained = entries.length;
    for (const entry of entries) {
      if (retained <= this.maxEntries && bytes <= this.maxCacheBytes) break;
      removeCacheEntry(entry.path);
      retained -= 1;
      bytes -= entry.bytes;
      removed += 1;
    }
    removeEmptyShards(this.root);
    return { entries: retained, bytes, removed };
  }

  private readEntry(
    id: string | null | undefined,
    touch: boolean,
  ): { document: PreparedReviewHandoffDocument; bytes: Buffer; sha256: string } | null {
    if (!isPreparedReviewHandoffId(id)) return null;
    try {
      const directory = join(this.root, shardFor(id), id);
      if (!isContainedPath(directory, this.root)) return null;
      const directoryEntry = lstatSync(directory);
      if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) return null;
      const canonicalDirectory = realpathSync(directory);
      if (!isContainedPath(canonicalDirectory, this.root)) return null;
      if (touch && this.now() - directoryEntry.mtimeMs > this.maxAgeMs) {
        removeCacheEntry(directory);
        return null;
      }

      const path = join(canonicalDirectory, HANDOFF_FILE);
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > this.maxDocumentBytes) return null;
      const canonicalPath = realpathSync(path);
      if (!isContainedPath(canonicalPath, canonicalDirectory)) return null;
      const raw = readFileSync(canonicalPath);
      if (raw.byteLength <= 0 || raw.byteLength > this.maxDocumentBytes) return null;
      const integrityPath = join(canonicalDirectory, INTEGRITY_FILE);
      const integrityEntry = lstatSync(integrityPath);
      if (!integrityEntry.isFile() || integrityEntry.isSymbolicLink() || integrityEntry.size !== 65) return null;
      const canonicalIntegrityPath = realpathSync(integrityPath);
      if (!isContainedPath(canonicalIntegrityPath, canonicalDirectory)) return null;
      const integrity = readFileSync(canonicalIntegrityPath, "utf8");
      const expectedSha256 = integrity.endsWith("\n") ? integrity.slice(0, -1) : "";
      if (!SHA256.test(expectedSha256)
        || createHash("sha256").update(raw).digest("hex") !== expectedSha256) return null;
      const document = normalizeDocument(JSON.parse(raw.toString("utf8")));
      if (!document || handoffId(document) !== id) return null;
      if (touch) this.touch(id);
      return { document, bytes: raw, sha256: expectedSha256 };
    } catch {
      return null;
    }
  }

  private touch(id: string): void {
    try {
      const path = join(this.root, shardFor(id), id);
      const at = new Date(this.now());
      utimesSync(path, at, at);
    } catch {
      // A successful read remains usable even if best-effort LRU renewal loses a cleanup race.
    }
  }
}

export function isPreparedReviewHandoffId(value: string | null | undefined): value is string {
  return typeof value === "string" && HANDOFF_ID.test(value);
}

function handoffId(document: PreparedReviewHandoffDocument): string {
  // This is a representation address, deliberately not the PR comparison/cache identity. The
  // latter excludes moving baseSha provenance and observational diagnostics; this digest includes
  // them so one immutable URL can never serve different bytes after LRU/TTL eviction and republish.
  const digest = createHash("sha256").update(`${JSON.stringify(document)}\n`).digest("hex");
  return `prh-v1-${digest}`;
}

function shardFor(id: string): string {
  return id.slice("prh-v1-".length, "prh-v1-".length + 2);
}

function normalizeDocument(value: unknown): PreparedReviewHandoffDocument | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version", "request", "headSha", "baseSha", "mergeBaseSha", "changedFiles",
    "head", "mergeBase", "cache", "timings", "warnings",
  ])) return null;
  if (value.version !== PREPARED_REVIEW_HANDOFF_VERSION) return null;
  const request = normalizeRequest(value.request);
  const head = normalizeDescriptor(value.head);
  const mergeBase = normalizeDescriptor(value.mergeBase);
  const changedFiles = normalizeChangedFiles(value.changedFiles);
  const timings = normalizeTimings(value.timings);
  const warnings = normalizeWarnings(value.warnings);
  if (!request || !head || !mergeBase || !changedFiles || !timings || !warnings
    || !isCommit(value.headSha) || !isCommit(value.baseSha) || !isCommit(value.mergeBaseSha)
    || (value.cache !== "hit" && value.cache !== "miss")) return null;
  return {
    version: PREPARED_REVIEW_HANDOFF_VERSION,
    request,
    headSha: value.headSha,
    baseSha: value.baseSha,
    mergeBaseSha: value.mergeBaseSha,
    changedFiles,
    head,
    mergeBase,
    cache: value.cache,
    timings,
    warnings,
  };
}

function normalizeRequest(value: unknown): PrPrepareRequest | null {
  if (!isRecord(value)) return null;
  const expected = value.subdir === undefined
    ? ["owner", "repo", "prNumber", "baseRef", "headRef"]
    : ["owner", "repo", "subdir", "prNumber", "baseRef", "headRef"];
  if (!hasExactKeys(value, expected)) return null;
  try {
    const parsed = parsePrPrepareRequest(value);
    if (JSON.stringify(parsed) !== JSON.stringify(value)) return null;
    return { ...parsed };
  } catch {
    return null;
  }
}

function normalizeDescriptor(value: unknown): PreparedReviewGraphDescriptor | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "graphId", "manifestUrl", "projectionUrl", "sourceUrl", "metaUrl", "graphSummary",
  ])) return null;
  if (typeof value.graphId !== "string" || !GRAPH_ID.test(value.graphId)) return null;
  const encoded = encodeURIComponent(value.graphId);
  if (value.manifestUrl !== `/api/graph/manifest?id=${encoded}`
    || value.projectionUrl !== `/api/graph/projection?id=${encoded}`
    || value.sourceUrl !== `/api/source?id=${encoded}`
    || value.metaUrl !== `/api/meta?id=${encoded}`) return null;
  const graphSummary = normalizeGraphSummary(value.graphSummary);
  if (!graphSummary) return null;
  return {
    graphId: value.graphId,
    manifestUrl: value.manifestUrl,
    projectionUrl: value.projectionUrl,
    sourceUrl: value.sourceUrl,
    metaUrl: value.metaUrl,
    graphSummary,
  };
}

function normalizeGraphSummary(value: unknown): InspectionGraphSummary | null {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "generatedAt", "nodeCount", "edgeCount"])) return null;
  if (typeof value.schemaVersion !== "string" || value.schemaVersion.length === 0 || value.schemaVersion.length > 128
    || typeof value.generatedAt !== "string" || value.generatedAt.length > 64 || !Number.isFinite(Date.parse(value.generatedAt))
    || !Number.isSafeInteger(value.nodeCount) || (value.nodeCount as number) < 0
    || !Number.isSafeInteger(value.edgeCount) || (value.edgeCount as number) < 0) return null;
  return {
    schemaVersion: value.schemaVersion,
    generatedAt: value.generatedAt,
    nodeCount: value.nodeCount as number,
    edgeCount: value.edgeCount as number,
  };
}

function normalizeChangedFiles(value: unknown): ChangedFileManifestEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_CHANGED_FILES) return null;
  const files: ChangedFileManifestEntry[] = [];
  const seen = new Set<string>();
  let pathBytes = 0;
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const renamed = raw.status === "renamed";
    if (!hasExactKeys(raw, renamed ? ["path", "previousPath", "status"] : ["path", "status"])) return null;
    if (!safeManifestPath(raw.path) || seen.has(raw.path)) return null;
    seen.add(raw.path);
    pathBytes += Buffer.byteLength(raw.path);
    if (renamed) {
      if (!safeManifestPath(raw.previousPath) || raw.previousPath === raw.path) return null;
      pathBytes += Buffer.byteLength(raw.previousPath);
      files.push({ path: raw.path, previousPath: raw.previousPath, status: "renamed" });
    } else if (raw.status === "added" || raw.status === "modified" || raw.status === "deleted") {
      files.push({ path: raw.path, status: raw.status });
    } else return null;
    if (pathBytes > MAX_CHANGED_MANIFEST_PATH_BYTES) return null;
  }
  return files;
}

function safeManifestPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")
    || value.includes("\0") || Buffer.byteLength(value) > MAX_CHANGED_PATH_BYTES || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function normalizeTimings(value: unknown): PrPrepareTimings | null {
  if (!isRecord(value)) return null;
  const timings: PrPrepareTimings = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!TIMING_KEYS.has(key) || typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
    timings[key as keyof PrPrepareTimings] = raw;
  }
  return timings;
}

function normalizeWarnings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 10_000) return null;
  const warnings: string[] = [];
  for (const warning of value) {
    if (typeof warning !== "string" || warning.includes("\0") || Buffer.byteLength(warning) > 64 * 1024) return null;
    warnings.push(warning);
  }
  return warnings;
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && COMMIT.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function requirePlainDirectory(path: string, allowedParent: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!existsSync(path)) throw error;
  }
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new PreparedReviewHandoffStoreError("prepared-review cache contains an unsafe directory");
  }
  const canonical = realpathSync(path);
  if (!isContainedPath(canonical, allowedParent)) {
    throw new PreparedReviewHandoffStoreError("prepared-review cache directory escapes its root");
  }
  return canonical;
}

function isContainedPath(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective <= 0) {
    throw new RangeError(`prepared-review ${label} must be a positive safe integer`);
  }
  return effective;
}

function removeCacheEntry(path: string): void {
  // A failed removal means the configured bound cannot be guaranteed. Propagate it so startup or
  // publication fails closed instead of reporting a bounded cache while bytes keep accumulating.
  rmSync(path, { recursive: true, force: true });
}

function removeEmptyShards(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!SHARD.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    try {
      if (readdirSync(path).length === 0) rmSync(path, { recursive: false });
    } catch {
      // A concurrent publisher may have populated the shard after the empty check.
    }
  }
}
