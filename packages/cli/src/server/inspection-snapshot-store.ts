/**
 * Persistent lookup for immutable web inspection results.
 *
 * A snapshot descriptor is intentionally tiny: it maps an opaque graph id to an artifact and a
 * source checkout, both expressed relative to the web cache root. That makes graph projections,
 * `/api/meta`, `/view`, and `/api/source` recoverable after a restart without rebuilding the
 * process-local maps in `web-server.ts`.  Descriptors are published as complete directories, so a
 * reader sees either the old absence or a complete descriptor, never a partially-written file.
 *
 * The referenced artifact and checkout are expected to live in immutable cache generations.  All
 * paths are checked lexically and canonically: a hand-edited descriptor or a symlink cannot escape
 * the configured cache root (or escape the source checkout through its extraction subdirectory).
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import type { ArtifactSource } from "./web-source";
import {
  inspectSyntheticCapabilitySidecar,
  syntheticCapabilitySidecarPath,
  type SyntheticCapabilitySidecar,
} from "./synthetic-capability-sidecar";

const FORMAT_VERSION = 4;
const SNAPSHOT_DIRECTORY = "inspection-snapshots";
const DESCRIPTOR_FILE = "descriptor.json";
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
// Artifacts are produced inside Meridian's private cache and extraction itself has no 256 MiB
// output ceiling. A lower implicit read ceiling would let analysis report success and then make
// the resulting id permanently return 404. Deployments that need a stricter policy can still set
// `maxArtifactBytes`; graph bytes are streamed and never admitted to the descriptor LRU.
const DEFAULT_MAX_ARTIFACT_BYTES = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_DESCRIPTOR_BYTES = 64 * 1024;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//;

export interface InspectionSnapshotDescriptor {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly id: string;
  readonly publishedAt: string;
  /** Compact graph metadata used by `/api/meta`. */
  readonly graphSummary: InspectionGraphSummary;
  readonly artifact: {
    /** Portable, cache-root-relative path to a GraphArtifact JSON file. */
    readonly path: string;
    /** Request provenance associated with this immutable graph response. */
    readonly vcsBranch: string | null;
  };
  readonly source: {
    /** Portable, cache-root-relative path to the immutable checkout/worktree root. */
    readonly rootPath: string;
    /** Canonical relative extraction directory below `rootPath`; empty means the root itself. */
    readonly subdir: string;
    /** Original source identity used by `/view` and PR-related routes. Never contains credentials. */
    readonly metadata: ArtifactSource;
  };
  /** Optional immutable, digest-bound capability metadata. Graph bytes are never embedded here. */
  readonly synthetic: InspectionSyntheticCapabilityReference | null;
}

export interface InspectionSyntheticExecutionTrust {
  readonly mode: "sandboxed-pr";
  readonly provenance: { readonly repository: string; readonly headSha: string };
}

export interface InspectionSyntheticCapabilityReference {
  /** Cache-root-relative path to the bounded sidecar adjacent to artifact.json. */
  readonly path: string;
  readonly sha256: string;
  /** Only prepared HEAD publication may provide this authority. */
  readonly executionTrust: InspectionSyntheticExecutionTrust | null;
}

export interface ResolvedInspectionSyntheticCapability {
  readonly capability: SyntheticCapabilitySidecar;
  readonly executionTrust: InspectionSyntheticExecutionTrust | null;
}

export interface InspectionGraphSummary {
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface PublishInspectionSnapshot {
  id: string;
  /** Absolute path, or a path relative to `cacheRoot`, to an already-published artifact. */
  artifactPath: string;
  /** Small immutable metadata retained for `/api/meta`; the graph object itself is never cached. */
  graphSummary: InspectionGraphSummary;
  vcsBranch?: string;
  /** Absolute path, or a path relative to `cacheRoot`, to an already-published checkout/worktree. */
  sourceRoot: string;
  /** Extraction directory relative to `sourceRoot`. */
  sourceSubdir?: string;
  source: ArtifactSource;
  /** Explicit server-authored authority. Ordinary GitHub graphs and merge-base sides omit it. */
  syntheticExecutionTrust?: InspectionSyntheticExecutionTrust;
  /** Primarily useful for deterministic publication/tests. Defaults to the current time. */
  publishedAt?: string;
}

export interface ResolvedInspectionSource {
  /** Canonical checkout/worktree root. */
  rootDir: string;
  /** Canonical directory source files are served relative to. */
  sourceDir: string;
  subdir: string;
  metadata: ArtifactSource;
}

export interface ResolvedInspectionArtifact {
  descriptor: InspectionSnapshotDescriptor;
  /** Canonical path to the immutable graph JSON file. */
  path: string;
  /** File size captured when the path was resolved, suitable for Content-Length. */
  size: number;
}

export interface InspectionSnapshotStoreOptions {
  cacheRoot: string;
  /** In-memory budget for small descriptors only. Zero disables caching. */
  maxCacheBytes?: number;
  /** Optional deployment ceiling for serving a single artifact. Unlimited by default. */
  maxArtifactBytes?: number;
  /** Refuse to read a descriptor above this size. */
  maxDescriptorBytes?: number;
}

export interface InspectionSnapshotCacheStats {
  maxBytes: number;
  bytes: number;
  entries: number;
  /** Always zero: immutable graph artifacts are deliberately never retained in this cache. */
  artifactEntries: 0;
  descriptorEntries: number;
  hits: number;
  misses: number;
  evictions: number;
  oversizeSkips: number;
}

export class InspectionSnapshotStore {
  private readonly cacheRoot: string;
  private readonly snapshotsRoot: string;
  private readonly maxArtifactBytes: number;
  private readonly maxDescriptorBytes: number;
  private readonly memory: ByteAwareLru;

  constructor(options: InspectionSnapshotStoreOptions) {
    if (!options.cacheRoot.trim()) {
      throw new TypeError("inspection snapshot cache root is required");
    }
    const cacheRoot = resolve(options.cacheRoot);
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    this.cacheRoot = realpathSync(cacheRoot);
    this.snapshotsRoot = requirePlainDirectory(join(this.cacheRoot, SNAPSHOT_DIRECTORY), this.cacheRoot);
    this.maxArtifactBytes = byteLimit(options.maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES, false);
    this.maxDescriptorBytes = byteLimit(options.maxDescriptorBytes, DEFAULT_MAX_DESCRIPTOR_BYTES, false);
    this.memory = new ByteAwareLru(byteLimit(options.maxCacheBytes, DEFAULT_CACHE_BYTES, true));
  }

  /**
   * Atomically create an id -> artifact/source mapping. Publishing the same mapping is idempotent;
   * reusing an id for different files is rejected so an open browser tab can never change meaning.
   */
  publish(input: PublishInspectionSnapshot): InspectionSnapshotDescriptor {
    const id = requireSnapshotId(input.id);
    const artifactPath = this.relativeExistingPath(input.artifactPath, "file");
    const artifactAbsolutePath = this.resolveExistingRelativePath(artifactPath, "file");
    if (!artifactAbsolutePath) {
      throw new TypeError("inspection snapshot artifact is unavailable");
    }
    const sourceRootPath = this.relativeExistingPath(input.sourceRoot, "directory");
    const sourceSubdir = normalizeSubdir(input.sourceSubdir);
    if (sourceSubdir === null) {
      throw new TypeError("inspection snapshot source subdirectory is unsafe");
    }
    const sourceRoot = this.resolveExistingRelativePath(sourceRootPath, "directory");
    if (!sourceRoot || !this.resolveSourceSubdir(sourceRoot, sourceSubdir)) {
      throw new TypeError("inspection snapshot source directory is unavailable or escapes its root");
    }
    const source = normalizeArtifactSource(input.source);
    if (!source) {
      throw new TypeError("inspection snapshot source metadata is invalid");
    }
    const publishedAt = input.publishedAt ?? new Date().toISOString();
    if (!validTimestamp(publishedAt)) {
      throw new TypeError("inspection snapshot publication time is invalid");
    }
    const graphSummary = normalizeGraphSummary(input.graphSummary);
    if (!graphSummary) {
      throw new TypeError("inspection snapshot graph summary is invalid");
    }
    const inspectedSidecar = inspectSyntheticCapabilitySidecar(
      syntheticCapabilitySidecarPath(artifactAbsolutePath),
    );
    let synthetic: InspectionSyntheticCapabilityReference | null = null;
    if (inspectedSidecar) {
      const sidecarPath = this.relativeExistingPath(inspectedSidecar.path, "file");
      const sidecarAbsolutePath = this.resolveExistingRelativePath(sidecarPath, "file");
      if (!sidecarAbsolutePath || dirname(sidecarAbsolutePath) !== dirname(artifactAbsolutePath)) {
        throw new TypeError("inspection snapshot synthetic capability is not adjacent to its artifact");
      }
      const executionTrust = input.syntheticExecutionTrust === undefined
        ? null
        : normalizeSyntheticExecutionTrust(input.syntheticExecutionTrust, source, inspectedSidecar.capability);
      if (input.syntheticExecutionTrust !== undefined && executionTrust === null) {
        throw new TypeError("inspection snapshot synthetic execution trust is invalid");
      }
      synthetic = {
        path: sidecarPath,
        sha256: inspectedSidecar.sha256,
        executionTrust,
      };
    } else if (input.syntheticExecutionTrust !== undefined) {
      throw new TypeError("inspection snapshot synthetic execution trust requires a valid capability sidecar");
    }

    const descriptor = freezeDescriptor({
      formatVersion: FORMAT_VERSION,
      id,
      publishedAt,
      graphSummary,
      artifact: { path: artifactPath, vcsBranch: normalizeBranch(input.vcsBranch) },
      source: { rootPath: sourceRootPath, subdir: sourceSubdir, metadata: source },
      synthetic,
    });
    const serialized = `${JSON.stringify(descriptor, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > this.maxDescriptorBytes) {
      throw new RangeError("inspection snapshot descriptor is too large");
    }

    const parent = requirePlainDirectory(join(this.snapshotsRoot, shardFor(id)), this.snapshotsRoot);
    const destination = join(parent, id);
    const stage = mkdtempSync(join(parent, ".stage-"));
    chmodSync(stage, 0o700);
    writeFileSync(join(stage, DESCRIPTOR_FILE), serialized, { encoding: "utf8", mode: 0o600 });

    try {
      renameSync(stage, destination);
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      if (!existsSync(destination)) {
        throw error;
      }
      const existing = this.readDescriptorFromDisk(id);
      if (!existing || !sameSnapshotTarget(existing.descriptor, descriptor)) {
        throw new Error(`inspection snapshot id '${id}' is already bound to another snapshot`);
      }
      this.memory.set(descriptorKey(id), "descriptor", existing.descriptor, existing.bytes);
      return existing.descriptor;
    }

    this.memory.set(descriptorKey(id), "descriptor", descriptor, Buffer.byteLength(serialized));
    return descriptor;
  }

  /** Resolve only the small persistent descriptor; the artifact is deliberately not read here. */
  resolveDescriptor(id: string | null | undefined): InspectionSnapshotDescriptor | null {
    if (!isInspectionSnapshotId(id)) return null;
    const cached = this.memory.get<InspectionSnapshotDescriptor>(descriptorKey(id), "descriptor");
    if (cached) return cached;
    const loaded = this.readDescriptorFromDisk(id);
    if (!loaded) return null;
    this.memory.set(descriptorKey(id), "descriptor", loaded.descriptor, loaded.bytes);
    return loaded.descriptor;
  }

  /** Resolve a canonical immutable graph file without reading or parsing its contents. */
  resolveArtifact(id: string | null | undefined): ResolvedInspectionArtifact | null {
    const descriptor = this.resolveDescriptor(id);
    if (!descriptor) return null;
    const artifactPath = this.resolveExistingRelativePath(descriptor.artifact.path, "file");
    if (!artifactPath) return null;
    try {
      const size = statSync(artifactPath).size;
      if (size > this.maxArtifactBytes) return null;
      return { descriptor, path: artifactPath, size };
    } catch {
      return null;
    }
  }

  /** Resolve the immutable checkout and extraction directory for `/api/source`. */
  resolveSource(id: string | null | undefined): ResolvedInspectionSource | null {
    const descriptor = this.resolveDescriptor(id);
    if (!descriptor) return null;
    const rootDir = this.resolveExistingRelativePath(descriptor.source.rootPath, "directory");
    if (!rootDir) return null;
    const sourceDir = this.resolveSourceSubdir(rootDir, descriptor.source.subdir);
    if (!sourceDir) return null;
    try {
      const now = new Date();
      utimesSync(rootDir, now, now);
    } catch {
      // Resolution already proved the snapshot readable. A failed best-effort lease renewal does
      // not make the current source response fail; the next resolver call will revalidate it.
    }
    return { rootDir, sourceDir, subdir: descriptor.source.subdir, metadata: descriptor.source.metadata };
  }

  /** Resolve and digest-check only the bounded sidecar; artifact.json remains unopened. */
  resolveSyntheticCapability(id: string | null | undefined): ResolvedInspectionSyntheticCapability | null {
    const descriptor = this.resolveDescriptor(id);
    const reference = descriptor?.synthetic;
    if (!descriptor || !reference) return null;
    const artifactPath = this.resolveExistingRelativePath(descriptor.artifact.path, "file");
    const sidecarPath = this.resolveExistingRelativePath(reference.path, "file");
    if (!artifactPath || !sidecarPath
      || dirname(sidecarPath) !== dirname(artifactPath)
      || sidecarPath !== syntheticCapabilitySidecarPath(artifactPath)) return null;
    const inspected = inspectSyntheticCapabilitySidecar(sidecarPath);
    if (!inspected || inspected.sha256 !== reference.sha256) return null;
    if (reference.executionTrust !== null
      && normalizeSyntheticExecutionTrust(
        reference.executionTrust,
        descriptor.source.metadata,
        inspected.capability,
      ) === null) return null;
    return {
      capability: inspected.capability,
      executionTrust: reference.executionTrust,
    };
  }

  cacheStats(): InspectionSnapshotCacheStats {
    return this.memory.stats();
  }

  /** Drop only hot descriptors; persistent descriptors and cache generations remain. */
  clearMemoryCache(): void {
    this.memory.clear();
  }

  private descriptorDirectory(id: string): string {
    const path = join(this.snapshotsRoot, shardFor(id), id);
    if (!isContainedPath(path, this.snapshotsRoot)) {
      throw new TypeError("inspection snapshot id escapes the descriptor root");
    }
    return path;
  }

  private readDescriptorFromDisk(
    id: string,
  ): { descriptor: InspectionSnapshotDescriptor; bytes: number } | null {
    try {
      const directory = this.descriptorDirectory(id);
      const directoryEntry = lstatSync(directory);
      if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) return null;
      const descriptorPath = join(directory, DESCRIPTOR_FILE);
      const descriptorEntry = lstatSync(descriptorPath);
      if (!descriptorEntry.isFile() || descriptorEntry.isSymbolicLink()) return null;
      const canonicalPath = realpathSync(descriptorPath);
      if (!isContainedPath(canonicalPath, this.snapshotsRoot)) return null;
      if (descriptorEntry.size > this.maxDescriptorBytes) return null;
      const raw = readFileSync(canonicalPath);
      if (raw.byteLength > this.maxDescriptorBytes) return null;
      const descriptor = parseDescriptor(JSON.parse(raw.toString("utf8")), id);
      return descriptor ? { descriptor, bytes: raw.byteLength } : null;
    } catch {
      return null;
    }
  }

  private relativeExistingPath(path: string, expected: "file" | "directory"): string {
    if (!path.trim()) {
      throw new TypeError(`inspection snapshot ${expected} path is required`);
    }
    const candidate = isAbsolute(path) ? resolve(path) : resolve(this.cacheRoot, path);
    let canonical: string;
    try {
      canonical = realpathSync(candidate);
    } catch {
      throw new TypeError(`inspection snapshot ${expected} does not exist`);
    }
    if (!isContainedPath(canonical, this.cacheRoot) || canonical === this.cacheRoot) {
      throw new TypeError(`inspection snapshot ${expected} must be inside the cache root`);
    }
    const entry = statSync(canonical);
    if (expected === "file" ? !entry.isFile() : !entry.isDirectory()) {
      throw new TypeError(`inspection snapshot path is not a ${expected}`);
    }
    return relative(this.cacheRoot, canonical).split(sep).join("/");
  }

  private resolveExistingRelativePath(path: string, expected: "file" | "directory"): string | null {
    if (!isSafeRelativePath(path)) return null;
    try {
      const candidate = resolve(this.cacheRoot, ...path.split("/"));
      if (!isContainedPath(candidate, this.cacheRoot)) return null;
      const canonical = realpathSync(candidate);
      if (!isContainedPath(canonical, this.cacheRoot)) return null;
      const entry = statSync(canonical);
      if (expected === "file" ? !entry.isFile() : !entry.isDirectory()) return null;
      return canonical;
    } catch {
      return null;
    }
  }

  private resolveSourceSubdir(rootDir: string, subdir: string): string | null {
    if (subdir !== "" && !isSafeRelativePath(subdir)) return null;
    try {
      const candidate = subdir ? resolve(rootDir, ...subdir.split("/")) : rootDir;
      if (!isContainedPath(candidate, rootDir)) return null;
      const canonical = realpathSync(candidate);
      if (!isContainedPath(canonical, rootDir) || !isContainedPath(canonical, this.cacheRoot)) return null;
      return statSync(canonical).isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  }

}

/** Opaque ids become directory names, so the accepted alphabet intentionally excludes separators. */
export function isInspectionSnapshotId(value: string | null | undefined): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function requireSnapshotId(value: string): string {
  if (!isInspectionSnapshotId(value)) {
    throw new TypeError("inspection snapshot id must be 1-128 URL-safe opaque characters");
  }
  return value;
}

function shardFor(id: string): string {
  return id.slice(0, 2).padEnd(2, "_");
}

function descriptorKey(id: string): string {
  return `descriptor:${id}`;
}

function byteLimit(value: number | undefined, fallback: number, allowZero: boolean): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < (allowZero ? 0 : 1)) {
    throw new RangeError("inspection snapshot byte limits must be safe positive integers");
  }
  return effective;
}

function validTimestamp(value: string): boolean {
  return value.length <= 64 && Number.isFinite(Date.parse(value));
}

function normalizeBranch(value: string | undefined): string | null {
  if (value === undefined) return null;
  const branch = value.trim();
  if (!branch || branch.length > 1_024 || branch.includes("\0")) {
    throw new TypeError("inspection snapshot branch provenance is invalid");
  }
  return branch;
}

function normalizeSubdir(value: string | undefined): string | null {
  if (value === undefined || value === "") return "";
  if (value.includes("\0")) return null;
  const portable = value.replace(/\\/g, "/");
  if (portable.startsWith("/") || WINDOWS_ABSOLUTE.test(portable)) return null;
  const parts = portable.split("/");
  if (parts.includes("..")) return null;
  return parts.filter((part) => part.length > 0 && part !== ".").join("/");
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || WINDOWS_ABSOLUTE.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isContainedPath(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

/** Create/read one resolver-owned directory without following an injected directory symlink. */
function requirePlainDirectory(path: string, root: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new TypeError("inspection snapshot descriptor path is not a private directory");
  }
  const canonical = realpathSync(path);
  if (!isContainedPath(canonical, root)) {
    throw new TypeError("inspection snapshot descriptor path escapes the cache root");
  }
  return canonical;
}

function normalizeArtifactSource(value: ArtifactSource): ArtifactSource | null {
  if (value.kind === "other") return { kind: "other" };
  if (value.kind !== "github" || !safeSourcePart(value.owner) || !safeSourcePart(value.repo)) return null;
  const subdir = normalizeSubdir(value.subdir);
  if (subdir === null) return null;
  return {
    kind: "github",
    owner: value.owner,
    repo: value.repo,
    ...(subdir ? { subdir } : {}),
  };
}

function safeSourcePart(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\0/\\]/.test(value) && value !== "." && value !== "..";
}

function parseDescriptor(value: unknown, expectedId: string): InspectionSnapshotDescriptor | null {
  if (!isRecord(value)
    || value.formatVersion !== FORMAT_VERSION
    || value.id !== expectedId) return null;
  if (typeof value.publishedAt !== "string" || !validTimestamp(value.publishedAt)) return null;
  const graphSummary = normalizeGraphSummary(value.graphSummary);
  if (!graphSummary) return null;
  if (!isRecord(value.artifact) || !isSafeRelativePath(value.artifact.path)) return null;
  if (value.artifact.vcsBranch !== null && typeof value.artifact.vcsBranch !== "string") return null;
  if (typeof value.artifact.vcsBranch === "string"
    && normalizeBranch(value.artifact.vcsBranch) !== value.artifact.vcsBranch) return null;
  if (!isRecord(value.source) || !isSafeRelativePath(value.source.rootPath)) return null;
  if (typeof value.source.subdir !== "string" || normalizeSubdir(value.source.subdir) !== value.source.subdir) return null;
  const metadata = parseArtifactSource(value.source.metadata);
  if (!metadata) return null;
  const synthetic = parseSyntheticCapabilityReference(value.synthetic, metadata);
  if (value.synthetic !== null && synthetic === null) return null;
  return freezeDescriptor({
    formatVersion: value.formatVersion,
    id: expectedId,
    publishedAt: value.publishedAt,
    graphSummary,
    artifact: { path: value.artifact.path, vcsBranch: value.artifact.vcsBranch },
    source: { rootPath: value.source.rootPath, subdir: value.source.subdir, metadata },
    synthetic,
  });
}

function parseSyntheticCapabilityReference(
  value: unknown,
  source: ArtifactSource,
): InspectionSyntheticCapabilityReference | null {
  if (value === null) return null;
  if (!isRecord(value)
    || Object.keys(value).some((key) => !["path", "sha256", "executionTrust"].includes(key))
    || Object.keys(value).length !== 3
    || !isSafeRelativePath(value.path)
    || typeof value.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  const executionTrust = parseStoredSyntheticExecutionTrust(value.executionTrust, source);
  if (value.executionTrust !== null && executionTrust === null) return null;
  return { path: value.path, sha256: value.sha256, executionTrust };
}

function parseStoredSyntheticExecutionTrust(
  value: unknown,
  source: ArtifactSource,
): InspectionSyntheticExecutionTrust | null {
  if (value === null) return null;
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || value.mode !== "sandboxed-pr"
    || !isRecord(value.provenance)
    || Object.keys(value.provenance).length !== 2
    || typeof value.provenance.repository !== "string"
    || typeof value.provenance.headSha !== "string") return null;
  if (source.kind !== "github"
    || value.provenance.repository !== `${source.owner}/${source.repo}`
    || !/^[0-9a-f]{40,64}$/.test(value.provenance.headSha)) return null;
  return {
    mode: "sandboxed-pr",
    provenance: {
      repository: value.provenance.repository,
      headSha: value.provenance.headSha,
    },
  };
}

function normalizeSyntheticExecutionTrust(
  value: InspectionSyntheticExecutionTrust,
  source: ArtifactSource,
  capability: SyntheticCapabilitySidecar,
): InspectionSyntheticExecutionTrust | null {
  const trust = parseStoredSyntheticExecutionTrust(value, source);
  if (!trust
    || capability.state !== "ready"
    || capability.scenarios.length === 0
    || capability.sourceFingerprint === null
    || capability.artifactCommit !== trust.provenance.headSha) return null;
  return trust;
}

function parseArtifactSource(value: unknown): ArtifactSource | null {
  if (!isRecord(value)) return null;
  if (value.kind === "other") return { kind: "other" };
  if (value.kind !== "github" || typeof value.owner !== "string" || typeof value.repo !== "string") return null;
  if (value.subdir !== undefined && typeof value.subdir !== "string") return null;
  return normalizeArtifactSource({
    kind: "github",
    owner: value.owner,
    repo: value.repo,
    ...(value.subdir === undefined ? {} : { subdir: value.subdir }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeGraphSummary(value: unknown): InspectionGraphSummary | null {
  if (!isRecord(value)
    || typeof value.schemaVersion !== "string" || value.schemaVersion.length === 0 || value.schemaVersion.length > 64
    || typeof value.generatedAt !== "string" || !validTimestamp(value.generatedAt)
    || !Number.isSafeInteger(value.nodeCount) || (value.nodeCount as number) < 0
    || !Number.isSafeInteger(value.edgeCount) || (value.edgeCount as number) < 0) {
    return null;
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    generatedAt: value.generatedAt,
    nodeCount: value.nodeCount as number,
    edgeCount: value.edgeCount as number,
  });
}

/** Build descriptor metadata while the publishing pipeline already owns the extracted artifact. */
export function graphSummaryFor(artifact: GraphArtifact): InspectionGraphSummary {
  return Object.freeze({
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    nodeCount: artifact.nodes.length,
    edgeCount: artifact.edges.length,
  });
}

function freezeDescriptor(descriptor: InspectionSnapshotDescriptor): InspectionSnapshotDescriptor {
  Object.freeze(descriptor.source.metadata);
  Object.freeze(descriptor.graphSummary);
  Object.freeze(descriptor.artifact);
  Object.freeze(descriptor.source);
  if (descriptor.synthetic) {
    if (descriptor.synthetic.executionTrust) {
      Object.freeze(descriptor.synthetic.executionTrust.provenance);
      Object.freeze(descriptor.synthetic.executionTrust);
    }
    Object.freeze(descriptor.synthetic);
  }
  return Object.freeze(descriptor);
}

function sameSnapshotTarget(left: InspectionSnapshotDescriptor, right: InspectionSnapshotDescriptor): boolean {
  return left.id === right.id
    && left.artifact.path === right.artifact.path
    && left.artifact.vcsBranch === right.artifact.vcsBranch
    && left.source.rootPath === right.source.rootPath
    && left.source.subdir === right.source.subdir
    && JSON.stringify(left.source.metadata) === JSON.stringify(right.source.metadata)
    && JSON.stringify(left.synthetic) === JSON.stringify(right.synthetic);
}

type CacheKind = "descriptor";

interface MemoryEntry {
  kind: CacheKind;
  value: unknown;
  bytes: number;
}

/** Byte-aware descriptor LRU; graph bytes and GraphArtifact objects are never admitted. */
class ByteAwareLru {
  private readonly entries = new Map<string, MemoryEntry>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private oversizeSkips = 0;

  constructor(private readonly maxBytes: number) {}

  get<T>(key: string, kind: CacheKind): T | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.kind !== kind) {
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value as T;
  }

  set(key: string, kind: CacheKind, value: unknown, bytes: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
    }
    const weight = Math.max(1, bytes);
    if (this.maxBytes === 0 || weight > this.maxBytes) {
      this.oversizeSkips += 1;
      return;
    }
    this.entries.set(key, { kind, value, bytes: weight });
    this.bytes += weight;
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, MemoryEntry] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
      this.evictions += 1;
    }
  }

  stats(): InspectionSnapshotCacheStats {
    return {
      maxBytes: this.maxBytes,
      bytes: this.bytes,
      entries: this.entries.size,
      artifactEntries: 0,
      descriptorEntries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      oversizeSkips: this.oversizeSkips,
    };
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.oversizeSkips = 0;
  }
}
