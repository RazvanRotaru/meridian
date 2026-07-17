/** Disk-bounded mark-and-sweep for immutable graph generations. */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RepositoryMirrorStore } from "./repository-mirror";
import {
  GRAPH_COMMIT_ID,
  GRAPH_GENERATION_ID,
  finalizedGenerationDirectory,
  parseFinalizedGenerationPath,
  prBaseArtifactEntry,
  prHeadArtifactEntry,
  visitFinalizedGenerationRootsAsync,
  visitPrExactLookupFilesAsync,
  type PrExactLookupCoordinate,
} from "./graph-cache-layout";
import {
  GraphGenerationLifecycle,
  type GraphGenerationLeaseSnapshot,
} from "./graph-generation-lifecycle";
import {
  claimPathForCleanup,
  claimedPathIsCurrent,
  moveClaimedPath,
  removeClaimedPath,
  sameClaimedPathIdentity,
  type ClaimedPath,
} from "./claimed-path-cleanup";

const FORMAT_VERSION = 1;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SOFT_BYTES = 10 * 1024 ** 3;
const DEFAULT_MAX_SOFT_ENTRIES = 512;
const DEFAULT_MAX_IDLE_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_EXACT_ALIASES = 4_096;
const MAX_GENERATION_TREE_ENTRIES = 1_000_000;
const MAX_MAINTENANCE_ENTRIES = 100_000;
const MAX_QUARANTINES_PER_ADMISSION = 32;

interface PathIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface GenerationCandidate {
  readonly path: string;
  readonly relativePath: string;
  readonly identity: PathIdentity;
  readonly bytes: number;
  readonly currentPointer: ExactFileCandidate | null;
  readonly touchedAtMs: number;
  readonly headBasePath: string | null;
  readonly edgeMetadataIdentity: FullFileIdentity | null;
  readonly cleanupOwners: readonly string[];
}

interface CleanupRecord {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly token: string;
  readonly originalPath: string;
  readonly identity: PathIdentity;
  readonly createdAtMs: number;
}

interface CleanupJob {
  readonly wrapper: string;
  readonly wrapperIdentity: PathIdentity;
  readonly recordIdentity: FullFileIdentity;
  readonly generation: string;
  readonly generationIdentity: PathIdentity;
  readonly record: CleanupRecord;
  /** Derived from record.originalPath after exact current-schema parsing; never read from disk. */
  readonly cleanupOwners: readonly string[];
}

interface ExistingJobScan {
  readonly jobs: readonly CleanupJob[];
  readonly invalid: readonly ClaimedPath[];
}

interface ExactAliasCandidate {
  readonly path: string;
  readonly coordinate: PrExactLookupCoordinate;
  readonly identity: FullFileIdentity;
  readonly target: string | null;
  readonly touchedAtMs: number;
}

interface ExactFileCandidate {
  readonly path: string;
  readonly identity: FullFileIdentity;
}

interface DirectoryCandidate {
  readonly path: string;
  readonly identity: PathIdentity;
}

interface AliasSweepCandidate {
  readonly alias: ExactAliasCandidate;
  /** Target eviction is reconsidered when a generation becomes pinned after planning. */
  readonly reason: "target" | "policy";
}

interface CollectionPlan {
  readonly candidatesByPath: ReadonlyMap<string, GenerationCandidate>;
  readonly existingJobs: ExistingJobScan;
}

interface AdmissionBatchResult<T> {
  readonly value: T;
  readonly quarantinedPaths: number;
  readonly leases: GraphGenerationLeaseSnapshot;
}

interface JsonFileSnapshot {
  readonly value: unknown;
  readonly identity: FullFileIdentity;
}

interface CleanupRecordSnapshot {
  readonly record: CleanupRecord;
  readonly identity: FullFileIdentity;
  readonly cleanupOwners: readonly string[];
}

export interface GraphGenerationGarbageCollectorOptions {
  readonly cacheRoot: string;
  readonly lifecycle: GraphGenerationLifecycle;
  readonly repositoryMirrors: Pick<RepositoryMirrorStore, "releaseSourceOwner">;
  readonly maxSoftBytes?: number;
  readonly maxSoftEntries?: number;
  readonly maxIdleMs?: number;
  readonly maxExactAliases?: number;
  readonly now?: () => number;
  /** Test seam proving recursive cache scans happen outside lifecycle admission. */
  readonly beforeCandidateScan?: () => Promise<void>;
  /** Test seam after quarantine admission is returned and before owner/physical cleanup. */
  readonly beforePhysicalCleanup?: (paths: readonly string[]) => Promise<void>;
  /** Test seam after each bounded admission batch and after the lifecycle lock is released. */
  readonly afterQuarantineBatch?: (batch: {
    readonly kind: "generation" | "alias" | "maintenance";
    readonly quarantinedPaths: number;
  }) => Promise<void> | void;
  /** Test seam immediately after a candidate or alias rename, before its destination claim. */
  readonly afterQuarantineMove?: (
    kind: "generation" | "alias",
    destination: string,
  ) => void;
  /** Test seam after descriptor-backed JSON bytes are read but before path revalidation. */
  readonly afterMetadataRead?: (path: string) => void;
}

export interface GraphGenerationCollectionResult {
  readonly retainedGenerations: number;
  readonly retainedBytes: number;
  readonly quarantinedGenerations: number;
  readonly reclaimedBytes: number;
  readonly repairedLeases: number;
}

export interface GraphGenerationRootSnapshot {
  readonly revision: string;
  readonly generationPaths: ReadonlySet<string>;
}

export interface GraphGenerationRootAuthority {
  snapshotGenerationRoots(signal?: AbortSignal): Promise<GraphGenerationRootSnapshot>;
  /** Called synchronously inside the shared cache-root lifecycle transaction. */
  generationRootSnapshotIsCurrent(snapshot: GraphGenerationRootSnapshot): boolean;
}

export class GraphGenerationGarbageCollector {
  private readonly cacheRoot: string;
  private readonly lifecycle: GraphGenerationLifecycle;
  private readonly repositoryMirrors: GraphGenerationGarbageCollectorOptions["repositoryMirrors"];
  private readonly quarantineRoot: string;
  private readonly abandonedRoot: string;
  private readonly rejectedRoot: string;
  private readonly maxSoftBytes: number;
  private readonly maxSoftEntries: number;
  private readonly maxIdleMs: number;
  private readonly maxExactAliases: number;
  private readonly now: () => number;
  private readonly beforeCandidateScan: () => Promise<void>;
  private readonly beforePhysicalCleanup: (paths: readonly string[]) => Promise<void>;
  private readonly afterQuarantineBatch: NonNullable<
    GraphGenerationGarbageCollectorOptions["afterQuarantineBatch"]
  >;
  private readonly afterQuarantineMove: NonNullable<
    GraphGenerationGarbageCollectorOptions["afterQuarantineMove"]
  >;
  private readonly afterMetadataRead: NonNullable<
    GraphGenerationGarbageCollectorOptions["afterMetadataRead"]
  >;

  constructor(options: GraphGenerationGarbageCollectorOptions) {
    if (!options.cacheRoot.trim()) throw new TypeError("generation GC cache root is required");
    this.cacheRoot = realpathSync(resolve(options.cacheRoot));
    this.lifecycle = options.lifecycle;
    this.repositoryMirrors = options.repositoryMirrors;
    this.maxSoftBytes = positiveLimit(options.maxSoftBytes, DEFAULT_MAX_SOFT_BYTES, "soft byte limit");
    this.maxSoftEntries = positiveLimit(options.maxSoftEntries, DEFAULT_MAX_SOFT_ENTRIES, "soft entry limit");
    this.maxIdleMs = positiveLimit(options.maxIdleMs, DEFAULT_MAX_IDLE_MS, "soft idle lifetime");
    this.maxExactAliases = positiveLimit(
      options.maxExactAliases,
      DEFAULT_MAX_EXACT_ALIASES,
      "exact lookup alias limit",
    );
    this.now = options.now ?? Date.now;
    this.beforeCandidateScan = options.beforeCandidateScan ?? (() => Promise.resolve());
    this.beforePhysicalCleanup = options.beforePhysicalCleanup ?? (() => Promise.resolve());
    this.afterQuarantineBatch = options.afterQuarantineBatch ?? (() => undefined);
    this.afterQuarantineMove = options.afterQuarantineMove ?? (() => undefined);
    this.afterMetadataRead = options.afterMetadataRead ?? (() => undefined);
    const root = requirePrivateDirectory(join(this.cacheRoot, "graph-generation-gc"));
    const version = requirePrivateDirectory(join(root, "v1"));
    this.quarantineRoot = requirePrivateDirectory(join(version, "quarantine"));
    this.abandonedRoot = requirePrivateDirectory(join(version, "abandoned"));
    this.rejectedRoot = requirePrivateDirectory(join(version, "rejected"));
  }

  /**
   * Mark exact durable roots and selected current aliases, quarantine other generations in bounded
   * lifecycle admissions, then perform recursive deletion and mirror-owner cleanup outside them.
   */
  async collect(
    rootAuthority: GraphGenerationRootAuthority,
    signal?: AbortSignal,
  ): Promise<GraphGenerationCollectionResult> {
    const abandoned = await this.scanExistingAbandoned(signal);
    try {
      return await this.collectOnce(rootAuthority, abandoned, signal);
    } catch (error) {
      // Abandoned claims and quarantine jobs are durable restart work. Cancellation must return
      // promptly instead of turning shutdown into an uninterruptible recursive cleanup pass.
      if (signal?.aborted) throw error;
      const cleanupErrors = await removeClaims(abandoned);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "graph generation collection and abandoned cleanup both failed",
        );
      }
      throw error;
    }
  }

  private async collectOnce(
    rootAuthority: GraphGenerationRootAuthority,
    abandoned: ClaimedPath[],
    signal?: AbortSignal,
  ): Promise<GraphGenerationCollectionResult> {
    await this.beforeCandidateScan();
    throwIfAborted(signal);
    // Recursive discovery, byte accounting, global maps, and LRU sorting are intentionally
    // outside lifecycle admission. A later admission batch revalidates every path it mutates.
    const scannedCandidates = await scanCandidates(
      this.cacheRoot,
      this.afterMetadataRead,
      signal,
    );
    const scannedExactAliases = await scanExactAliases(
      this.cacheRoot,
      this.afterMetadataRead,
      signal,
    );
    const scannedExistingJobs = await this.scanExistingJobs(signal);
    const candidatesByPath = new Map(
      scannedCandidates.map((candidate) => [candidate.relativePath, candidate]),
    );
    const planning = await this.snapshotPlanningAuthority(
      rootAuthority,
      candidatesByPath,
      signal,
    );
    const selectedGenerationPaths = selectGenerations(scannedCandidates, planning.hardRoots, {
      now: this.now(),
      maxSoftBytes: this.maxSoftBytes,
      maxSoftEntries: this.maxSoftEntries,
      maxIdleMs: this.maxIdleMs,
    });
    const plan: CollectionPlan = {
      candidatesByPath,
      existingJobs: scannedExistingJobs,
    };

    let repairedLeases = planning.leases.repairedLeases;
    repairedLeases += await this.quarantineInvalidJobs(
      rootAuthority,
      plan,
      abandoned,
      signal,
    );

    const retainedPaths = new Set(selectedGenerationPaths);
    const newJobs: CleanupJob[] = [];
    let reclaimedBytes = 0;
    const sweepCandidates = scannedCandidates.filter(
      (candidate) => !selectedGenerationPaths.has(candidate.relativePath),
    );
    let candidateCursor = 0;
    while (candidateCursor < sweepCandidates.length) {
      throwIfAborted(signal);
      const batch = await this.runAdmissionBatch(
        "generation",
        rootAuthority,
        candidatesByPath,
        signal,
        (protectedPaths) => {
          let examined = 0;
          let quarantinedPaths = 0;
          const jobs: CleanupJob[] = [];
          let bytes = 0;
          while (candidateCursor + examined < sweepCandidates.length
            && examined < MAX_QUARANTINES_PER_ADMISSION) {
            const candidate = sweepCandidates[candidateCursor + examined]!;
            const state = revalidateCandidate(
              this.cacheRoot,
              candidate,
              this.afterMetadataRead,
            );
            if (state !== "current" || protectedPaths.has(candidate.relativePath)) {
              if (state !== "missing") retainedPaths.add(candidate.relativePath);
              examined += 1;
              continue;
            }
            const quarantineCost = candidate.currentPointer ? 2 : 1;
            if (quarantinedPaths > 0
              && quarantinedPaths + quarantineCost > MAX_QUARANTINES_PER_ADMISSION) break;
            const quarantined = this.quarantineCandidate(candidate, abandoned);
            jobs.push(quarantined.job);
            quarantinedPaths += quarantined.quarantinedPaths;
            bytes = checkedByteSum(bytes, candidate.bytes);
            examined += 1;
          }
          if (examined === 0) {
            throw new Error("graph generation admission batch made no progress");
          }
          return {
            value: { examined, jobs, bytes },
            quarantinedPaths,
          };
        },
      );
      candidateCursor += batch.value.examined;
      newJobs.push(...batch.value.jobs);
      reclaimedBytes = checkedByteSum(reclaimedBytes, batch.value.bytes);
      repairedLeases += batch.leases.repairedLeases;
    }

    // Alias refresh and global LRU selection are also outside admission. Timestamp touches that
    // occur after this refresh make the later exact revalidation skip that alias conservatively.
    const aliases = scannedExactAliases
      .map((alias) => refreshExactAlias(
        this.cacheRoot,
        alias,
        this.afterMetadataRead,
      ))
      .filter((alias): alias is ExactAliasCandidate => alias !== null);
    const retainedAliasPaths = selectExactAliases(aliases, retainedPaths, {
      now: this.now(),
      maxIdleMs: this.maxIdleMs,
      maxExactAliases: this.maxExactAliases,
    });
    const aliasSweep: AliasSweepCandidate[] = aliases.flatMap((alias) => {
      if (retainedAliasPaths.has(alias.path)) return [];
      return [{
        alias,
        reason: alias.target !== null && retainedPaths.has(alias.target) ? "policy" : "target",
      }];
    });
    const quarantinedAliasPaths: string[] = [];
    let aliasCursor = 0;
    while (aliasCursor < aliasSweep.length) {
      throwIfAborted(signal);
      const batch = await this.runAdmissionBatch(
        "alias",
        rootAuthority,
        candidatesByPath,
        signal,
        (protectedPaths) => {
          let examined = 0;
          let quarantinedPaths = 0;
          const removed: string[] = [];
          while (aliasCursor + examined < aliasSweep.length
            && examined < MAX_QUARANTINES_PER_ADMISSION
            && quarantinedPaths < MAX_QUARANTINES_PER_ADMISSION) {
            const sweep = aliasSweep[aliasCursor + examined]!;
            examined += 1;
            if (!exactAliasIsCurrent(
              this.cacheRoot,
              sweep.alias,
              this.afterMetadataRead,
            )) continue;
            if (sweep.reason === "target" && sweep.alias.target !== null) {
              if (protectedPaths.has(sweep.alias.target)) continue;
              const target = candidatesByPath.get(sweep.alias.target);
              if (target && revalidateCandidate(
                this.cacheRoot,
                target,
                this.afterMetadataRead,
              ) === "changed") continue;
            }
            abandoned.push(this.quarantineExactAlias(sweep.alias));
            removed.push(sweep.alias.path);
            quarantinedPaths += 1;
          }
          if (examined === 0) throw new Error("graph alias admission batch made no progress");
          return { value: { examined, removed }, quarantinedPaths };
        },
      );
      aliasCursor += batch.value.examined;
      quarantinedAliasPaths.push(...batch.value.removed);
      repairedLeases += batch.leases.repairedLeases;
    }

    repairedLeases += await this.pruneEmptyAliasAncestors(
      rootAuthority,
      candidatesByPath,
      quarantinedAliasPaths,
      abandoned,
      signal,
    );

    const existingJobs = this.revalidateExistingJobs(plan.existingJobs);
    const jobs = [...existingJobs, ...newJobs].map((job) => this.refreshCleanupJob(job));

    const errors: unknown[] = [];
    const physicalPaths = Object.freeze([
      ...abandoned.map((claim) => claim.path),
      ...jobs.map((job) => job.wrapper),
    ]);
    if (physicalPaths.length > 0) {
      try {
        throwIfAborted(signal);
        await this.beforePhysicalCleanup(physicalPaths);
        throwIfAborted(signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        errors.push(error);
      }
    }
    for (const claim of abandoned) {
      try {
        throwIfAborted(signal);
        await removeClaimedPath(claim);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        errors.push(error);
      }
    }
    for (const job of jobs) {
      try {
        for (const owner of job.cleanupOwners) {
          throwIfAborted(signal);
          await this.assertCleanupJobCurrent(job);
          await this.repositoryMirrors.releaseSourceOwner(owner);
        }
        throwIfAborted(signal);
        await this.assertCleanupJobCurrent(job);
        await removeClaimedPath(cleanupClaim(job.wrapper, job.wrapperIdentity));
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "one or more graph generations could not be reclaimed");
    }
    const retained = scannedCandidates.filter(
      (candidate) => retainedPaths.has(candidate.relativePath),
    );
    return Object.freeze({
      retainedGenerations: retained.length,
      retainedBytes: retained.reduce((sum, candidate) => checkedByteSum(sum, candidate.bytes), 0),
      quarantinedGenerations: jobs.length,
      reclaimedBytes,
      repairedLeases,
    });
  }

  private async snapshotPlanningAuthority(
    rootAuthority: GraphGenerationRootAuthority,
    candidatesByPath: ReadonlyMap<string, GenerationCandidate>,
    signal: AbortSignal | undefined,
  ): Promise<{ hardRoots: ReadonlySet<string>; leases: GraphGenerationLeaseSnapshot }> {
    while (true) {
      throwIfAborted(signal);
      const rootSnapshot = await rootAuthority.snapshotGenerationRoots(signal);
      const persistedRoots = generationClosureForRoots(
        normalizeRoots(this.cacheRoot, rootSnapshot.generationPaths),
        candidatesByPath,
      );
      const attempt = await this.lifecycle.withActiveLeaseSnapshot((leases) => {
        throwIfAborted(signal);
        if (!rootAuthority.generationRootSnapshotIsCurrent(rootSnapshot)) return null;
        const hardRoots = new Set(persistedRoots);
        addGenerationRoots(
          normalizeRoots(this.cacheRoot, leases.generationPaths),
          candidatesByPath,
          hardRoots,
        );
        return { hardRoots, leases };
      }, signal);
      if (attempt) return attempt;
    }
  }

  private async runAdmissionBatch<T>(
    kind: "generation" | "alias" | "maintenance",
    rootAuthority: GraphGenerationRootAuthority,
    candidatesByPath: ReadonlyMap<string, GenerationCandidate>,
    signal: AbortSignal | undefined,
    operation: (
      protectedPaths: ReadonlySet<string>,
    ) => { value: T; quarantinedPaths: number },
  ): Promise<AdmissionBatchResult<T>> {
    while (true) {
      throwIfAborted(signal);
      const rootSnapshot = await rootAuthority.snapshotGenerationRoots(signal);
      // Root scanning and dependency closure stay outside lifecycle admission. The epoch check
      // below makes this exact snapshot authoritative for the following bounded mutation.
      const persistedRoots = generationClosureForRoots(
        normalizeRoots(this.cacheRoot, rootSnapshot.generationPaths),
        candidatesByPath,
      );
      const attempt = await this.lifecycle.withActiveLeaseSnapshot((leases) => {
        throwIfAborted(signal);
        if (!rootAuthority.generationRootSnapshotIsCurrent(rootSnapshot)) return null;
        const protectedPaths = new Set(persistedRoots);
        // Live leases can change until lock acquisition, so only their small closure expansion is
        // performed here. No global candidate refresh, map construction, or sort occurs inside.
        addGenerationRoots(
          normalizeRoots(this.cacheRoot, leases.generationPaths),
          candidatesByPath,
          protectedPaths,
        );
        const result = operation(protectedPaths);
        if (!Number.isSafeInteger(result.quarantinedPaths)
          || result.quarantinedPaths < 0
          || result.quarantinedPaths > MAX_QUARANTINES_PER_ADMISSION) {
          throw new Error("graph generation quarantine batch exceeded its admission limit");
        }
        return { ...result, leases };
      }, signal);
      if (!attempt) continue;
      await this.afterQuarantineBatch({
        kind,
        quarantinedPaths: attempt.quarantinedPaths,
      });
      throwIfAborted(signal);
      return attempt;
    }
  }

  private async scanExistingJobs(signal: AbortSignal | undefined): Promise<ExistingJobScan> {
    const jobs: CleanupJob[] = [];
    const invalid: ClaimedPath[] = [];
    let entries = 0;
    const quarantine = await opendir(this.quarantineRoot);
    for await (const entry of quarantine) {
      throwIfAborted(signal);
      entries += 1;
      if (entries > MAX_MAINTENANCE_ENTRIES) {
        throw new Error("graph generation cleanup job scan exceeded its entry limit");
      }
      const wrapper = join(this.quarantineRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        invalid.push(claimPathForCleanup(wrapper));
        continue;
      }
      const snapshot = readCleanupRecord(this.cacheRoot, wrapper, this.afterMetadataRead);
      const generation = join(wrapper, "generation");
      if (!snapshot || !isPlainDirectory(generation)) {
        invalid.push(claimPathForCleanup(wrapper));
        continue;
      }
      const generationIdentity = directoryIdentity(generation);
      if (!sameInode(snapshot.record.identity, generationIdentity)) {
        invalid.push(claimPathForCleanup(wrapper));
        continue;
      }
      jobs.push({
        wrapper,
        wrapperIdentity: directoryIdentity(wrapper),
        recordIdentity: snapshot.identity,
        generation,
        generationIdentity,
        record: snapshot.record,
        cleanupOwners: snapshot.cleanupOwners,
      });
    }
    return { jobs, invalid };
  }

  private async quarantineInvalidJobs(
    rootAuthority: GraphGenerationRootAuthority,
    plan: CollectionPlan,
    abandoned: ClaimedPath[],
    signal: AbortSignal | undefined,
  ): Promise<number> {
    let repairedLeases = 0;
    let cursor = 0;
    while (cursor < plan.existingJobs.invalid.length) {
      throwIfAborted(signal);
      const batch = await this.runAdmissionBatch(
        "maintenance",
        rootAuthority,
        plan.candidatesByPath,
        signal,
        () => {
          let examined = 0;
          let quarantinedPaths = 0;
          while (cursor + examined < plan.existingJobs.invalid.length
            && examined < MAX_QUARANTINES_PER_ADMISSION
            && quarantinedPaths < MAX_QUARANTINES_PER_ADMISSION) {
            const entry = plan.existingJobs.invalid[cursor + examined]!;
            examined += 1;
            if (!claimedPathSnapshotIsCurrent(entry)) continue;
            abandoned.push(this.quarantineAbandoned(entry.path, entry));
            quarantinedPaths += 1;
          }
          if (examined === 0) {
            throw new Error("graph cleanup maintenance batch made no progress");
          }
          return { value: examined, quarantinedPaths };
        },
      );
      cursor += batch.value;
      repairedLeases += batch.leases.repairedLeases;
    }
    return repairedLeases;
  }

  private revalidateExistingJobs(scan: ExistingJobScan): CleanupJob[] {
    const jobs: CleanupJob[] = [];
    for (const job of scan.jobs) {
      if (!existsSync(job.wrapper)) continue;
      const snapshot = readCleanupRecord(this.cacheRoot, job.wrapper, this.afterMetadataRead);
      if (!snapshot
        || !sameIdentity(directoryIdentity(job.wrapper), job.wrapperIdentity)
        || !sameFileIdentity(snapshot.identity, job.recordIdentity)
        || !sameCleanupRecord(snapshot.record, job.record)
        || !sameIdentity(directoryIdentity(job.generation), job.generationIdentity)) {
        throw new Error("generation cleanup job changed during scan");
      }
      jobs.push(job);
    }
    return jobs;
  }

  private quarantineCandidate(
    candidate: GenerationCandidate,
    abandoned: ClaimedPath[],
  ): { job: CleanupJob; quarantinedPaths: number } {
    const token = randomBytes(24).toString("hex");
    const wrapper = join(this.quarantineRoot, token);
    mkdirSync(wrapper, { mode: 0o700 });
    const record: CleanupRecord = {
      formatVersion: FORMAT_VERSION,
      token,
      originalPath: candidate.relativePath,
      identity: candidate.identity,
      createdAtMs: this.now(),
    };
    writeFileSync(join(wrapper, "cleanup.json"), `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const current = directoryIdentity(candidate.path);
    if (!sameIdentity(current, candidate.identity)) {
      abandoned.push(this.quarantineAbandoned(wrapper));
      throw new Error("graph generation changed during collection");
    }
    const generation = join(wrapper, "generation");
    moveClaimedPath({
      source: candidate.path,
      expected: cleanupClaim(candidate.path, candidate.identity),
      destination: generation,
      rejected: join(this.rejectedRoot, `generation-${randomBytes(16).toString("hex")}`),
      label: "graph generation candidate",
      afterRename: (destination) => this.afterQuarantineMove("generation", destination),
    });
    const aliasMoved = candidate.currentPointer
      ? this.moveAlias(candidate.currentPointer, wrapper)
      : false;
    return {
      job: {
        wrapper,
        wrapperIdentity: directoryIdentity(wrapper),
        recordIdentity: fileIdentity(join(wrapper, "cleanup.json")),
        generation,
        generationIdentity: directoryIdentity(generation),
        record,
        cleanupOwners: candidate.cleanupOwners,
      },
      quarantinedPaths: aliasMoved ? 2 : 1,
    };
  }

  private moveAlias(
    alias: ExactFileCandidate,
    wrapper: string,
  ): boolean {
    if (!existsSync(alias.path)) return false;
    const aliases = join(wrapper, "aliases");
    mkdirSync(aliases, { recursive: true, mode: 0o700 });
    moveClaimedPath({
      source: alias.path,
      expected: fileCleanupClaim(alias.path, alias.identity),
      destination: join(aliases, `${randomBytes(12).toString("hex")}.json`),
      rejected: join(this.rejectedRoot, `alias-${randomBytes(16).toString("hex")}`),
      label: "graph cache alias",
      afterRename: (destination) => this.afterQuarantineMove("alias", destination),
    });
    return true;
  }

  private quarantineExactAlias(alias: ExactAliasCandidate): ClaimedPath {
    const destination = join(this.abandonedRoot, randomBytes(16).toString("hex"));
    return moveClaimedPath({
      source: alias.path,
      expected: fileCleanupClaim(alias.path, alias.identity),
      destination,
      rejected: join(this.rejectedRoot, `alias-${randomBytes(16).toString("hex")}`),
      label: "graph cache exact alias",
      afterRename: (moved) => this.afterQuarantineMove("alias", moved),
    });
  }

  private async pruneEmptyAliasAncestors(
    rootAuthority: GraphGenerationRootAuthority,
    candidatesByPath: ReadonlyMap<string, GenerationCandidate>,
    aliasPaths: readonly string[],
    abandoned: ClaimedPath[],
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const root = join(this.cacheRoot, "pr-exact-lookups");
    const pathsByDepth = new Map<number, Set<string>>();
    for (const path of aliasPaths) {
      let cursor = dirname(path);
      while (cursor !== root && isContained(cursor, root)) {
        const depth = relative(root, cursor).split(sep).length;
        const atDepth = pathsByDepth.get(depth) ?? new Set<string>();
        atDepth.add(cursor);
        pathsByDepth.set(depth, atDepth);
        cursor = dirname(cursor);
      }
    }
    let repairedLeases = 0;
    const depths = [...pathsByDepth.keys()].sort((left, right) => right - left);
    for (const depth of depths) {
      throwIfAborted(signal);
      // A parent identity is captured only after the deeper coordinate level has settled.
      const candidates = [...pathsByDepth.get(depth)!]
        .map(emptyDirectoryCandidate)
        .filter((candidate): candidate is DirectoryCandidate => candidate !== null);
      let cursor = 0;
      while (cursor < candidates.length) {
        const batch = await this.runAdmissionBatch(
          "maintenance",
          rootAuthority,
          candidatesByPath,
          signal,
          () => {
            let examined = 0;
            let quarantinedPaths = 0;
            while (cursor + examined < candidates.length
              && examined < MAX_QUARANTINES_PER_ADMISSION
              && quarantinedPaths < MAX_QUARANTINES_PER_ADMISSION) {
              const candidate = candidates[cursor + examined]!;
              examined += 1;
              if (!emptyDirectoryIsCurrent(candidate)) continue;
              abandoned.push(this.quarantineAbandoned(
                candidate.path,
                cleanupClaim(candidate.path, candidate.identity),
              ));
              quarantinedPaths += 1;
            }
            if (examined === 0) {
              throw new Error("graph alias-directory batch made no progress");
            }
            return { value: examined, quarantinedPaths };
          },
        );
        cursor += batch.value;
        repairedLeases += batch.leases.repairedLeases;
      }
    }
    return repairedLeases;
  }

  private refreshCleanupJob(job: CleanupJob): CleanupJob {
    const snapshot = readCleanupRecord(this.cacheRoot, job.wrapper, this.afterMetadataRead);
    if (!snapshot || !sameCleanupRecord(snapshot.record, job.record)) {
      throw new Error("generation cleanup job changed while being finalized");
    }
    return {
      ...job,
      wrapperIdentity: directoryIdentity(job.wrapper),
      recordIdentity: snapshot.identity,
      generationIdentity: directoryIdentity(job.generation),
      cleanupOwners: snapshot.cleanupOwners,
    };
  }

  private async assertCleanupJobCurrent(job: CleanupJob): Promise<void> {
    const snapshot = readCleanupRecord(this.cacheRoot, job.wrapper, this.afterMetadataRead);
    if (!await claimedPathIsCurrent(cleanupClaim(job.wrapper, job.wrapperIdentity))
      || !snapshot
      || !sameIdentity(directoryIdentity(job.wrapper), job.wrapperIdentity)
      || !sameFileIdentity(snapshot.identity, job.recordIdentity)
      || !sameCleanupRecord(snapshot.record, job.record)
      || !sameIdentity(directoryIdentity(job.generation), job.generationIdentity)) {
      throw new Error("generation cleanup job changed after quarantine");
    }
  }

  private async scanExistingAbandoned(signal: AbortSignal | undefined): Promise<ClaimedPath[]> {
    const claims: ClaimedPath[] = [];
    let entries = 0;
    const abandoned = await opendir(this.abandonedRoot);
    for await (const entry of abandoned) {
      throwIfAborted(signal);
      entries += 1;
      if (entries > MAX_MAINTENANCE_ENTRIES) {
        throw new Error("graph generation abandoned scan exceeded its entry limit");
      }
      if (!/^[0-9a-f]{32}$/.test(entry.name)) {
        throw new Error("graph generation abandoned cleanup entry has an invalid name");
      }
      claims.push(claimPathForCleanup(join(this.abandonedRoot, entry.name)));
    }
    return claims;
  }

  private quarantineAbandoned(
    path: string,
    expected: ClaimedPath = claimPathForCleanup(path),
  ): ClaimedPath {
    const destination = join(
      this.abandonedRoot,
      randomBytes(16).toString("hex"),
    );
    return moveClaimedPath({
      source: path,
      expected,
      destination,
      rejected: join(this.rejectedRoot, `abandoned-${randomBytes(16).toString("hex")}`),
      label: "graph cache discarded cleanup entry",
    });
  }
}

function cleanupClaim(path: string, identity: PathIdentity): ClaimedPath {
  return Object.freeze({
    path,
    identity: Object.freeze({
      dev: identity.dev,
      ino: identity.ino,
      kind: "directory" as const,
    }),
  });
}

function fileCleanupClaim(path: string, identity: FullFileIdentity): ClaimedPath {
  return Object.freeze({
    path,
    identity: Object.freeze({ dev: identity.dev, ino: identity.ino, kind: "file" as const }),
  });
}

async function scanCandidates(
  cacheRoot: string,
  afterMetadataRead: (path: string) => void,
  signal: AbortSignal | undefined,
): Promise<GenerationCandidate[]> {
  const candidates: GenerationCandidate[] = [];
  const treeBudget = { remaining: MAX_GENERATION_TREE_ENTRIES };
  await visitFinalizedGenerationRootsAsync(cacheRoot, async (generations) => {
    throwIfAborted(signal);
    const current = readCurrentPointer(
      join(dirname(generations), "current.json"),
      afterMetadataRead,
    );
    const directory = await opendir(generations);
    for await (const entry of directory) {
      throwIfAborted(signal);
      treeBudget.remaining -= 1;
      if (treeBudget.remaining < 0) {
        throw new Error("graph generation traversal exceeded its entry limit");
      }
      if (!GRAPH_GENERATION_ID.test(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error("graph generation root contains an unsafe entry");
      }
      const path = join(generations, entry.name);
      const canonical = realpathSync(path);
      if (dirname(canonical) !== realpathSync(generations)) {
        throw new Error("graph generation escaped its generations directory");
      }
      const metadata = join(path, "metadata.json");
      const currentPointer = current?.generationId === entry.name
        ? { path: current.path, identity: current.identity }
        : null;
      const touchedAtMs = currentPointer
        ? nanosecondsToMilliseconds(currentPointer.identity.mtimeNs)
        : existsSync(metadata)
          ? statSync(metadata).mtimeMs
          : statSync(path).mtimeMs;
      const edge = headBaseGenerationEdge(cacheRoot, canonical, afterMetadataRead);
      candidates.push({
        path: canonical,
        relativePath: portableRelative(cacheRoot, canonical),
        identity: directoryIdentity(canonical),
        bytes: await directoryBytes(canonical, treeBudget, signal),
        currentPointer,
        touchedAtMs,
        headBasePath: edge?.target ?? null,
        edgeMetadataIdentity: edge?.identity ?? null,
        cleanupOwners: generationCleanupOwners(cacheRoot, canonical),
      });
    }
  }, { signal });
  return candidates.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
}

type CandidateRevalidation = "current" | "changed" | "missing";

function revalidateCandidate(
  cacheRoot: string,
  candidate: GenerationCandidate,
  afterMetadataRead: (path: string) => void,
): CandidateRevalidation {
  if (!existsSync(candidate.path)) return "missing";
  try {
    if (!sameIdentity(directoryIdentity(candidate.path), candidate.identity)) return "changed";
    const current = readCurrentPointer(
      join(dirname(dirname(candidate.path)), "current.json"),
      afterMetadataRead,
    );
    const currentPointer = current?.generationId === basename(candidate.path)
      ? { path: current.path, identity: current.identity }
      : null;
    if (!sameExactFileCandidate(currentPointer, candidate.currentPointer)) return "changed";
    const edge = headBaseGenerationEdge(cacheRoot, candidate.path, afterMetadataRead);
    if ((candidate.edgeMetadataIdentity === null) !== (edge === null)
      || (candidate.edgeMetadataIdentity && edge
        && (!sameFileIdentity(candidate.edgeMetadataIdentity, edge.identity)
          || candidate.headBasePath !== edge.target))) return "changed";
    return "current";
  } catch {
    return "changed";
  }
}

function selectGenerations(
  candidates: readonly GenerationCandidate[],
  hard: ReadonlySet<string>,
  policy: { now: number; maxSoftBytes: number; maxSoftEntries: number; maxIdleMs: number },
): Set<string> {
  const byPath = new Map(candidates.map((candidate) => [candidate.relativePath, candidate]));
  const selected = new Set<string>();
  // Hard roots are correctness state and therefore remain outside the soft budget, including the
  // exact merge-base generations owned by hard HEAD roots.
  for (const root of hard) addGenerationClosure(root, byPath, selected);
  const soft = candidates
    .filter((candidate) => candidate.currentPointer
      && !selected.has(candidate.relativePath)
      && policy.now - candidate.touchedAtMs < policy.maxIdleMs)
    .sort((left, right) => right.touchedAtMs - left.touchedAtMs
      || compareUtf8(left.relativePath, right.relativePath));
  let bytes = 0;
  let entries = 0;
  for (const candidate of soft) {
    const closure = generationClosure(candidate.relativePath, byPath)
      .filter((path) => !selected.has(path));
    const closureBytes = sumGenerationBytes(closure, byPath);
    if (entries + closure.length > policy.maxSoftEntries
      || bytes + closureBytes > policy.maxSoftBytes) continue;
    for (const path of closure) selected.add(path);
    bytes += closureBytes;
    entries += closure.length;
  }
  return selected;
}

function selectExactAliases(
  aliases: readonly ExactAliasCandidate[],
  selectedGenerations: ReadonlySet<string>,
  policy: { now: number; maxIdleMs: number; maxExactAliases: number },
): ReadonlySet<string> {
  return new Set(aliases
    .filter((alias) => alias.target !== null
      && selectedGenerations.has(alias.target)
      && policy.now - alias.touchedAtMs < policy.maxIdleMs)
    .sort((left, right) => right.touchedAtMs - left.touchedAtMs
      || compareUtf8(left.path, right.path))
    .slice(0, policy.maxExactAliases)
    .map((alias) => alias.path));
}

function generationClosureForRoots(
  roots: ReadonlySet<string>,
  candidatesByPath: ReadonlyMap<string, GenerationCandidate>,
): ReadonlySet<string> {
  const expanded = new Set<string>();
  addGenerationRoots(roots, candidatesByPath, expanded);
  return expanded;
}

function addGenerationRoots(
  roots: Iterable<string>,
  candidatesByPath: ReadonlyMap<string, GenerationCandidate>,
  destination: Set<string>,
): void {
  for (const root of roots) {
    destination.add(root);
    addGenerationClosure(root, candidatesByPath, destination);
  }
}

function addGenerationClosure(
  root: string,
  byPath: ReadonlyMap<string, GenerationCandidate>,
  selected: Set<string>,
): void {
  for (const path of generationClosure(root, byPath)) selected.add(path);
}

function generationClosure(
  root: string,
  byPath: ReadonlyMap<string, GenerationCandidate>,
): string[] {
  const closure: string[] = [];
  const pending = [root];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const candidate = byPath.get(path);
    if (!candidate) continue;
    closure.push(path);
    if (candidate.headBasePath) pending.push(candidate.headBasePath);
  }
  return closure;
}

function sumGenerationBytes(
  paths: readonly string[],
  byPath: ReadonlyMap<string, GenerationCandidate>,
): number {
  let bytes = 0;
  for (const path of paths) {
    bytes += byPath.get(path)!.bytes;
    if (!Number.isSafeInteger(bytes)) throw new Error("graph generation byte total overflowed");
  }
  return bytes;
}

function checkedByteSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw new Error("graph generation byte total overflowed");
  }
  return sum;
}

async function scanExactAliases(
  cacheRoot: string,
  afterMetadataRead: (path: string) => void,
  signal: AbortSignal | undefined,
): Promise<ExactAliasCandidate[]> {
  const aliases: ExactAliasCandidate[] = [];
  await visitPrExactLookupFilesAsync(cacheRoot, (coordinate) => {
    throwIfAborted(signal);
    const alias = readExactAliasCandidate(cacheRoot, coordinate, afterMetadataRead);
    if (alias) aliases.push(alias);
  }, { signal });
  return aliases;
}

function refreshExactAlias(
  cacheRoot: string,
  alias: ExactAliasCandidate,
  afterMetadataRead: (path: string) => void,
): ExactAliasCandidate | null {
  if (!existsSync(alias.path)) return null;
  const current = readExactAliasCandidate(cacheRoot, alias.coordinate, afterMetadataRead);
  if (!current) return null;
  // Warm cache reads intentionally touch the exact alias outside collection admission. Accept
  // that timestamp-only mutation only when the same inode, size, and parsed target remain bound;
  // inode replacement or content/target mutation still invalidates the collection snapshot.
  if (!sameFileIdentity(current.identity, alias.identity)
    && (!sameInode(current.identity, alias.identity)
      || current.identity.size !== alias.identity.size
      || current.target !== alias.target)) return null;
  return current;
}

function exactAliasIsCurrent(
  cacheRoot: string,
  alias: ExactAliasCandidate,
  afterMetadataRead: (path: string) => void,
): boolean {
  if (!existsSync(alias.path)) return false;
  try {
    const current = readExactAliasCandidate(cacheRoot, alias.coordinate, afterMetadataRead);
    return current !== null
      && current.target === alias.target
      && sameFileIdentity(current.identity, alias.identity);
  } catch {
    return false;
  }
}

function readCurrentPointer(
  path: string,
  afterMetadataRead: (path: string) => void,
): { path: string; generationId: string; identity: FullFileIdentity } | null {
  const snapshot = readSmallJson(path, afterMetadataRead);
  if (!snapshot) return null;
  const value = snapshot.value;
  if (!isRecord(value)
    || !hasExactKeys(value, ["formatVersion", "generationId"])
    || value.formatVersion !== 1
    || typeof value.generationId !== "string" || !GRAPH_GENERATION_ID.test(value.generationId)) return null;
  return { path, generationId: value.generationId, identity: snapshot.identity };
}

function headBaseGenerationEdge(
  cacheRoot: string,
  generation: string,
  afterMetadataRead: (path: string) => void,
): { target: string; identity: FullFileIdentity } | null {
  const coordinate = parseFinalizedGenerationPath(cacheRoot, generation);
  if (coordinate?.kind !== "pr-head") return null;
  const metadataPath = join(generation, "head", "metadata.json");
  const snapshot = readSmallJson(metadataPath, afterMetadataRead);
  if (!snapshot) return null;
  const metadata = snapshot.value;
  if (!isRecord(metadata)
    || metadata.repositoryKey !== coordinate.repositoryKey
    || metadata.securityDigest !== coordinate.securityDigest
    || metadata.mergeBaseSha !== coordinate.mergeBaseSha
    || typeof metadata.mergeBaseSha !== "string" || !GRAPH_COMMIT_ID.test(metadata.mergeBaseSha)
    || typeof metadata.analysisKey !== "string" || metadata.analysisKey !== coordinate.analysisKey
    || typeof metadata.mergeBaseVariant !== "string"
    || typeof metadata.mergeBaseGenerationId !== "string"
      || !GRAPH_GENERATION_ID.test(metadata.mergeBaseGenerationId)) return null;
  const target = finalizedGenerationDirectory(
    prBaseArtifactEntry(
      cacheRoot,
      coordinate.repositoryKey,
      coordinate.securityDigest,
      coordinate.subdirKey,
      metadata.mergeBaseSha,
      coordinate.analysisKey,
      metadata.mergeBaseVariant,
    ),
    metadata.mergeBaseGenerationId,
  );
  return {
    target: portableRelative(cacheRoot, target),
    identity: snapshot.identity,
  };
}

function generationCleanupOwners(cacheRoot: string, generation: string): readonly string[] {
  const coordinate = parseFinalizedGenerationPath(cacheRoot, generation);
  if (coordinate?.kind === "pr-head") {
    return [
      `pr-head-cache:${coordinate.repositoryKey}:${coordinate.securityDigest}:${coordinate.generationId}`,
      `pr-head-base-cache:${coordinate.repositoryKey}:${coordinate.securityDigest}:${coordinate.generationId}`,
    ];
  }
  if (coordinate?.kind === "pr-base") {
    return [`pr-base-cache:${coordinate.repositoryKey}:${coordinate.securityDigest}:${coordinate.generationId}`];
  }
  return [];
}

function readExactAliasCandidate(
  cacheRoot: string,
  coordinate: PrExactLookupCoordinate,
  afterMetadataRead: (path: string) => void,
): ExactAliasCandidate | null {
  const snapshot = readSmallJson(coordinate.path, afterMetadataRead);
  if (!snapshot) {
    const identity = safeFileIdentity(coordinate.path);
    return identity ? {
      path: coordinate.path,
      coordinate,
      identity,
      target: null,
      touchedAtMs: nanosecondsToMilliseconds(identity.mtimeNs),
    } : null;
  }
  const value = snapshot.value;
  const target = !isRecord(value)
    || !hasExactKeys(value, [
      "analysisKey",
      "baseSha",
      "formatVersion",
      "generationId",
      "headSha",
      "mergeBaseSha",
      "repositoryKey",
      "securityDigest",
    ])
    || value.formatVersion !== 1
    || value.repositoryKey !== coordinate.repositoryKey
    || value.securityDigest !== coordinate.securityDigest
    || value.headSha !== coordinate.headSha
    || value.baseSha !== coordinate.baseSha
    || value.analysisKey !== coordinate.analysisKey
    || typeof value.mergeBaseSha !== "string" || !GRAPH_COMMIT_ID.test(value.mergeBaseSha)
    || typeof value.generationId !== "string" || !GRAPH_GENERATION_ID.test(value.generationId)
    ? null
    : portableRelative(cacheRoot, finalizedGenerationDirectory(
        prHeadArtifactEntry(
          cacheRoot,
          coordinate.repositoryKey,
          coordinate.securityDigest,
          coordinate.subdirKey,
          coordinate.headSha,
          value.mergeBaseSha,
          coordinate.analysisKey,
        ),
        value.generationId,
      ));
  return {
    path: coordinate.path,
    coordinate,
    identity: snapshot.identity,
    target,
    touchedAtMs: nanosecondsToMilliseconds(snapshot.identity.mtimeNs),
  };
}

function readCleanupRecord(
  cacheRoot: string,
  wrapper: string,
  afterMetadataRead: (path: string) => void,
): CleanupRecordSnapshot | null {
  const snapshot = readSmallJson(join(wrapper, "cleanup.json"), afterMetadataRead);
  if (!snapshot) return null;
  const value = snapshot.value;
  if (!isRecord(value)
    || !hasExactKeys(value, ["createdAtMs", "formatVersion", "identity", "originalPath", "token"])
    || value.formatVersion !== FORMAT_VERSION
    || typeof value.token !== "string" || !/^[0-9a-f]{48}$/.test(value.token)
    || value.token !== basename(wrapper)
    || typeof value.originalPath !== "string" || !safeRelativePath(value.originalPath)
    || !validIdentity(value.identity)
    || !Number.isSafeInteger(value.createdAtMs) || (value.createdAtMs as number) < 0) return null;
  const generationPath = resolve(cacheRoot, value.originalPath);
  if (portableRelative(cacheRoot, generationPath) !== value.originalPath
    || !parseFinalizedGenerationPath(cacheRoot, generationPath)) return null;
  return {
    record: value as unknown as CleanupRecord,
    identity: snapshot.identity,
    cleanupOwners: generationCleanupOwners(cacheRoot, generationPath),
  };
}

function readSmallJson(
  path: string,
  afterMetadataRead: (path: string) => void,
): JsonFileSnapshot | null {
  if (!existsSync(path)) return null;
  const visible = fileIdentity(path);
  const size = Number(BigInt(visible.size));
  if (size > MAX_JSON_BYTES) return null;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fileIdentityFromStats(fstatSync(fd, { bigint: true }));
    if (!sameFileIdentity(visible, opened)) return null;
    const bytes = readFileSync(fd);
    const after = fileIdentityFromStats(fstatSync(fd, { bigint: true }));
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    afterMetadataRead(path);
    const afterPath = fileIdentity(path);
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(opened, afterPath)
      || bytes.byteLength !== size) return null;
    return { value, identity: opened };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

interface FullFileIdentity extends PathIdentity { readonly size: string }

function fileIdentity(path: string): FullFileIdentity {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("graph cache metadata is unsafe");
  return fileIdentityFromStats(entry);
}

function safeFileIdentity(path: string): FullFileIdentity | null {
  try {
    return fileIdentity(path);
  } catch {
    return null;
  }
}

function fileIdentityFromStats(entry: BigIntStats): FullFileIdentity {
  return { ...identityFromStats(entry), size: String(entry.size) };
}

function sameFileIdentity(left: FullFileIdentity, right: FullFileIdentity): boolean {
  return sameIdentity(left, right) && left.size === right.size;
}

function sameExactFileCandidate(
  left: ExactFileCandidate | null,
  right: ExactFileCandidate | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.path === right.path && sameFileIdentity(left.identity, right.identity);
}

function directoryIdentity(path: string): PathIdentity {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("graph generation is unsafe");
  return identityFromStats(entry);
}

function claimedPathSnapshotIsCurrent(expected: ClaimedPath): boolean {
  try {
    return sameClaimedPathIdentity(
      claimPathForCleanup(expected.path).identity,
      expected.identity,
    );
  } catch {
    return false;
  }
}

function emptyDirectoryCandidate(path: string): DirectoryCandidate | null {
  try {
    if (readdirSync(path).length > 0) return null;
    return { path, identity: directoryIdentity(path) };
  } catch {
    return null;
  }
}

function emptyDirectoryIsCurrent(candidate: DirectoryCandidate): boolean {
  try {
    return sameIdentity(directoryIdentity(candidate.path), candidate.identity)
      && readdirSync(candidate.path).length === 0;
  } catch {
    return false;
  }
}

function identityFromStats(entry: BigIntStats): PathIdentity {
  return {
    dev: String(entry.dev),
    ino: String(entry.ino),
    mtimeNs: String(entry.mtimeNs),
    ctimeNs: String(entry.ctimeNs),
  };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameCleanupRecord(left: CleanupRecord, right: CleanupRecord): boolean {
  return left.formatVersion === right.formatVersion
    && left.token === right.token
    && left.originalPath === right.originalPath
    && left.createdAtMs === right.createdAtMs
    && sameIdentity(left.identity, right.identity);
}

function sameInode(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validIdentity(value: unknown): value is PathIdentity {
  return isRecord(value)
    && hasExactKeys(value, ["ctimeNs", "dev", "ino", "mtimeNs"])
    && decimal(value.dev) && decimal(value.ino)
    && decimal(value.mtimeNs) && decimal(value.ctimeNs);
}

function nanosecondsToMilliseconds(value: string): number {
  const milliseconds = Number(BigInt(value)) / 1_000_000;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error("graph cache timestamp is invalid");
  }
  return milliseconds;
}

async function directoryBytes(
  path: string,
  budget: { remaining: number },
  signal: AbortSignal | undefined,
): Promise<number> {
  let bytes = 0;
  const visit = async (directoryPath: string): Promise<void> => {
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      throwIfAborted(signal);
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        throw new Error("graph generation traversal exceeded its entry limit");
      }
      const child = join(directoryPath, entry.name);
      const childEntry = await lstat(child);
      if (childEntry.isSymbolicLink()) throw new Error("graph generation contains a symbolic link");
      if (childEntry.isDirectory()) await visit(child);
      else if (childEntry.isFile()) bytes += childEntry.size;
      else throw new Error("graph generation contains an unsupported entry");
      if (!Number.isSafeInteger(bytes)) throw new Error("graph generation byte size overflowed");
    }
  };
  await visit(path);
  return bytes;
}

function normalizeRoots(cacheRoot: string, roots: Iterable<string>): Set<string> {
  const normalized = new Set<string>();
  for (const root of roots) {
    const absolute = resolve(isAbsolute(root) ? root : join(cacheRoot, root));
    if (!isContained(absolute, cacheRoot) || absolute === cacheRoot) {
      throw new Error("graph generation hard root escaped the cache root");
    }
    normalized.add(portableRelative(cacheRoot, absolute));
  }
  return normalized;
}

function requirePrivateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!isPlainDirectory(path)) throw new Error("graph generation GC directory is unsafe");
  return realpathSync(path);
}

function isPlainDirectory(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!safeRelativePath(value)) throw new Error("graph generation path is unsafe");
  return value;
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.includes("\\") && !path.startsWith("/") && !path.endsWith("/")
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isContained(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${label} must be positive`);
  return resolved;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const required = [...expected].sort(compareUtf8);
  return actual.length === required.length
    && actual.every((key, index) => key === required[index]);
}

async function removeClaims(claims: readonly ClaimedPath[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const claim of claims) {
    try {
      await removeClaimedPath(claim);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("graph generation collection aborted");
}
