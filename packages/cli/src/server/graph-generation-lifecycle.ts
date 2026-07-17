/**
 * Cross-process ownership for immutable graph generations.
 *
 * A lease is persisted before a generation is read or exposed. Generation GC uses the same
 * cache-root lock and treats every live lease as a hard root, so it can never race a verifier,
 * cache lookup, or capability publisher. Leases have process-start identity rather than an age
 * deadline: a paused live process remains an owner, while a dead or PID-reused owner is repaired
 * deterministically after restart.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CacheRootLifecycleLock,
  resolveProcessIdentity,
  type ProcessIdentityResolver,
} from "./cache-root-lifecycle-lock";
import {
  graphGenerationStagePath,
  graphGenerationStagingRoot,
  parseFinalizedGenerationPath,
  parseGraphGenerationStagePath,
} from "./graph-cache-layout";
import {
  claimPathForCleanup,
  moveClaimedPath,
  removeClaimedPath,
  sameClaimedPathIdentity,
  type ClaimedPath,
} from "./claimed-path-cleanup";

const FORMAT_VERSION = 1;
const ROOT_DIRECTORY = "graph-generation-lifecycle";
const VERSION_DIRECTORY = "v1";
const LEASES_DIRECTORY = "leases";
const STAGING_LEASES_DIRECTORY = "staging-leases";
const QUARANTINE_DIRECTORY = "quarantine";
const REJECTED_DIRECTORY = "rejected";
const MAX_LEASE_BYTES = 8 * 1024;
const TOKEN = /^[0-9a-f]{48}$/;

export type GraphGenerationLeasePurpose = "cache-read" | "publication" | "verification" | "staging";

interface GraphGenerationLeaseRecord {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly token: string;
  readonly pid: number;
  readonly processIdentity: string;
  readonly purpose: Exclude<GraphGenerationLeasePurpose, "staging">;
  readonly generationPath: string;
  readonly acquiredAtMs: number;
}

interface GraphGenerationStageLeaseRecord {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly token: string;
  readonly pid: number;
  readonly processIdentity: string;
  readonly purpose: "staging";
  readonly generationPath: string;
  readonly identity: ClaimedPath["identity"];
  readonly acquiredAtMs: number;
}

interface LeaseHandleAuthority {
  readonly marker: string;
  readonly markerIdentity: FileIdentity;
  readonly record: GraphGenerationLeaseRecord;
}

interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly kind: ClaimedPath["identity"]["kind"];
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface GraphGenerationLease {
  readonly generationDirectory: string;
  readonly purpose: GraphGenerationLeasePurpose;
  release(): Promise<void>;
}

/** Mutable extraction directory with durable exact-identity ownership until atomic publication. */
export interface GraphGenerationStage {
  readonly directory: string;
  publish(
    destinationLease: GraphGenerationLease,
    signal?: AbortSignal,
  ): Promise<boolean>;
  release(): Promise<void>;
}

interface StageHandleOperation {
  readonly directory: string;
  seal<T>(
    operation: () => Promise<GraphGenerationStageSealResult<T>> | GraphGenerationStageSealResult<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

/**
 * Process-local proof that one frozen stage tree is still the tree that sealing authenticated.
 * The lifecycle owns when this proof may be installed and invokes it on both sides of the atomic
 * publication rename. Callers cannot publish an unsealed mutable stage.
 */
export interface GraphGenerationStagePublicationSeal {
  assertCurrent(generationDirectory: string): void;
}

export interface GraphGenerationStageSealResult<T> {
  readonly value: T;
  readonly publicationSeal: GraphGenerationStagePublicationSeal;
}

const stageHandleOperations = new WeakMap<GraphGenerationStage, StageHandleOperation>();

/** Seal a live stage exactly once and install its publication proof on the owning stage handle. */
export function sealGraphGenerationStage<T>(
  stage: GraphGenerationStage,
  directory: string,
  operation: () => Promise<GraphGenerationStageSealResult<T>> | GraphGenerationStageSealResult<T>,
  signal?: AbortSignal,
): Promise<T> {
  const authority = stageHandleOperations.get(stage);
  if (!authority || authority.directory !== resolve(directory)) {
    throw new Error("graph generation stage handle does not own this directory");
  }
  return authority.seal(operation, signal);
}

export interface GraphGenerationLifecycleOptions {
  readonly cacheRoot: string;
  readonly processIdentity?: ProcessIdentityResolver;
  readonly processAlive?: (pid: number) => boolean;
  readonly now?: () => number;
  /** Test seam after atomic quarantine and outside lifecycle admission. */
  readonly beforePhysicalCleanup?: (paths: readonly string[]) => Promise<void>;
  /** Test seam immediately before a live handle claims its marker for release. */
  readonly beforeLeaseReleaseClaim?: (path: string) => void;
  /** Test seam after the atomic stage rename and before immutable post-rename validation. */
  readonly afterStagePublicationMove?: (destination: string) => void;
}

export interface GraphGenerationLeaseSnapshot {
  readonly generationPaths: ReadonlySet<string>;
  readonly activeLeases: number;
  readonly repairedLeases: number;
}

export class GraphGenerationLifecycle {
  private readonly lexicalCacheRoot: string;
  private readonly cacheRoot: string;
  private readonly leasesRoot: string;
  private readonly stagingLeasesRoot: string;
  private readonly stagingRoot: string;
  private readonly quarantineRoot: string;
  private readonly rejectedRoot: string;
  private readonly lifecycleLock: CacheRootLifecycleLock;
  private readonly processIdentity: ProcessIdentityResolver;
  private readonly processAlive: (pid: number) => boolean;
  private readonly ownerProcessIdentity: string;
  private readonly now: () => number;
  private readonly beforePhysicalCleanup: (paths: readonly string[]) => Promise<void>;
  private readonly beforeLeaseReleaseClaim: (path: string) => void;
  private readonly afterStagePublicationMove: (destination: string) => void;
  private readonly leaseAuthorities = new WeakMap<GraphGenerationLease, LeaseHandleAuthority>();

  constructor(options: GraphGenerationLifecycleOptions) {
    if (!options.cacheRoot.trim()) throw new TypeError("graph generation cache root is required");
    this.lexicalCacheRoot = resolve(options.cacheRoot);
    mkdirSync(this.lexicalCacheRoot, { recursive: true, mode: 0o700 });
    this.cacheRoot = requirePlainDirectory(realpathSync(this.lexicalCacheRoot));
    const root = requirePrivateDirectory(join(this.cacheRoot, ROOT_DIRECTORY));
    const version = requirePrivateDirectory(join(root, VERSION_DIRECTORY));
    this.leasesRoot = requirePrivateDirectory(join(version, LEASES_DIRECTORY));
    this.stagingLeasesRoot = requirePrivateDirectory(join(version, STAGING_LEASES_DIRECTORY));
    this.quarantineRoot = requirePrivateDirectory(join(version, QUARANTINE_DIRECTORY));
    this.rejectedRoot = requirePrivateDirectory(join(version, REJECTED_DIRECTORY));
    this.stagingRoot = requirePrivateDirectory(graphGenerationStagingRoot(this.cacheRoot));
    this.processIdentity = options.processIdentity ?? resolveProcessIdentity;
    this.processAlive = options.processAlive ?? defaultProcessAlive;
    this.ownerProcessIdentity = this.processIdentity(process.pid)
      ?? `unverifiable:${process.pid}:${randomBytes(24).toString("hex")}`;
    this.now = options.now ?? Date.now;
    this.beforePhysicalCleanup = options.beforePhysicalCleanup ?? (() => Promise.resolve());
    this.beforeLeaseReleaseClaim = options.beforeLeaseReleaseClaim ?? (() => undefined);
    this.afterStagePublicationMove = options.afterStagePublicationMove ?? (() => undefined);
    this.lifecycleLock = new CacheRootLifecycleLock(this.cacheRoot, {
      processIdentity: this.processIdentity,
      now: this.now,
    });
  }

  /** Pin an existing generation, or reserve its exact destination before atomic publication. */
  async acquire(
    generationDirectory: string,
    options: {
      readonly purpose: GraphGenerationLeasePurpose;
      readonly allowMissing?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<GraphGenerationLease> {
    if (options.purpose === "staging") {
      throw new Error("mutable graph stages must be reserved through reserveStage");
    }
    const lease = await this.acquireResolved(
      () => generationDirectory,
      options,
    );
    if (!lease) throw new Error("graph generation resolver returned no path");
    return lease;
  }

  /**
   * Create a mutable stage and its exact-identity marker in one lifecycle-lock epoch.
   * No stage path becomes visible before durable ownership exists.
   */
  async reserveStage(signal?: AbortSignal): Promise<GraphGenerationStage> {
    const token = randomBytes(24).toString("hex");
    const directory = graphGenerationStagePath(this.cacheRoot, token);
    const marker = join(this.stagingLeasesRoot, `${token}.json`);
    let markerIdentity: FileIdentity | undefined;
    let record: GraphGenerationStageLeaseRecord | undefined;
    let abandoned: ClaimedPath | undefined;
    let reserveFailed = false;
    let reserveError: unknown;
    try {
      await this.lifecycleLock.runExclusive(() => {
        mkdirSync(directory, { mode: 0o700 });
        const claimed = claimPathForCleanup(directory);
        if (claimed.identity.kind !== "directory") {
          throw new Error("graph generation stage is not a directory");
        }
        record = {
          formatVersion: FORMAT_VERSION,
          token,
          pid: process.pid,
          processIdentity: this.ownerProcessIdentity,
          purpose: "staging",
          generationPath: portableRelative(this.cacheRoot, directory),
          identity: claimed.identity,
          acquiredAtMs: this.now(),
        };
        try {
          writeFileSync(marker, `${JSON.stringify(record)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o400,
          });
          markerIdentity = pathIdentity(marker);
        } catch (error) {
          const quarantine = join(
            this.quarantineRoot,
            `${token}.unowned-stage-${randomBytes(8).toString("hex")}`,
          );
          abandoned = moveClaimedPath({
            source: directory,
            expected: claimed,
            destination: quarantine,
            rejected: join(this.rejectedRoot, `unowned-stage-${randomBytes(16).toString("hex")}`),
            label: "unowned graph generation stage",
          });
          throw error;
        }
      }, signal);
    } catch (error) {
      reserveFailed = true;
      reserveError = error;
    }
    let cleanupFailed = false;
    let cleanupError: unknown;
    if (abandoned) {
      try {
        await this.cleanupClaims([abandoned]);
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
    if (reserveFailed && cleanupFailed) {
      throw new AggregateError(
        [reserveError, cleanupError],
        "graph generation stage reservation and rollback both failed",
      );
    }
    if (reserveFailed) throw reserveError;
    if (cleanupFailed) throw cleanupError;
    if (!record || !markerIdentity) throw new Error("graph generation stage reservation was incomplete");
    return this.createStageHandle(directory, marker, markerIdentity, record);
  }

  /** Validate durable ownership before and after work performed by an extraction subprocess. */
  async withOwnedStage<T>(
    stageDirectory: string,
    operation: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    const coordinate = parseGraphGenerationStagePath(this.cacheRoot, stageDirectory);
    if (!coordinate) throw new Error("graph generation stage path is not a current staging coordinate");
    const marker = join(this.stagingLeasesRoot, `${coordinate.token}.json`);
    let loaded!: { record: GraphGenerationStageLeaseRecord; identity: FileIdentity };
    await this.lifecycleLock.runExclusive(() => {
      const candidate = this.readStageLease(marker);
      if (!candidate || !this.leaseOwnerIsAlive(candidate.record)) {
        throw new Error("graph generation stage has no live durable owner");
      }
      this.stageClaim(coordinate.directory, candidate.record.identity, false);
      loaded = candidate;
    }, signal);
    return this.withStageHandleOperation(
      coordinate.directory,
      marker,
      loaded.identity,
      loaded.record,
      operation,
      signal,
    );
  }

  /**
   * Resolve a bounded metadata alias and persist its exact generation pin in one lock epoch.
   * The resolver is synchronous by design: callers may parse one small pointer file, but cannot
   * hold lifecycle admission across network, hashing, or recursive filesystem work.
   */
  async acquireResolvedGeneration(
    resolveGenerationDirectory: () => string | null,
    options: {
      readonly purpose: GraphGenerationLeasePurpose;
      readonly signal?: AbortSignal;
    },
  ): Promise<GraphGenerationLease | null> {
    return this.acquireResolved(resolveGenerationDirectory, options);
  }

  private async acquireResolved(
    resolveGenerationDirectory: () => string | null,
    options: {
      readonly purpose: GraphGenerationLeasePurpose;
      readonly allowMissing?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<GraphGenerationLease | null> {
    const purpose = options.purpose;
    if (purpose === "staging") {
      throw new Error("mutable graph stages must be reserved through reserveStage");
    }
    const token = randomBytes(24).toString("hex");
    const marker = join(this.leasesRoot, `${token}.json`);
    let canonicalGeneration: string | null = null;
    let markerIdentity: FileIdentity | undefined;
    let record: GraphGenerationLeaseRecord | undefined;
    await this.lifecycleLock.runExclusive(() => {
      const generationDirectory = resolveGenerationDirectory();
      if (generationDirectory === null) return;
      canonicalGeneration = this.resolveGenerationPath(
        generationDirectory,
        options.allowMissing === true,
      );
      record = {
        formatVersion: FORMAT_VERSION,
        token,
        pid: process.pid,
        processIdentity: this.ownerProcessIdentity,
        purpose,
        generationPath: portableRelative(this.cacheRoot, canonicalGeneration),
        acquiredAtMs: this.now(),
      };
      writeFileSync(marker, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o400,
      });
      markerIdentity = pathIdentity(marker);
    }, options.signal);

    if (canonicalGeneration === null || markerIdentity === undefined || record === undefined) return null;

    let released = false;
    let releasePromise: Promise<void> | null = null;
    let releaseClaim: ClaimedPath | null = null;
    const releaseQuarantine = join(
      this.quarantineRoot,
      `${token}.release-${randomBytes(8).toString("hex")}`,
    );
    const handle: GraphGenerationLease = Object.freeze({
      generationDirectory: canonicalGeneration,
      purpose,
      release: () => {
        if (released) return Promise.resolve();
        if (releasePromise) return releasePromise;
        releasePromise = (async () => {
          let markerAlreadyGone = false;
          if (!releaseClaim) {
            await this.lifecycleLock.runExclusive(() => {
              if (existsSync(releaseQuarantine)) {
                const quarantinedIdentity = safePathIdentity(releaseQuarantine);
                if (existsSync(marker) || !quarantinedIdentity
                  || !sameFileObject(quarantinedIdentity, markerIdentity!)) {
                  throw new Error("graph generation lease release quarantine was replaced");
                }
                releaseClaim = claimPathForCleanup(releaseQuarantine);
                return;
              }
              const loaded = this.readLease(marker);
              if (!loaded || loaded.record.token !== token
                || !sameIdentity(loaded.identity, markerIdentity!)) {
                markerAlreadyGone = true;
                return;
              }
              this.beforeLeaseReleaseClaim(marker);
              releaseClaim = moveClaimedPath({
                source: marker,
                expected: fileClaim(marker, markerIdentity!),
                destination: releaseQuarantine,
                rejected: join(this.rejectedRoot, `lease-release-${randomBytes(16).toString("hex")}`),
                label: "graph generation lease",
              });
            });
          }
          if (releaseClaim) {
            await this.cleanupClaims([releaseClaim]);
            releaseClaim = null;
          } else if (!markerAlreadyGone) {
            throw new Error("graph generation lease release did not establish cleanup authority");
          }
          released = true;
        })().finally(() => {
          releasePromise = null;
        });
        return releasePromise;
      },
    });
    this.leaseAuthorities.set(handle, { marker, markerIdentity, record });
    return handle;
  }

  private createStageHandle(
    directory: string,
    marker: string,
    markerIdentity: FileIdentity,
    record: GraphGenerationStageLeaseRecord,
  ): GraphGenerationStage {
    let published = false;
    let released = false;
    let sealing = false;
    let releasePromise: Promise<void> | null = null;
    let publicationSeal: GraphGenerationStagePublicationSeal | null = null;
    const handle: GraphGenerationStage = Object.freeze({
      directory,
      publish: async (destinationLease: GraphGenerationLease, signal?: AbortSignal) => {
        if (released) throw new Error("graph generation stage was already released");
        if (published) throw new Error("graph generation stage was already published");
        if (sealing) throw new Error("graph generation stage sealing is still in progress");
        if (!publicationSeal) throw new Error("graph generation stage is not sealed for publication");
        const didPublish = await this.publishStage(
          directory,
          marker,
          markerIdentity,
          record,
          destinationLease,
          publicationSeal,
          signal,
        );
        published = didPublish;
        return didPublish;
      },
      release: () => {
        if (sealing) return Promise.reject(new Error("graph generation stage sealing is still in progress"));
        if (released) return Promise.resolve();
        if (releasePromise) return releasePromise;
        releasePromise = this.releaseStage(directory, marker, markerIdentity, record)
          .then(() => { released = true; })
          .finally(() => { releasePromise = null; });
        return releasePromise;
      },
    });
    stageHandleOperations.set(handle, {
      directory,
      seal: async <T>(
        operation: () => Promise<GraphGenerationStageSealResult<T>> | GraphGenerationStageSealResult<T>,
        signal?: AbortSignal,
      ): Promise<T> => {
        if (released || published || sealing || publicationSeal) {
          throw new Error("graph generation stage cannot be sealed");
        }
        sealing = true;
        try {
          const sealed = await this.withStageHandleOperation(
            directory,
            marker,
            markerIdentity,
            record,
            operation,
            signal,
          );
          if (!sealed || typeof sealed !== "object"
            || !sealed.publicationSeal
            || typeof sealed.publicationSeal.assertCurrent !== "function") {
            throw new Error("graph generation stage sealing returned no publication proof");
          }
          sealed.publicationSeal.assertCurrent(directory);
          publicationSeal = Object.freeze(sealed.publicationSeal);
          return sealed.value;
        } finally {
          sealing = false;
        }
      },
    });
    return handle;
  }

  private async withStageHandleOperation<T>(
    directory: string,
    marker: string,
    markerIdentity: FileIdentity,
    record: GraphGenerationStageLeaseRecord,
    operation: () => Promise<T> | T,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    await this.lifecycleLock.runExclusive(() => {
      this.assertStageMarkerCurrent(marker, markerIdentity, record);
      this.stageClaim(directory, record.identity, false);
    }, signal);
    let value!: T;
    let operationFailed = false;
    let operationError: unknown;
    try {
      value = await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let ownershipFailed = false;
    let ownershipError: unknown;
    try {
      await this.lifecycleLock.runExclusive(() => {
        this.assertStageMarkerCurrent(marker, markerIdentity, record);
        this.stageClaim(directory, record.identity, false);
      }, signal);
    } catch (error) {
      ownershipFailed = true;
      ownershipError = error;
    }
    if (operationFailed && ownershipFailed) {
      throw new AggregateError(
        [operationError, ownershipError],
        "graph generation stage operation and ownership validation both failed",
      );
    }
    if (operationFailed) throw operationError;
    if (ownershipFailed) throw ownershipError;
    return value;
  }

  private async publishStage(
    directory: string,
    marker: string,
    markerIdentity: FileIdentity,
    record: GraphGenerationStageLeaseRecord,
    destinationLease: GraphGenerationLease,
    publicationSeal: GraphGenerationStagePublicationSeal,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const destinationAuthority = this.leaseAuthorities.get(destinationLease);
    if (destinationLease.purpose !== "publication" || !destinationAuthority
      || destinationAuthority.record.purpose !== "publication") {
      throw new Error("graph generation stage destination is not publication-owned");
    }
    return this.lifecycleLock.runExclusive(() => {
      const destination = this.resolveGenerationPath(destinationLease.generationDirectory, true);
      const activeDestination = this.readLease(destinationAuthority.marker);
      if (destination !== destinationLease.generationDirectory
        || !activeDestination
        || activeDestination.record.token !== destinationAuthority.record.token
        || activeDestination.record.purpose !== "publication"
        || activeDestination.record.generationPath !== portableRelative(this.cacheRoot, destination)
        || !sameIdentity(activeDestination.identity, destinationAuthority.markerIdentity)) {
        throw new Error("graph generation stage destination lease is no longer active");
      }
      this.assertStageMarkerCurrent(marker, markerIdentity, record);
      const current = this.stageClaim(directory, record.identity, false);
      if (!current) throw new Error("graph generation stage is unavailable");
      publicationSeal.assertCurrent(directory);
      if (safeEntryIdentity(destination)) {
        this.resolveGenerationPath(destination, false);
        return false;
      }
      // macOS may reject renaming a read-only directory. Thaw only the exact claimed inode while
      // lifecycle admission is held, then immediately restore the immutable mode after rename.
      setClaimedDirectoryMode(current, 0o700);
      const published = moveClaimedPath({
        source: directory,
        expected: current,
        destination,
        rejected: join(this.rejectedRoot, `published-stage-${randomBytes(16).toString("hex")}`),
        label: "graph generation stage",
      });
      try {
        this.afterStagePublicationMove(destination);
        setClaimedDirectoryMode(published, 0o500);
        publicationSeal.assertCurrent(destination);
      } catch (error) {
        let preservationFailed = false;
        let preservationError: unknown;
        try {
          this.preserveFailedPublication(destination);
        } catch (preserveError) {
          preservationFailed = true;
          preservationError = preserveError;
        }
        if (preservationFailed) {
          throw new AggregateError(
            [error, preservationError],
            "graph generation changed across publication and could not be preserved",
          );
        }
        throw error;
      }
      return true;
    }, signal);
  }

  private preserveFailedPublication(destination: string): void {
    let current: ClaimedPath;
    try {
      current = claimPathForCleanup(destination);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return;
      throw error;
    }
    if (current.identity.kind === "directory") setClaimedDirectoryMode(current, 0o700);
    moveClaimedPath({
      source: destination,
      expected: current,
      destination: join(this.rejectedRoot, `failed-publication-${randomBytes(16).toString("hex")}`),
      rejected: join(this.rejectedRoot, `failed-publication-race-${randomBytes(16).toString("hex")}`),
      label: "failed graph generation publication",
    });
  }

  private async releaseStage(
    directory: string,
    marker: string,
    markerIdentity: FileIdentity,
    record: GraphGenerationStageLeaseRecord,
  ): Promise<void> {
    const claims: ClaimedPath[] = [];
    let admissionFailed = false;
    let admissionError: unknown;
    try {
      await this.lifecycleLock.runExclusive(() => {
        const loaded = this.readStageLease(marker);
        if (!loaded) {
          if (safeEntryIdentity(directory)) {
            throw new Error("graph generation stage marker disappeared before its directory");
          }
          return;
        }
        if (loaded.record.token !== record.token
          || !sameIdentity(loaded.identity, markerIdentity)
          || !sameClaimedPathIdentity(loaded.record.identity, record.identity)) {
          throw new Error("graph generation stage marker changed before release");
        }
        const current = this.stageClaim(directory, record.identity, true);
        if (current) {
          claims.push(this.quarantineStage(directory, record.identity, "release"));
        }
        claims.push(this.quarantineLease(marker, markerIdentity));
      });
    } catch (error) {
      admissionFailed = true;
      admissionError = error;
    }
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      await this.cleanupClaims(claims);
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
    if (admissionFailed && cleanupFailed) {
      throw new AggregateError(
        [admissionError, cleanupError],
        "graph generation stage release and cleanup both failed",
      );
    }
    if (admissionFailed) throw admissionError;
    if (cleanupFailed) throw cleanupError;
  }

  async withLease<T>(
    generationDirectory: string,
    options: {
      readonly purpose: GraphGenerationLeasePurpose;
      readonly allowMissing?: boolean;
      readonly signal?: AbortSignal;
    },
    operation: (lease: GraphGenerationLease) => Promise<T> | T,
  ): Promise<T> {
    const lease = await this.acquire(generationDirectory, options);
    let value!: T;
    let operationFailed = false;
    let operationError: unknown;
    try {
      value = await operation(lease);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      await lease.release();
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (operationFailed && releaseFailed) {
      throw new AggregateError(
        [operationError, releaseError],
        "graph generation operation and lease release both failed",
      );
    }
    if (operationFailed) throw operationError;
    if (releaseFailed) throw releaseError;
    return value;
  }

  /** Reconcile dead owners and return cache-root-relative hard roots for the generation collector. */
  async activeLeaseSnapshot(signal?: AbortSignal): Promise<GraphGenerationLeaseSnapshot> {
    return this.withActiveLeaseSnapshot((snapshot) => snapshot, signal);
  }

  /** Execute one short lifecycle decision against an atomic snapshot of all live generation pins. */
  async withActiveLeaseSnapshot<T>(
    operation: (snapshot: GraphGenerationLeaseSnapshot) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    const residue = this.scanQuarantineResidue();
    const quarantines: ClaimedPath[] = [];
    let value!: T;
    let operationFailed = false;
    let operationError: unknown;
    try {
      value = await this.lifecycleLock.runExclusive(
        () => {
          this.claimQuarantineResidueLocked(residue, quarantines);
          return operation(this.scanActiveLeasesLocked(quarantines));
        },
        signal,
      );
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      await this.cleanupClaims(quarantines);
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
    if (operationFailed && cleanupFailed) {
      throw new AggregateError(
        [operationError, cleanupError],
        "graph generation lease snapshot and quarantine cleanup both failed",
      );
    }
    if (operationFailed) throw operationError;
    if (cleanupFailed) throw cleanupError;
    return value;
  }

  /** Shared lock boundary used by pointer publication and generation sweep decisions. */
  runExclusive<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    return this.lifecycleLock.runExclusive(operation, signal);
  }

  private scanActiveLeasesLocked(quarantines: ClaimedPath[]): GraphGenerationLeaseSnapshot {
    const generationPaths = new Set<string>();
    let repairedLeases = 0;
    let activeLeases = 0;
    for (const entry of readdirSync(this.leasesRoot, { withFileTypes: true })) {
      const path = join(this.leasesRoot, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
        quarantines.push(this.quarantineLease(path, entryIdentity(path)));
        repairedLeases += 1;
        continue;
      }
      const loaded = this.readLease(path);
      if (!loaded || !this.leaseOwnerIsAlive(loaded.record)) {
        quarantines.push(this.quarantineLease(path, loaded?.identity ?? entryIdentity(path)));
        repairedLeases += 1;
        continue;
      }
      generationPaths.add(loaded.record.generationPath);
      activeLeases += 1;
    }
    const stages = new Map<string, ClaimedPath>();
    const markers = new Map<string, ClaimedPath>();
    const extras: Array<{ claim: ClaimedPath; label: string }> = [];
    for (const entry of readdirSync(this.stagingRoot, { withFileTypes: true })) {
      const path = join(this.stagingRoot, entry.name);
      const claim = claimPathForCleanup(path);
      const token = stageToken(entry.name);
      if (token) stages.set(token, claim);
      else extras.push({ claim, label: "unrecognized graph generation stage" });
    }
    for (const entry of readdirSync(this.stagingLeasesRoot, { withFileTypes: true })) {
      const path = join(this.stagingLeasesRoot, entry.name);
      const claim = claimPathForCleanup(path);
      const token = stageMarkerToken(entry.name);
      if (token) markers.set(token, claim);
      else extras.push({ claim, label: "unrecognized graph generation stage marker" });
    }
    for (const extra of extras) {
      quarantines.push(this.quarantineOwnedClaim(extra.claim, extra.label));
      repairedLeases += 1;
    }
    const tokens = new Set([...stages.keys(), ...markers.keys()]);
    for (const token of tokens) {
      const stage = stages.get(token);
      const markerClaim = markers.get(token);
      const marker = markerClaim?.path;
      const loaded = marker ? this.readStageLease(marker) : null;
      if (!loaded) {
        if (stage) quarantines.push(this.quarantineOwnedClaim(stage, "orphan graph generation stage"));
        if (markerClaim) {
          quarantines.push(this.quarantineOwnedClaim(markerClaim, "malformed graph generation stage marker"));
        }
        repairedLeases += 1;
        continue;
      }
      const expectedDirectory = graphGenerationStagePath(this.cacheRoot, token);
      if (resolve(this.cacheRoot, loaded.record.generationPath) !== expectedDirectory) {
        if (stage) quarantines.push(this.quarantineOwnedClaim(stage, "misbound graph generation stage"));
        quarantines.push(this.quarantineOwnedClaim(markerClaim!, "misbound graph generation stage marker"));
        repairedLeases += 1;
        continue;
      }
      if (stage && !sameClaimedPathIdentity(stage.identity, loaded.record.identity)) {
        this.preserveOwnedClaim(stage, "replaced graph generation stage");
        quarantines.push(this.quarantineOwnedClaim(markerClaim!, "stale graph generation stage marker"));
        repairedLeases += 1;
        continue;
      }
      if (this.leaseOwnerIsAlive(loaded.record)) {
        activeLeases += 1;
        continue;
      }
      if (stage) quarantines.push(this.quarantineOwnedClaim(stage, "dead graph generation stage"));
      quarantines.push(this.quarantineOwnedClaim(markerClaim!, "dead graph generation stage marker"));
      repairedLeases += 1;
    }
    return Object.freeze({ generationPaths, activeLeases, repairedLeases });
  }

  private resolveGenerationPath(input: string, allowMissing: boolean): string {
    const candidate = resolve(isAbsolute(input) ? input : join(this.lexicalCacheRoot, input));
    const traversalRoot = isContained(candidate, this.lexicalCacheRoot)
      ? this.lexicalCacheRoot
      : isContained(candidate, this.cacheRoot)
        ? this.cacheRoot
        : null;
    if (traversalRoot === null || candidate === traversalRoot) {
      throw new Error("graph generation path escaped the cache root");
    }
    const parent = dirname(candidate);
    const canonicalParent = requireContainedDirectory(this.cacheRoot, traversalRoot, parent);
    if (basename(canonicalParent) !== "generations") {
      throw new Error("graph generation path is not a direct child of a generations directory");
    }
    const canonical = join(canonicalParent, basename(candidate));
    if (!parseFinalizedGenerationPath(this.cacheRoot, canonical)) {
      throw new Error("graph generation path is not a current finalized cache coordinate");
    }
    if (!existsSync(candidate)) {
      if (!allowMissing) throw new Error("graph generation is unavailable");
      return canonical;
    }
    const entry = lstatSync(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(candidate) !== canonical) {
      throw new Error("graph generation path is unsafe");
    }
    return canonical;
  }

  private readLease(path: string): { record: GraphGenerationLeaseRecord; identity: FileIdentity } | null {
    return this.readLeaseFile(
      path,
      (value): value is GraphGenerationLeaseRecord => validLeaseRecord(value, this.cacheRoot, basename(path)),
    );
  }

  private readStageLease(
    path: string,
  ): { record: GraphGenerationStageLeaseRecord; identity: FileIdentity } | null {
    return this.readLeaseFile(path, validStageLeaseRecord);
  }

  private readLeaseFile<T>(
    path: string,
    validate: (value: unknown) => value is T,
  ): { record: T; identity: FileIdentity } | null {
    let visible: FileIdentity;
    try {
      visible = pathIdentity(path);
      if (BigInt(visible.size) > BigInt(MAX_LEASE_BYTES)) return null;
    } catch {
      return null;
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | noFollow);
    } catch {
      return null;
    }
    try {
      const opened = identityFromStats(fstatSync(fd, { bigint: true }));
      if (!sameIdentity(visible, opened)) return null;
      const bytes = readFileSync(fd);
      const after = identityFromStats(fstatSync(fd, { bigint: true }));
      const afterPath = safePathIdentity(path);
      if (!sameIdentity(opened, after) || !afterPath || !sameIdentity(opened, afterPath)
        || bytes.byteLength !== Number(BigInt(after.size))) return null;
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        return null;
      }
      return validate(value) ? { record: value, identity: opened } : null;
    } finally {
      closeSync(fd);
    }
  }

  private leaseOwnerIsAlive(record: GraphGenerationLeaseRecord | GraphGenerationStageLeaseRecord): boolean {
    if (!this.processAlive(record.pid)) return false;
    const current = this.processIdentity(record.pid);
    if (current === null || record.processIdentity.startsWith("unverifiable:")) {
      // Identity-unaware platforms must fail safe while the PID is alive. The marker is repaired
      // after process death, so this can delay collection but can never reclaim a live owner.
      return true;
    }
    return current === record.processIdentity;
  }

  private quarantineLease(path: string, expected: FileIdentity): ClaimedPath {
    const current = safeEntryIdentity(path);
    if (!current || !sameIdentity(current, expected)) {
      throw new Error("graph generation lease changed during reconciliation");
    }
    const quarantine = join(this.quarantineRoot, `${basename(path)}.${randomBytes(8).toString("hex")}`);
    return moveClaimedPath({
      source: path,
      expected: fileClaim(path, expected),
      destination: quarantine,
      rejected: join(this.rejectedRoot, `lease-${randomBytes(16).toString("hex")}`),
      label: "graph generation lease",
    });
  }

  private assertStageMarkerCurrent(
    marker: string,
    markerIdentity: FileIdentity,
    expected: GraphGenerationStageLeaseRecord,
  ): void {
    const loaded = this.readStageLease(marker);
    if (!loaded
      || loaded.record.token !== expected.token
      || !sameIdentity(loaded.identity, markerIdentity)
      || !sameClaimedPathIdentity(loaded.record.identity, expected.identity)) {
      throw new Error("graph generation stage marker changed");
    }
  }

  private stageClaim(
    path: string,
    expected: ClaimedPath["identity"],
    allowMissing: boolean,
  ): ClaimedPath | null {
    let claimed: ClaimedPath;
    try {
      claimed = claimPathForCleanup(path);
    } catch (error) {
      if (allowMissing && isErrnoCode(error, "ENOENT")) return null;
      throw error;
    }
    if (!sameClaimedPathIdentity(claimed.identity, expected)) {
      throw new Error("graph generation stage changed while owned");
    }
    return claimed;
  }

  private quarantineStage(
    path: string,
    expected: ClaimedPath["identity"],
    reason: string,
  ): ClaimedPath {
    const current = this.stageClaim(path, expected, false);
    if (!current) throw new Error("graph generation stage is unavailable");
    setClaimedDirectoryMode(current, 0o700);
    const quarantine = join(
      this.quarantineRoot,
      `stage-${reason}-${randomBytes(16).toString("hex")}`,
    );
    return moveClaimedPath({
      source: path,
      expected: current,
      destination: quarantine,
      rejected: join(this.rejectedRoot, `stage-${randomBytes(16).toString("hex")}`),
      label: "graph generation stage",
    });
  }

  private quarantineOwnedClaim(claim: ClaimedPath, label: string): ClaimedPath {
    if (claim.identity.kind === "directory") setClaimedDirectoryMode(claim, 0o700);
    return moveClaimedPath({
      source: claim.path,
      expected: claim,
      destination: join(this.quarantineRoot, `owned-${randomBytes(16).toString("hex")}`),
      rejected: join(this.rejectedRoot, `owned-${randomBytes(16).toString("hex")}`),
      label,
    });
  }

  private preserveOwnedClaim(claim: ClaimedPath, label: string): string {
    const destination = join(this.rejectedRoot, `preserved-${randomBytes(16).toString("hex")}`);
    if (claim.identity.kind === "directory") setClaimedDirectoryMode(claim, 0o700);
    moveClaimedPath({
      source: claim.path,
      expected: claim,
      destination,
      rejected: join(this.rejectedRoot, `preserved-race-${randomBytes(16).toString("hex")}`),
      label,
    });
    return destination;
  }

  private scanQuarantineResidue(): ClaimedPath[] {
    const residue: ClaimedPath[] = [];
    for (const entry of readdirSync(this.quarantineRoot, { withFileTypes: true })) {
      try {
        residue.push(claimPathForCleanup(join(this.quarantineRoot, entry.name)));
      } catch (error) {
        if (!isErrnoCode(error, "ENOENT")) throw error;
        // A concurrent lifecycle instance may already have claimed this residue.
      }
    }
    return residue;
  }

  private claimQuarantineResidueLocked(
    residue: readonly ClaimedPath[],
    quarantines: ClaimedPath[],
  ): void {
    for (const candidate of residue) {
      let current: ClaimedPath;
      try {
        current = claimPathForCleanup(candidate.path);
      } catch (error) {
        if (!isErrnoCode(error, "ENOENT")) throw error;
        continue;
      }
      if (!sameClaimedPathIdentity(current.identity, candidate.identity)) continue;
      const claimed = join(this.quarantineRoot, `reconcile-${randomBytes(16).toString("hex")}`);
      try {
        quarantines.push(moveClaimedPath({
          source: candidate.path,
          expected: candidate,
          destination: claimed,
          rejected: join(this.rejectedRoot, `residue-${randomBytes(16).toString("hex")}`),
          label: "graph generation lifecycle residue",
        }));
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) continue;
        throw error;
      }
    }
  }

  private async cleanupClaims(claims: readonly ClaimedPath[]): Promise<void> {
    if (claims.length === 0) return;
    await this.beforePhysicalCleanup(Object.freeze(claims.map((claim) => claim.path)));
    const errors: unknown[] = [];
    for (const claim of claims) {
      try {
        await removeClaimedPath(claim);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "graph generation lease quarantine cleanup failed");
    }
  }
}

function validLeaseRecord(
  value: unknown,
  cacheRoot: string,
  markerBasename: string,
): value is GraphGenerationLeaseRecord {
  if (!isRecord(value)
    || Object.keys(value).length !== 7
    || value.formatVersion !== FORMAT_VERSION
    || typeof value.token !== "string" || !TOKEN.test(value.token)
    || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || typeof value.processIdentity !== "string" || value.processIdentity.length === 0
      || value.processIdentity.length > 512
    || !isFinalizedPurpose(value.purpose)
    || typeof value.generationPath !== "string" || !safeRelativePath(value.generationPath)
    || !Number.isSafeInteger(value.acquiredAtMs) || (value.acquiredAtMs as number) < 0) return false;
  if (markerBasename !== `${value.token}.json`) return false;
  const generation = resolve(cacheRoot, ...value.generationPath.split("/"));
  return parseFinalizedGenerationPath(cacheRoot, generation) !== null;
}

function validStageLeaseRecord(value: unknown): value is GraphGenerationStageLeaseRecord {
  if (!isRecord(value)
    || Object.keys(value).length !== 8
    || value.formatVersion !== FORMAT_VERSION
    || typeof value.token !== "string" || !TOKEN.test(value.token)
    || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || typeof value.processIdentity !== "string" || value.processIdentity.length === 0
      || value.processIdentity.length > 512
    || value.purpose !== "staging"
    || typeof value.generationPath !== "string" || !safeRelativePath(value.generationPath)
    || !validClaimedIdentity(value.identity)
    || !Number.isSafeInteger(value.acquiredAtMs) || (value.acquiredAtMs as number) < 0) return false;
  const parts = value.generationPath.split("/");
  return parts.length === 4
    && parts[0] === "graph-generation-staging"
    && parts[1] === "v1"
    && parts[2] === "generations"
    && parts[3] === `stage-${value.token}`;
}

function isFinalizedPurpose(value: unknown): value is Exclude<GraphGenerationLeasePurpose, "staging"> {
  return value === "cache-read" || value === "publication" || value === "verification";
}

function validClaimedIdentity(value: unknown): value is ClaimedPath["identity"] {
  return isRecord(value)
    && Object.keys(value).length === 3
    && decimal(value.dev)
    && decimal(value.ino)
    && value.kind === "directory";
}

function requirePrivateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return requirePlainDirectory(path);
}

function requireContainedDirectory(root: string, traversalRoot: string, path: string): string {
  const candidate = resolve(path);
  if (!isContained(candidate, traversalRoot)) {
    throw new Error("graph generation path escaped the cache root");
  }
  let cursor = traversalRoot;
  for (const part of relative(traversalRoot, candidate).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const entry = lstatSync(cursor);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("graph generation path contains an unsafe ancestor");
    }
  }
  const canonical = realpathSync(candidate);
  if (!isContained(canonical, root)) throw new Error("graph generation path escaped the cache root");
  return canonical;
}

function requirePlainDirectory(path: string): string {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("graph generation lifecycle directory is unsafe");
  }
  return realpathSync(path);
}

function pathIdentity(path: string): FileIdentity {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("graph generation lease is unsafe");
  return identityFromStats(entry);
}

function safePathIdentity(path: string): FileIdentity | null {
  try {
    return pathIdentity(path);
  } catch {
    return null;
  }
}

function entryIdentity(path: string): FileIdentity {
  return identityFromStats(lstatSync(path, { bigint: true }));
}

function safeEntryIdentity(path: string): FileIdentity | null {
  try {
    return entryIdentity(path);
  } catch {
    return null;
  }
}

function identityFromStats(entry: BigIntStats): FileIdentity {
  return {
    dev: String(entry.dev),
    ino: String(entry.ino),
    kind: entry.isSymbolicLink()
      ? "symlink"
      : entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other",
    size: String(entry.size),
    mtimeNs: String(entry.mtimeNs),
    ctimeNs: String(entry.ctimeNs),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameFileObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.kind === right.kind && left.size === right.size;
}

function fileClaim(path: string, expected: FileIdentity): ClaimedPath {
  return Object.freeze({
    path,
    identity: Object.freeze({ dev: expected.dev, ino: expected.ino, kind: expected.kind }),
  });
}

function setClaimedDirectoryMode(claim: ClaimedPath, mode: number): void {
  if (claim.identity.kind !== "directory") {
    throw new Error("graph generation publication claim is not a directory");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const directoryOnly = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  const fd = openSync(claim.path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    const opened = identityFromStats(fstatSync(fd, { bigint: true }));
    if (opened.dev !== claim.identity.dev || opened.ino !== claim.identity.ino
      || opened.kind !== claim.identity.kind) {
      throw new Error("graph generation publication claim changed before chmod");
    }
    fchmodSync(fd, mode);
    const afterFd = identityFromStats(fstatSync(fd, { bigint: true }));
    const afterPath = entryIdentity(claim.path);
    if (afterFd.dev !== claim.identity.dev || afterFd.ino !== claim.identity.ino
      || afterFd.kind !== claim.identity.kind
      || afterPath.dev !== claim.identity.dev || afterPath.ino !== claim.identity.ino
      || afterPath.kind !== claim.identity.kind) {
      throw new Error("graph generation publication claim changed during chmod");
    }
  } finally {
    closeSync(fd);
  }
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!safeRelativePath(value)) throw new Error("graph generation relative path is unsafe");
  return value;
}

function safeRelativePath(path: string): boolean {
  if (!path || path.includes("\\") || path.startsWith("/") || path.endsWith("/")) return false;
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isContained(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function stageToken(name: string): string | null {
  return /^stage-([0-9a-f]{48})$/.exec(name)?.[1] ?? null;
}

function stageMarkerToken(name: string): string | null {
  return /^([0-9a-f]{48})\.json$/.exec(name)?.[1] ?? null;
}
