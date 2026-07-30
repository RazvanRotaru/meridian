import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { throwIfAborted } from "./web-cancellation";

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_HIGH_WATER_BYTES = 8 * GIB;
const DEFAULT_LOW_WATER_BYTES = 6 * GIB;
const DEFAULT_MAX_IDLE_MS = 30 * DAY_MS;
const DEFAULT_MAX_SCAN_ENTRIES = 500_000;
const TRASH_DIRECTORY = ".retention-trash";
const MAX_REVISION_MANIFEST_ADMISSION_BYTES = 1024 * 1024;
const IMMUTABLE_JSON_FORMAT = "meridian.incremental-poc.immutable-json.v1";
const IMMUTABLE_JSON_ENVELOPE_KEYS = [
  "address",
  "format",
  "payloadDigest",
  "value",
] as const;
const REVISION_MANIFEST_ADMISSION_KEYS = [
  "keyId",
  "manifestAddress",
  "manifestPayloadDigest",
  "manifestSchemaVersion",
  "normalizedResultDigest",
  "requestKey",
  "shardSchemaVersion",
  "signature",
  "treeOid",
  "version",
] as const;
const IMMUTABLE_PRODUCER_TEMPORARY = /^([a-f0-9]{64})\.json\.([1-9][0-9]{0,9})\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.tmp$/;

type CacheFileKind =
  | "candidate"
  | "admission"
  | "revision-manifest-admission"
  | "shard"
  | "semantic-region-shard"
  | "semantic-region-context"
  | "manifest";
type EvictionUnitKind =
  | "shard-group"
  | "semantic-region-group"
  | "semantic-region-context"
  | "revision-manifest-admission"
  | "manifest";
type RetentionReason = "orphan" | "max-idle" | "capacity";

/** Fully resolved policy for one explicitly scheduled TypeScript shard-cache sweep. */
export interface TypeScriptRevisionShardRetentionPolicy {
  readonly highWaterBytes: number;
  readonly lowWaterBytes: number;
  readonly maxIdleMs: number;
  /** Hard bound across stale-trash cleanup and the active CAS scan. */
  readonly maxScanEntries: number;
  /** Test seam for deterministic age decisions and reports. */
  readonly now?: () => number;
}

/**
 * The producer's exclusive lock must cover the complete callback. Returning `undefined` means the
 * lock was busy and makes the sweep a no-op. Retention deliberately has no uncoordinated mode.
 */
export type TypeScriptRevisionShardRetentionExclusive = <Result>(
  operation: () => Promise<Result>,
) => Promise<Result | undefined>;

export interface TypeScriptRevisionShardRetentionDecision {
  readonly id: string;
  readonly kind: EvictionUnitKind;
  readonly reason: RetentionReason;
  readonly sizeBytes: number;
  readonly lastAccessMs: number;
}

export interface TypeScriptRevisionShardRetentionDeletedFile {
  /** Cache-root-relative logical path. The private trash path is intentionally not exposed. */
  readonly path: string;
  readonly kind: CacheFileKind;
  readonly reason: RetentionReason;
  readonly sizeBytes: number;
}

export interface TypeScriptRevisionShardRetentionSkippedEntry {
  readonly path: string;
  readonly reason:
    | "unsafe-entry"
    | "changed-during-sweep"
    | "quarantine-failed"
    | "support-delete-failed"
    | "temporary-cleanup-failed";
}

export interface TypeScriptRevisionShardRetentionReport {
  readonly status: "completed" | "skipped";
  readonly reason:
    | null
    | "exclusive-coordination-unavailable"
    | "exclusive-coordination-busy"
    | "scan-limit-exceeded"
    | "unsafe-cache-layout"
    | "unsafe-cache-root"
    | "unsafe-trash-root";
  readonly nowMs: number;
  readonly observedBytes: number;
  readonly observedFiles: number;
  readonly remainingBytes: number;
  readonly capacityPressure: boolean;
  readonly drainedTrashBytes: number;
  /** Physical bytes reclaimed from exact interrupted immutable-publication temporary files. */
  readonly drainedTemporaryBytes: number;
  readonly deletedBytes: number;
  readonly decisions: readonly TypeScriptRevisionShardRetentionDecision[];
  readonly deletedFiles: readonly TypeScriptRevisionShardRetentionDeletedFile[];
  readonly skippedEntries: readonly TypeScriptRevisionShardRetentionSkippedEntry[];
}

export interface SweepTypeScriptRevisionShardCacheOptions {
  /** One mode namespace, for example `shadow-admitted`, not the parent cache root. */
  readonly cacheDir: string;
  readonly policy?: Partial<TypeScriptRevisionShardRetentionPolicy>;
  readonly exclusive?: TypeScriptRevisionShardRetentionExclusive;
  readonly signal?: AbortSignal;
  /** Test seam for proving dependent payload/context preservation after quarantine failures. */
  readonly quarantineRename?: (source: string, destination: string) => Promise<void>;
}

interface ScannedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: CacheFileKind;
  readonly address: string;
  readonly sizeBytes: number;
  readonly lastAccessMs: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedMs: number;
  /** Context digest derived from the validated context-scoped semantic-shard directory. */
  readonly semanticContextAddress?: string;
  /** Exact tree encoded by a validated manifest path. */
  readonly manifestTreeOid?: string;
  /**
   * Untrusted-but-structurally-validated association from an exact-request admission receipt.
   * Cryptographic admission is still verified exclusively by the extractor before reuse.
   */
  readonly revisionManifestReference?: {
    readonly treeOid: string;
    readonly manifestAddress: string;
  };
}

interface StructurallyValidRevisionManifestAdmission {
  readonly version: 1;
  readonly shardSchemaVersion: number;
  readonly manifestSchemaVersion: number;
  readonly requestKey: string;
  readonly treeOid: string;
  readonly manifestAddress: string;
  readonly manifestPayloadDigest: string;
  readonly normalizedResultDigest: string;
  readonly keyId: string;
  readonly signature: string;
}

interface EvictionUnit {
  readonly id: string;
  readonly kind: EvictionUnitKind;
  readonly files: readonly ScannedFile[];
  readonly sizeBytes: number;
  readonly lastAccessMs: number;
  readonly orphan: boolean;
}

interface ScanState {
  entries: number;
  readonly maxEntries: number;
}

interface CacheScan {
  readonly files: readonly ScannedFile[];
  readonly drainedTemporaryBytes: number;
  readonly skipped: readonly TypeScriptRevisionShardRetentionSkippedEntry[];
}

interface MutableReport {
  status: "completed" | "skipped";
  reason: TypeScriptRevisionShardRetentionReport["reason"];
  nowMs: number;
  observedBytes: number;
  observedFiles: number;
  remainingBytes: number;
  capacityPressure: boolean;
  drainedTrashBytes: number;
  drainedTemporaryBytes: number;
  deletedBytes: number;
  decisions: TypeScriptRevisionShardRetentionDecision[];
  deletedFiles: TypeScriptRevisionShardRetentionDeletedFile[];
  skippedEntries: TypeScriptRevisionShardRetentionSkippedEntry[];
}

class ScanLimitError extends Error {}

class UnsafeCacheLayoutError extends Error {
  constructor(readonly paths: readonly string[]) {
    super("TypeScript revision shard cache layout is ambiguous");
  }
}

/**
 * Apply the default 8 GiB high / 6 GiB low hysteresis and 30-day idle lifetime.
 *
 * This is intentionally a one-shot primitive: callers schedule it away from request hot paths and
 * supply the same exclusive boundary used by shard publication.
 */
export function resolveTypeScriptRevisionShardRetentionPolicy(
  options: Partial<TypeScriptRevisionShardRetentionPolicy> = {},
): TypeScriptRevisionShardRetentionPolicy {
  const highWaterBytes = options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
  const lowWaterBytes = options.lowWaterBytes ?? (
    options.highWaterBytes === undefined
      ? DEFAULT_LOW_WATER_BYTES
      : Math.floor(highWaterBytes * 0.75)
  );
  const maxIdleMs = options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
  const maxScanEntries = options.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES;

  requirePositiveSafeInteger(highWaterBytes, "highWaterBytes");
  requireNonNegativeSafeInteger(lowWaterBytes, "lowWaterBytes");
  if (lowWaterBytes >= highWaterBytes) {
    throw new RangeError("lowWaterBytes must be less than highWaterBytes");
  }
  requirePositiveSafeInteger(maxIdleMs, "maxIdleMs");
  requirePositiveSafeInteger(maxScanEntries, "maxScanEntries");
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("now must be a function");
  }

  return {
    highWaterBytes,
    lowWaterBytes,
    maxIdleMs,
    maxScanEntries,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

/**
 * Run one bounded, no-follow retention pass.
 *
 * No directory is scanned until the caller's exclusive callback has entered. Candidate references
 * and admission receipts are quarantined before their shard. A crash after rename leaves only
 * private trash, which the next pass drains without following links.
 */
export async function sweepTypeScriptRevisionShardCache(
  options: SweepTypeScriptRevisionShardCacheOptions,
): Promise<TypeScriptRevisionShardRetentionReport> {
  const policy = resolveTypeScriptRevisionShardRetentionPolicy(options.policy);
  const nowMs = policy.now?.() ?? Date.now();
  requireNonNegativeSafeInteger(nowMs, "now");
  const empty = emptyReport(nowMs);
  if (!isAbsolute(options.cacheDir)) {
    throw new TypeError("TypeScript revision shard retention cacheDir must be absolute");
  }
  const cacheDir = resolve(options.cacheDir);
  if (dirname(cacheDir) === cacheDir) {
    throw new TypeError("TypeScript revision shard retention cacheDir must not be a filesystem root");
  }
  if (options.exclusive === undefined) {
    return {
      ...empty,
      status: "skipped",
      reason: "exclusive-coordination-unavailable",
    };
  }

  const report = await options.exclusive(() => sweepExclusive({
    cacheDir,
    policy,
    nowMs,
    signal: options.signal,
    quarantineRename: options.quarantineRename ?? rename,
  }));
  return report ?? {
    ...empty,
    status: "skipped",
    reason: "exclusive-coordination-busy",
  };
}

async function sweepExclusive(inputs: {
  cacheDir: string;
  policy: TypeScriptRevisionShardRetentionPolicy;
  nowMs: number;
  signal?: AbortSignal;
  quarantineRename: (source: string, destination: string) => Promise<void>;
}): Promise<TypeScriptRevisionShardRetentionReport> {
  throwIfAborted(inputs.signal);
  const report = emptyReport(inputs.nowMs);
  const rootState = await realDirectoryState(inputs.cacheDir);
  if (rootState === "missing") return report;
  if (rootState !== "directory") {
    return { ...report, status: "skipped", reason: "unsafe-cache-root" };
  }

  const scanState: ScanState = { entries: 0, maxEntries: inputs.policy.maxScanEntries };
  try {
    const trash = await drainTrash(inputs.cacheDir, scanState, inputs.signal);
    if (trash.unsafe) {
      return {
        ...report,
        status: "skipped",
        reason: "unsafe-trash-root",
        skippedEntries: [{ path: TRASH_DIRECTORY, reason: "unsafe-entry" }],
      };
    }
    report.drainedTrashBytes = trash.removedBytes;

    const scan = await scanCache(inputs.cacheDir, scanState, inputs.signal);
    appendAll(report.skippedEntries, scan.skipped);
    report.drainedTemporaryBytes = scan.drainedTemporaryBytes;
    report.observedFiles = scan.files.length;
    report.observedBytes = sumSafe(scan.files.map(({ sizeBytes }) => sizeBytes), "cache bytes");
    report.remainingBytes = report.observedBytes;

    const units = buildEvictionUnits(scan.files);
    const decisions = selectEvictions(units, report.observedBytes, inputs.policy, inputs.nowMs);
    report.capacityPressure = decisions.capacityPressure;
    for (const { unit, reason } of decisions.selected) {
      report.decisions.push({
        id: unit.id,
        kind: unit.kind,
        reason,
        sizeBytes: unit.sizeBytes,
        lastAccessMs: unit.lastAccessMs,
      });
    }

    if (decisions.selected.length === 0) return report;
    const trashRun = await createTrashRun(inputs.cacheDir);
    let sequence = 0;
    try {
      for (const decision of decisions.selected) {
        throwIfAborted(inputs.signal);
        const result = await evictUnit(
          inputs.cacheDir,
          trashRun,
          decision.unit,
          decision.reason,
          sequence,
          inputs.signal,
          inputs.quarantineRename,
        );
        sequence = result.nextSequence;
        appendAll(report.deletedFiles, result.deleted);
        appendAll(report.skippedEntries, result.skipped);
      }
    } finally {
      await rmdir(trashRun).catch(() => undefined);
      await rmdir(join(inputs.cacheDir, TRASH_DIRECTORY)).catch(() => undefined);
    }
    report.deletedBytes = sumSafe(
      report.deletedFiles.map(({ sizeBytes }) => sizeBytes),
      "deleted cache bytes",
    );
    report.remainingBytes = Math.max(0, report.observedBytes - report.deletedBytes);
    return report;
  } catch (error) {
    if (error instanceof UnsafeCacheLayoutError) {
      return {
        ...report,
        status: "skipped",
        reason: "unsafe-cache-layout",
        remainingBytes: report.observedBytes,
        capacityPressure: false,
        decisions: [],
        deletedFiles: [],
        skippedEntries: [
          ...report.skippedEntries,
          ...error.paths.map((path) => ({
            path,
            reason: "unsafe-entry" as const,
          })),
        ],
      };
    }
    if (!(error instanceof ScanLimitError)) throw error;
    return {
      ...report,
      status: "skipped",
      reason: "scan-limit-exceeded",
      observedBytes: 0,
      observedFiles: 0,
      remainingBytes: 0,
      capacityPressure: false,
      decisions: [],
      deletedFiles: [],
      skippedEntries: [],
    };
  }
}

async function scanCache(
  cacheDir: string,
  state: ScanState,
  signal?: AbortSignal,
): Promise<CacheScan> {
  const files: ScannedFile[] = [];
  const skipped: TypeScriptRevisionShardRetentionSkippedEntry[] = [];
  let drainedTemporaryBytes = 0;
  drainedTemporaryBytes = addSafe(
    drainedTemporaryBytes,
    await scanFamily(cacheDir, "shards", [isPrefix], "shard", files, skipped, state, signal),
    "drained temporary bytes",
  );
  drainedTemporaryBytes = addSafe(
    drainedTemporaryBytes,
    await scanFamily(
      cacheDir,
      "semantic-region-shards",
      [isSha256, isPrefix],
      "semantic-region-shard",
      files,
      skipped,
      state,
      signal,
    ),
    "drained temporary bytes",
  );
  drainedTemporaryBytes = addSafe(
    drainedTemporaryBytes,
    await scanFamily(
      cacheDir,
      "semantic-region-contexts",
      [isPrefix],
      "semantic-region-context",
      files,
      skipped,
      state,
      signal,
    ),
    "drained temporary bytes",
  );
  drainedTemporaryBytes = addSafe(
    drainedTemporaryBytes,
    await scanFamily(
      cacheDir,
      "candidates",
      [isSha256, isPrefix],
      "candidate",
      files,
      skipped,
      state,
      signal,
    ),
    "drained temporary bytes",
  );
  drainedTemporaryBytes = addSafe(
    drainedTemporaryBytes,
    await scanFamily(
      cacheDir,
      "admissions",
      [isSha256, isPrefix],
      "admission",
      files,
      skipped,
      state,
      signal,
    ),
    "drained temporary bytes",
  );
  drainedTemporaryBytes = addSafe(
    drainedTemporaryBytes,
    await scanFamily(
      cacheDir,
      "manifests",
      [isGitOid, isPrefix],
      "manifest",
      files,
      skipped,
      state,
      signal,
    ),
    "drained temporary bytes",
  );
  drainedTemporaryBytes = addSafe(
    drainedTemporaryBytes,
    await scanFamily(
      cacheDir,
      "revision-manifest-admissions",
      [isSha256, isPrefix],
      "revision-manifest-admission",
      files,
      skipped,
      state,
      signal,
    ),
    "drained temporary bytes",
  );
  files.sort((left, right) => compareNames(left.relativePath, right.relativePath));
  skipped.sort((left, right) => compareNames(left.path, right.path));
  return { files, drainedTemporaryBytes, skipped };
}

async function scanFamily(
  cacheDir: string,
  family: string,
  directoryValidators: readonly ((name: string) => boolean)[],
  kind: CacheFileKind,
  files: ScannedFile[],
  skipped: TypeScriptRevisionShardRetentionSkippedEntry[],
  state: ScanState,
  signal?: AbortSignal,
): Promise<number> {
  const root = join(cacheDir, family);
  const rootState = await realDirectoryState(root);
  if (rootState === "missing") return 0;
  if (rootState !== "directory") {
    skipped.push({ path: family, reason: "unsafe-entry" });
    return 0;
  }
  return scanDirectoryLevel(
    cacheDir,
    root,
    directoryValidators,
    0,
    kind,
    files,
    skipped,
    state,
    signal,
  );
}

async function scanDirectoryLevel(
  cacheDir: string,
  directory: string,
  validators: readonly ((name: string) => boolean)[],
  level: number,
  kind: CacheFileKind,
  files: ScannedFile[],
  skipped: TypeScriptRevisionShardRetentionSkippedEntry[],
  state: ScanState,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const terminal = level >= validators.length;
  const entries = (await readdir(directory)).sort(
    terminal ? compareTerminalNames : compareNames,
  );
  let drainedTemporaryBytes = 0;
  for (const name of entries) {
    consumeScanEntry(state);
    throwIfAborted(signal);
    const path = join(directory, name);
    const relativePath = relativeCachePath(cacheDir, path);
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (level < validators.length) {
      if (
        !validators[level]!(name)
        || !stats.isDirectory()
        || stats.isSymbolicLink()
      ) {
        skipped.push({ path: relativePath, reason: "unsafe-entry" });
        continue;
      }
      drainedTemporaryBytes = addSafe(
        drainedTemporaryBytes,
        await scanDirectoryLevel(
          cacheDir,
          path,
          validators,
          level + 1,
          kind,
          files,
          skipped,
          state,
          signal,
        ),
        "drained temporary bytes",
      );
      continue;
    }

    const temporary = immutableProducerTemporary(name, basename(directory));
    if (temporary !== null) {
      const cleanup = await cleanupImmutableProducerTemporary(
        directory,
        path,
        temporary.address,
        stats,
      );
      if (cleanup === "unsafe") {
        skipped.push({ path: relativePath, reason: "unsafe-entry" });
      } else if (cleanup === "failed") {
        skipped.push({ path: relativePath, reason: "temporary-cleanup-failed" });
      } else {
        drainedTemporaryBytes = addSafe(
          drainedTemporaryBytes,
          cleanup,
          "drained temporary bytes",
        );
      }
      continue;
    }

    const match = /^([a-f0-9]{64})\.json$/.exec(name);
    const prefix = basename(directory);
    if (
      match === null
      || !match[1]!.startsWith(prefix)
      || !stats.isFile()
      || stats.isSymbolicLink()
      || stats.nlink !== 1
      || !Number.isSafeInteger(stats.size)
      || stats.size < 0
    ) {
      skipped.push({ path: relativePath, reason: "unsafe-entry" });
      continue;
    }
    const semanticContextAddress = kind === "semantic-region-shard"
      ? basename(dirname(directory))
      : undefined;
    const manifestTreeOid = kind === "manifest"
      ? basename(dirname(directory))
      : undefined;
    const revisionManifestReference = kind === "revision-manifest-admission"
      ? await readRevisionManifestReference({
        path,
        stats,
        requestKey: match[1]!,
        keyId: basename(dirname(directory)),
      })
      : undefined;
    files.push({
      absolutePath: path,
      relativePath,
      kind,
      address: match[1]!,
      sizeBytes: stats.size,
      lastAccessMs: safeTimestamp(Math.max(stats.atimeMs, stats.mtimeMs)),
      device: stats.dev,
      inode: stats.ino,
      modifiedMs: stats.mtimeMs,
      ...(semanticContextAddress === undefined ? {} : { semanticContextAddress }),
      ...(manifestTreeOid === undefined ? {} : { manifestTreeOid }),
      ...(revisionManifestReference === undefined ? {} : { revisionManifestReference }),
    });
  }
  return drainedTemporaryBytes;
}

async function readRevisionManifestReference(inputs: {
  path: string;
  stats: Stats;
  requestKey: string;
  keyId: string;
}): Promise<ScannedFile["revisionManifestReference"] | undefined> {
  if (inputs.stats.size > MAX_REVISION_MANIFEST_ADMISSION_BYTES) return undefined;
  let handle;
  try {
    handle = await open(inputs.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const before = await handle.stat();
    if (!sameScannedFile(before, inputs.stats)) return undefined;
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== inputs.stats.size
      || !sameScannedFile(after, inputs.stats)
    ) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return undefined;
    }
    return revisionManifestReferenceFromEnvelope(value, inputs);
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function revisionManifestReferenceFromEnvelope(
  value: unknown,
  expected: { requestKey: string; keyId: string },
): ScannedFile["revisionManifestReference"] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  const envelopeKeys = Object.keys(envelope).sort(compareNames);
  if (
    envelopeKeys.length !== IMMUTABLE_JSON_ENVELOPE_KEYS.length
    || envelopeKeys.some((key, index) => key !== IMMUTABLE_JSON_ENVELOPE_KEYS[index])
    || envelope.address !== expected.requestKey
    || envelope.format !== IMMUTABLE_JSON_FORMAT
    || typeof envelope.payloadDigest !== "string"
    || !isSha256(envelope.payloadDigest)
    || !isRevisionManifestAdmissionReference(envelope.value, expected)
  ) {
    return undefined;
  }
  const payloadDigest = canonicalRevisionManifestAdmissionSha256(envelope.value);
  if (payloadDigest !== envelope.payloadDigest) return undefined;
  return {
    treeOid: envelope.value.treeOid,
    manifestAddress: envelope.value.manifestAddress,
  };
}

function isRevisionManifestAdmissionReference(
  value: unknown,
  expected: { requestKey: string; keyId: string },
): value is StructurallyValidRevisionManifestAdmission {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt).sort(compareNames);
  if (
    keys.length !== REVISION_MANIFEST_ADMISSION_KEYS.length
    || keys.some((key, index) => key !== REVISION_MANIFEST_ADMISSION_KEYS[index])
  ) {
    return false;
  }
  return receipt.version === 1
    && isPositiveSafeInteger(receipt.shardSchemaVersion)
    && isPositiveSafeInteger(receipt.manifestSchemaVersion)
    && receipt.requestKey === expected.requestKey
    && receipt.keyId === expected.keyId
    && typeof receipt.treeOid === "string"
    && isGitOid(receipt.treeOid)
    && typeof receipt.manifestAddress === "string"
    && isSha256(receipt.manifestAddress)
    && typeof receipt.manifestPayloadDigest === "string"
    && isSha256(receipt.manifestPayloadDigest)
    && typeof receipt.normalizedResultDigest === "string"
    && isSha256(receipt.normalizedResultDigest)
    && typeof receipt.signature === "string";
}

function canonicalRevisionManifestAdmissionSha256(
  receipt: StructurallyValidRevisionManifestAdmission,
): string {
  const canonical = `{${REVISION_MANIFEST_ADMISSION_KEYS.map((key) => (
    `${JSON.stringify(key)}:${JSON.stringify(receipt[key])}`
  )).join(",")}}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function sameScannedFile(left: Stats, right: Stats): boolean {
  return left.isFile()
    && !left.isSymbolicLink()
    && left.nlink === 1
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function immutableProducerTemporary(
  name: string,
  prefix: string,
): { address: string } | null {
  const match = IMMUTABLE_PRODUCER_TEMPORARY.exec(name);
  if (match === null || !match[1]!.startsWith(prefix)) return null;
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid) && pid > 0 ? { address: match[1]! } : null;
}

async function cleanupImmutableProducerTemporary(
  directory: string,
  path: string,
  address: string,
  stats: Stats,
): Promise<number | "unsafe" | "failed"> {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || (stats.nlink !== 1 && stats.nlink !== 2)
    || !Number.isSafeInteger(stats.size)
    || stats.size < 0
  ) {
    return "unsafe";
  }
  if (stats.nlink === 2) {
    let canonical: Stats;
    try {
      canonical = await lstat(join(directory, `${address}.json`));
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "unsafe" : "failed";
    }
    if (
      !canonical.isFile()
      || canonical.isSymbolicLink()
      || canonical.nlink !== 2
      || canonical.dev !== stats.dev
      || canonical.ino !== stats.ino
    ) {
      return "unsafe";
    }
  }
  try {
    await unlink(path);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? 0 : "failed";
  }
  return stats.nlink === 1 ? stats.size : 0;
}

function buildEvictionUnits(files: readonly ScannedFile[]): EvictionUnit[] {
  const shardGroups = new Map<string, {
    shard?: ScannedFile;
    semanticShard?: ScannedFile;
    candidates: ScannedFile[];
    admissions: ScannedFile[];
  }>();
  const semanticContexts = new Map<string, ScannedFile>();
  const manifestsByIdentity = new Map<string, ScannedFile>();
  const revisionManifestAdmissions: ScannedFile[] = [];
  for (const file of files) {
    if (file.kind === "manifest") {
      if (file.manifestTreeOid === undefined) {
        throw new UnsafeCacheLayoutError([file.relativePath]);
      }
      const identity = revisionManifestIdentity(file.manifestTreeOid, file.address);
      const existing = manifestsByIdentity.get(identity);
      if (existing !== undefined) {
        throw new UnsafeCacheLayoutError(
          [existing.relativePath, file.relativePath].sort(compareNames),
        );
      }
      manifestsByIdentity.set(identity, file);
      continue;
    }
    if (file.kind === "revision-manifest-admission") {
      revisionManifestAdmissions.push(file);
      continue;
    }
    if (file.kind === "semantic-region-context") {
      semanticContexts.set(file.address, file);
      continue;
    }
    const group = shardGroups.get(file.address) ?? { candidates: [], admissions: [] };
    if (file.kind === "shard") group.shard = file;
    if (file.kind === "semantic-region-shard") {
      if (group.semanticShard !== undefined) {
        throw new UnsafeCacheLayoutError([
          group.semanticShard.relativePath,
          file.relativePath,
        ].sort(compareNames));
      }
      group.semanticShard = file;
    }
    if (file.kind === "candidate") group.candidates.push(file);
    if (file.kind === "admission") group.admissions.push(file);
    shardGroups.set(file.address, group);
  }

  // One context may back many independently addressed regions. Group every region, its shared
  // admission receipts, and the context into one eviction unit. Receipt-less shadow staging is
  // either retained with an admitted sibling or reclaimed coherently with its otherwise-unreachable
  // context. A pathologically colliding complete unit address joins the same group so no shared
  // receipt is double-owned.
  const semanticRegionsByContext = new Map<string, Array<{
    address: string;
    group: {
      shard?: ScannedFile;
      semanticShard?: ScannedFile;
      candidates: ScannedFile[];
      admissions: ScannedFile[];
    };
  }>>();
  for (const [address, group] of shardGroups) {
    const contextAddress = group.semanticShard?.semanticContextAddress;
    if (
      contextAddress === undefined
      || !semanticContexts.has(contextAddress)
    ) {
      continue;
    }
    const regions = semanticRegionsByContext.get(contextAddress) ?? [];
    regions.push({ address, group });
    semanticRegionsByContext.set(contextAddress, regions);
  }

  const claimedShardAddresses = new Set<string>();
  const claimedContextAddresses = new Set<string>();
  const semanticGroups = [...semanticRegionsByContext.entries()]
    .sort(([left], [right]) => compareNames(left, right))
    .map(([contextAddress, regions]): EvictionUnit => {
      const context = semanticContexts.get(contextAddress)!;
      claimedContextAddresses.add(contextAddress);
      regions.sort((left, right) => compareNames(left.address, right.address));
      const supportFiles: ScannedFile[] = [];
      const payloadFiles: ScannedFile[] = [];
      for (const { address, group } of regions) {
        claimedShardAddresses.add(address);
        group.candidates.sort(compareFiles);
        group.admissions.sort(compareFiles);
        appendAll(supportFiles, group.candidates);
        appendAll(supportFiles, group.admissions);
        if (group.semanticShard !== undefined) payloadFiles.push(group.semanticShard);
        if (group.shard !== undefined) payloadFiles.push(group.shard);
      }
      const filesInDeleteOrder = [...supportFiles, ...payloadFiles, context];
      return {
        id: `semantic-context:${contextAddress}`,
        kind: "semantic-region-group",
        files: filesInDeleteOrder,
        sizeBytes: sumSafe(
          filesInDeleteOrder.map(({ sizeBytes }) => sizeBytes),
          "semantic-region group bytes",
        ),
        // A single recently read region keeps its complete shared context group alive.
        lastAccessMs: latestAccess(filesInDeleteOrder),
        orphan: !regions.some(({ group }) => group.admissions.length > 0),
      };
    });

  const groups = [...shardGroups.entries()]
    .filter(([address]) => !claimedShardAddresses.has(address))
    .map(([address, group]): EvictionUnit => {
      group.candidates.sort(compareFiles);
      group.admissions.sort(compareFiles);
      const filesInDeleteOrder = [
        ...group.candidates,
        ...group.admissions,
        ...(group.semanticShard === undefined ? [] : [group.semanticShard]),
        ...(group.shard === undefined ? [] : [group.shard]),
      ];
      const isSemanticOnly = group.semanticShard !== undefined
        && group.shard === undefined
        && group.candidates.length === 0;
      return {
        id: isSemanticOnly ? `semantic-region:${address}` : `shard:${address}`,
        kind: isSemanticOnly ? "semantic-region-group" : "shard-group",
        files: filesInDeleteOrder,
        sizeBytes: sumSafe(
          filesInDeleteOrder.map(({ sizeBytes }) => sizeBytes),
          "shard group bytes",
        ),
        lastAccessMs: latestAccess(filesInDeleteOrder),
        // A candidate is the lookup path and an admission receipt is the authority to reuse it.
        // Shadow publishes both only after oracle parity; a killed staging run may leave shard plus
        // candidate but no receipt, which is deliberately unreachable and reclaimable.
        orphan: group.shard === undefined
          || group.candidates.length === 0
          || group.admissions.length === 0,
      };
    });
  const orphanedContexts = [...semanticContexts.entries()]
    .filter(([address]) => !claimedContextAddresses.has(address))
    .map(([address, context]): EvictionUnit => ({
      id: `semantic-context:${address}`,
      kind: "semantic-region-context",
      files: [context],
      sizeBytes: context.sizeBytes,
      lastAccessMs: context.lastAccessMs,
      orphan: true,
    }));
  const admissionsByManifest = new Map<string, ScannedFile[]>();
  const orphanedManifestAdmissions: EvictionUnit[] = [];
  for (const admission of revisionManifestAdmissions.sort(compareFiles)) {
    const reference = admission.revisionManifestReference;
    const identity = reference === undefined
      ? undefined
      : revisionManifestIdentity(reference.treeOid, reference.manifestAddress);
    if (identity === undefined || !manifestsByIdentity.has(identity)) {
      orphanedManifestAdmissions.push({
        id: `revision-manifest-admission:${admission.relativePath}`,
        kind: "revision-manifest-admission",
        files: [admission],
        sizeBytes: admission.sizeBytes,
        lastAccessMs: admission.lastAccessMs,
        orphan: true,
      });
      continue;
    }
    const associated = admissionsByManifest.get(identity) ?? [];
    associated.push(admission);
    admissionsByManifest.set(identity, associated);
  }
  const manifests = [...manifestsByIdentity.entries()]
    .sort(([left], [right]) => compareNames(left, right))
    .map(([identity, manifest]): EvictionUnit => {
      const admissions = (admissionsByManifest.get(identity) ?? []).sort(compareFiles);
      const filesInDeleteOrder = [...admissions, manifest];
      return {
        id: `manifest:${manifest.relativePath}`,
        kind: "manifest",
        files: filesInDeleteOrder,
        sizeBytes: sumSafe(
          filesInDeleteOrder.map(({ sizeBytes }) => sizeBytes),
          "manifest group bytes",
        ),
        // Retention must inspect the index payload to find this association, which can itself
        // advance the index atime. A successful exact hit also reads the manifest, so the payload
        // timestamp is the non-self-heating LRU signal for the whole support group.
        lastAccessMs: manifest.lastAccessMs,
        orphan: false,
      };
    });
  return requireEvictionPartition(
    files,
    [
      ...groups,
      ...semanticGroups,
      ...orphanedContexts,
      ...orphanedManifestAdmissions,
      ...manifests,
    ].sort(compareUnits),
  );
}

function revisionManifestIdentity(treeOid: string, manifestAddress: string): string {
  return `${treeOid}:${manifestAddress}`;
}

function requireEvictionPartition(
  scanned: readonly ScannedFile[],
  units: readonly EvictionUnit[],
): EvictionUnit[] {
  const expected = new Map(scanned.map((file) => [file.relativePath, file]));
  const claimed = new Set<string>();
  for (const unit of units) {
    for (const file of unit.files) {
      if (!expected.has(file.relativePath) || claimed.has(file.relativePath)) {
        throw new UnsafeCacheLayoutError([file.relativePath]);
      }
      claimed.add(file.relativePath);
    }
  }
  if (claimed.size !== expected.size) {
    const missing = [...expected.keys()]
      .filter((path) => !claimed.has(path))
      .sort(compareNames)
      .slice(0, 2);
    throw new UnsafeCacheLayoutError(missing);
  }
  const scannedBytes = sumSafe(scanned.map(({ sizeBytes }) => sizeBytes), "scanned cache bytes");
  const groupedBytes = sumSafe(units.map(({ sizeBytes }) => sizeBytes), "grouped cache bytes");
  if (scannedBytes !== groupedBytes) {
    throw new UnsafeCacheLayoutError([]);
  }
  return [...units];
}

function selectEvictions(
  units: readonly EvictionUnit[],
  observedBytes: number,
  policy: TypeScriptRevisionShardRetentionPolicy,
  nowMs: number,
): {
  selected: Array<{ unit: EvictionUnit; reason: RetentionReason }>;
  capacityPressure: boolean;
} {
  const selected: Array<{ unit: EvictionUnit; reason: RetentionReason }> = [];
  const selectedIds = new Set<string>();
  let projectedBytes = observedBytes;
  const add = (unit: EvictionUnit, reason: RetentionReason): void => {
    if (selectedIds.has(unit.id)) return;
    selectedIds.add(unit.id);
    selected.push({ unit, reason });
    projectedBytes = Math.max(0, projectedBytes - unit.sizeBytes);
  };

  for (const unit of units) {
    if (unit.orphan) add(unit, "orphan");
  }
  for (const unit of units) {
    if (!unit.orphan && nowMs - unit.lastAccessMs >= policy.maxIdleMs) {
      add(unit, "max-idle");
    }
  }
  const capacityPressure = projectedBytes > policy.highWaterBytes;
  if (capacityPressure) {
    for (const unit of units) {
      if (projectedBytes <= policy.lowWaterBytes) break;
      add(unit, "capacity");
    }
  }
  return { selected, capacityPressure };
}

async function evictUnit(
  cacheDir: string,
  trashRun: string,
  unit: EvictionUnit,
  reason: RetentionReason,
  initialSequence: number,
  signal?: AbortSignal,
  quarantineRename: (source: string, destination: string) => Promise<void> = rename,
): Promise<{
  deleted: TypeScriptRevisionShardRetentionDeletedFile[];
  skipped: TypeScriptRevisionShardRetentionSkippedEntry[];
  nextSequence: number;
}> {
  const deleted: TypeScriptRevisionShardRetentionDeletedFile[] = [];
  const skipped: TypeScriptRevisionShardRetentionSkippedEntry[] = [];
  let sequence = initialSequence;
  let supportFailed = false;
  for (const file of unit.files) {
    throwIfAborted(signal);
    if (isShardPayload(file.kind) && supportFailed) {
      skipped.push({ path: file.relativePath, reason: "support-delete-failed" });
      continue;
    }
    const result = await quarantineFile(
      cacheDir,
      trashRun,
      file,
      sequence,
      quarantineRename,
    );
    sequence += 1;
    if (result === "changed") {
      skipped.push({ path: file.relativePath, reason: "changed-during-sweep" });
      supportFailed = true;
      continue;
    }
    if (result === "failed") {
      skipped.push({ path: file.relativePath, reason: "quarantine-failed" });
      supportFailed = true;
      continue;
    }
    if (result === "deleted") {
      deleted.push({
        path: file.relativePath,
        kind: file.kind,
        reason,
        sizeBytes: file.sizeBytes,
      });
    }
  }
  return { deleted, skipped, nextSequence: sequence };
}

function isShardPayload(kind: CacheFileKind): boolean {
  return kind === "shard"
    || kind === "semantic-region-shard"
    || kind === "semantic-region-context"
    || kind === "manifest";
}

async function quarantineFile(
  cacheDir: string,
  trashRun: string,
  file: ScannedFile,
  sequence: number,
  quarantineRename: (source: string, destination: string) => Promise<void>,
): Promise<"deleted" | "missing" | "changed" | "failed"> {
  if (!isWithin(cacheDir, file.absolutePath)) return "failed";
  let current;
  try {
    current = await lstat(file.absolutePath);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "failed";
  }
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || current.dev !== file.device
    || current.ino !== file.inode
    || current.size !== file.sizeBytes
    || current.mtimeMs !== file.modifiedMs
  ) {
    return "changed";
  }
  const destination = join(
    trashRun,
    `${String(sequence).padStart(8, "0")}-${file.kind}-${basename(file.absolutePath)}`,
  );
  try {
    await quarantineRename(file.absolutePath, destination);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "changed" : "failed";
  }
  await pruneEmptyParents(cacheDir, dirname(file.absolutePath));
  // Once renamed, the logical CAS entry is evicted. A failed unlink remains private crash trash.
  await unlink(destination).catch(() => undefined);
  return "deleted";
}

async function pruneEmptyParents(cacheDir: string, firstParent: string): Promise<void> {
  let current = firstParent;
  while (current !== cacheDir && isWithin(cacheDir, current)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        current = dirname(current);
        continue;
      }
      // ENOTEMPTY is the ordinary case. Every other outcome is non-essential cleanup too.
      return;
    }
    current = dirname(current);
  }
}

async function drainTrash(
  cacheDir: string,
  state: ScanState,
  signal?: AbortSignal,
): Promise<{ removedBytes: number; unsafe: boolean }> {
  const trashRoot = join(cacheDir, TRASH_DIRECTORY);
  const rootState = await realDirectoryState(trashRoot);
  if (rootState === "missing") return { removedBytes: 0, unsafe: false };
  if (rootState !== "directory") return { removedBytes: 0, unsafe: true };
  const removedBytes = await removeTreeContentsNoFollow(trashRoot, state, signal);
  await rmdir(trashRoot).catch(() => undefined);
  return { removedBytes, unsafe: false };
}

async function removeTreeContentsNoFollow(
  root: string,
  state: ScanState,
  signal?: AbortSignal,
): Promise<number> {
  let removedBytes = 0;
  const pending: Array<{ path: string; visited: boolean }> = [];
  for (const name of (await readdir(root)).sort(compareNames).reverse()) {
    pending.push({ path: join(root, name), visited: false });
  }
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop()!;
    if (current.visited) {
      await rmdir(current.path).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
      continue;
    }
    consumeScanEntry(state);
    let stats;
    try {
      stats = await lstat(current.path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      await unlink(current.path).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
      removedBytes = addSafe(removedBytes, stats.size, "drained trash bytes");
      continue;
    }
    pending.push({ path: current.path, visited: true });
    const children = (await readdir(current.path)).sort(compareNames).reverse();
    for (const name of children) {
      pending.push({ path: join(current.path, name), visited: false });
    }
  }
  return removedBytes;
}

async function createTrashRun(cacheDir: string): Promise<string> {
  const trashRoot = join(cacheDir, TRASH_DIRECTORY);
  const state = await realDirectoryState(trashRoot);
  if (state === "missing") {
    await mkdir(trashRoot, { mode: 0o700 });
  } else if (state !== "directory") {
    throw new Error("TypeScript revision shard retention trash root is unsafe");
  }
  const trashRun = join(trashRoot, "active");
  await mkdir(trashRun, { mode: 0o700 });
  return trashRun;
}

async function realDirectoryState(path: string): Promise<"missing" | "directory" | "unsafe"> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink() ? "directory" : "unsafe";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

function emptyReport(nowMs: number): MutableReport {
  return {
    status: "completed",
    reason: null,
    nowMs,
    observedBytes: 0,
    observedFiles: 0,
    remainingBytes: 0,
    capacityPressure: false,
    drainedTrashBytes: 0,
    drainedTemporaryBytes: 0,
    deletedBytes: 0,
    decisions: [],
    deletedFiles: [],
    skippedEntries: [],
  };
}

function relativeCachePath(cacheDir: string, path: string): string {
  if (!isWithin(cacheDir, path)) throw new Error("cache scan escaped its root");
  return relative(cacheDir, path).split(sep).join("/");
}

function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isGitOid(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function isPrefix(value: string): boolean {
  return /^[a-f0-9]{2}$/.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function latestAccess(files: readonly ScannedFile[]): number {
  if (files.length === 0) throw new Error("retention eviction unit must contain a file");
  return files.reduce(
    (latest, file) => Math.max(latest, file.lastAccessMs),
    files[0]!.lastAccessMs,
  );
}

function compareFiles(left: ScannedFile, right: ScannedFile): number {
  return compareNames(left.relativePath, right.relativePath);
}

function compareUnits(left: EvictionUnit, right: EvictionUnit): number {
  if (left.lastAccessMs !== right.lastAccessMs) return left.lastAccessMs - right.lastAccessMs;
  return compareNames(left.id, right.id);
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTerminalNames(left: string, right: string): number {
  const leftTemporary = IMMUTABLE_PRODUCER_TEMPORARY.test(left);
  const rightTemporary = IMMUTABLE_PRODUCER_TEMPORARY.test(right);
  if (leftTemporary !== rightTemporary) return leftTemporary ? -1 : 1;
  return compareNames(left, right);
}

function safeTimestamp(value: number): number {
  const timestamp = Math.max(0, Math.floor(value));
  if (!Number.isSafeInteger(timestamp)) throw new RangeError("cache timestamp is outside range");
  return timestamp;
}

function consumeScanEntry(state: ScanState): void {
  state.entries += 1;
  if (state.entries > state.maxEntries) throw new ScanLimitError();
}

function sumSafe(values: readonly number[], name: string): number {
  return values.reduce((total, value) => addSafe(total, value, name), 0);
}

function appendAll<Value>(target: Value[], values: readonly Value[]): void {
  for (const value of values) target.push(value);
}

function addSafe(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceed the supported range`);
  return result;
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
