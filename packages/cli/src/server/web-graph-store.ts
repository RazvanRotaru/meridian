/**
 * Process-private, disk-backed graph registrations for web mode.
 *
 * A store retains its temporary root path plus compact source-workspace lease handles. Every
 * descriptor and artifact lookup goes back to disk, so registering a graph never makes its object
 * graph part of long-lived server state.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import {
  syntheticScenarioDescriptorSchema,
  validateArtifact,
  type GraphArtifact,
  type SyntheticScenarioDescriptor,
} from "@meridian/core";
import type { SyntheticExecutionTrust } from "./web-boot";
import {
  resolveGraphRetentionOptions,
  selectGraphRetentionCandidates,
  type GraphRetentionCandidate,
  type GraphRetentionOptions,
} from "./web-graph-retention";
import type { ArtifactSource } from "./web-source";

const DESCRIPTOR_FORMAT_VERSION = 1 as const;
const ARTIFACT_NAME = "artifact.json";
const DESCRIPTOR_NAME = "descriptor.json";
const SHA256 = /^[a-f0-9]{64}$/;
const MATERIAL_PROOF = Symbol("web graph artifact material proof");

export interface WebGraphArtifactSummary {
  schemaVersion: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
}

interface ProvenArtifactMaterial {
  readonly [MATERIAL_PROOF]: true;
  /** SHA-256 of the exact bytes served by `/api/graph`. */
  readonly byteDigest: string;
  readonly summary: WebGraphArtifactSummary;
}

export interface SerializedArtifactMaterial extends ProvenArtifactMaterial {
  readonly kind: "serialized";
  readonly bytes: Buffer;
}

export interface VerifiedFileArtifactMaterial extends ProvenArtifactMaterial {
  readonly kind: "verified-file";
  /** An immutable file that the caller already read, parsed, validated, and digest-checked. */
  readonly path: string;
}

export type WebGraphArtifactMaterial = SerializedArtifactMaterial | VerifiedFileArtifactMaterial;

/**
 * Ownership token for a source workspace referenced by a graph descriptor.
 *
 * Repository workspaces live outside the process-private graph directory. Publishing consumes the
 * lease and keeps it while the registration is cached or actively pinned; eviction/disposal
 * releases it, and an exact republish releases the redundant candidate. This gives persistent-
 * cache eviction an explicit pinning boundary without retaining graph objects in memory.
 */
export interface WebGraphSourceLease {
  release(): void;
}

export type WebGraphViewLeaseErrorCode =
  | "capacity"
  | "expired_graph"
  | "invalid_selection"
  | "unknown_lease";

/** A safe, finite error vocabulary for the renderer's process-local view-lease protocol. */
export class WebGraphViewLeaseError extends Error {
  constructor(readonly code: WebGraphViewLeaseErrorCode, message: string) {
    super(message);
    this.name = "WebGraphViewLeaseError";
  }
}

/** Publication could not reserve bounded registry capacity without evicting an active owner. */
export class WebGraphStoreCapacityError extends Error {
  constructor() {
    super("graph registration capacity is currently in use; retry shortly");
    this.name = "WebGraphStoreCapacityError";
  }
}

export interface WebGraphViewLeaseGrant {
  readonly leaseId: string;
  readonly expiresAtMs: number;
  readonly heartbeatIntervalMs: number;
}

/** A request pin over one immutable registration. The handle never owns parsed graph state. */
export interface WebGraphRegistrationHandle {
  readonly descriptor: WebGraphDescriptor;
  readonly artifactPath: string;
  loadArtifact(): GraphArtifact;
  release(): void;
}

export interface WebGraphStoreStats {
  readonly registrations: number;
  readonly artifactBytes: number;
  readonly sourceLeases: number;
  readonly viewLeases: number;
  readonly trashEntries: number;
  readonly trashBytes: number;
}

export interface WebGraphStoreMaintenance {
  readonly onError?: (error: unknown) => void;
  /** Test seam for deterministic cleanup-failure coverage. */
  readonly removePath?: (path: string) => void;
  /** Test seam for deterministic transaction-rollback coverage. */
  readonly renamePath?: (source: string, destination: string) => void;
}

interface WebGraphEntryState {
  readonly id: string;
  readonly entryPath: string;
  readonly artifactBytes: number;
  readonly publishedAtMs: number;
  lastAccessAtMs: number;
  handoffUntilMs: number;
  requestPins: number;
  viewPins: number;
  sourceLease?: WebGraphSourceLease;
}

interface WebGraphViewState {
  readonly baseGraphId: string;
  graphIds: Set<string>;
  expiresAtMs: number;
}

interface PreparedGraphPublication {
  readonly id: string;
  readonly descriptor: WebGraphDescriptor;
  readonly artifactBytes: number;
  readonly material?: WebGraphArtifactMaterial;
  readonly sourceLease?: WebGraphSourceLease;
  readonly existingState?: WebGraphEntryState;
  stagePath?: string;
  readonly destinationPath?: string;
}

interface ReservedGraphEvictions {
  readonly rootPath: string;
  readonly entries: ReadonlyArray<{
    state: WebGraphEntryState;
    reservedPath: string;
  }>;
}

/**
 * Serialize one graph that an upstream analysis boundary has already validated.
 *
 * Keeping validation at that boundary is important: zod validation clones the whole object graph.
 * This materializer performs one serialization and one digest pass over the resulting bytes, and
 * those exact bytes and digest are then reused for identity and publication.
 */
export function materializeValidatedArtifact(artifact: GraphArtifact): SerializedArtifactMaterial {
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
  return {
    [MATERIAL_PROOF]: true,
    kind: "serialized",
    bytes,
    byteDigest: digest(bytes),
    summary: artifactSummary(artifact),
  };
}

/** O(1) descriptor data for an artifact that has already passed core validation. */
export function artifactSummary(artifact: GraphArtifact): WebGraphArtifactSummary {
  return {
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    nodeCount: artifact.nodes.length,
    edgeCount: artifact.edges.length,
  };
}

/**
 * Create a proof for an immutable cache file that the caller has already verified.
 *
 * This deliberately checks only path shape and compact proof fields. It never reads, parses, or
 * validates the artifact again; doing so would turn cache-to-store publication into a second full
 * graph materialization boundary.
 */
export function verifiedArtifactFile(
  path: string,
  byteDigest: string,
  summary: WebGraphArtifactSummary,
): VerifiedFileArtifactMaterial {
  const digestValue = requireSha256(byteDigest, "verified artifact byte digest");
  const summaryValue = parseSummary(summary, "verified artifact summary");
  requirePlainFile(path, "verified artifact file");
  return {
    [MATERIAL_PROOF]: true,
    kind: "verified-file",
    path,
    byteDigest: digestValue,
    summary: summaryValue,
  };
}

export interface WebGraphDescriptor {
  formatVersion: 1;
  id: string;
  /** SHA-256 of the exact bytes stored and served for this graph. */
  byteDigest: string;
  summary: WebGraphArtifactSummary;
  sourceRoot: string;
  source: ArtifactSource;
  synthetic: {
    scenarios: SyntheticScenarioDescriptor[];
    sourceFingerprint: string | null;
    trust: SyntheticExecutionTrust | null;
  };
}

export interface WebGraphRegistration {
  id: string;
  material: WebGraphArtifactMaterial;
  metadata: {
    sourceRoot: string;
    sourceLease?: WebGraphSourceLease;
    source: ArtifactSource;
    synthetic: {
      scenarios: SyntheticScenarioDescriptor[];
      sourceFingerprint: string | null;
      trust: SyntheticExecutionTrust | null;
    };
  };
}

/**
 * An immutable graph registry that retains only compact coordinates and lease counters alongside
 * its private temporary root, never graph objects or artifact bytes. Inactive registrations form a
 * bounded LRU/TTL cache. Renewable browser-view pins protect long-lived tabs, while request handles
 * protect graph streams, source reads, and executions until their exact response completes.
 */
export class WebGraphStore {
  readonly rootPath: string;
  readonly #options: GraphRetentionOptions;
  readonly #entries = new Map<string, WebGraphEntryState>();
  readonly #views = new Map<string, WebGraphViewState>();
  readonly #trashPaths = new Map<string, number>();
  readonly #sweepTimer: NodeJS.Timeout;
  readonly #onMaintenanceError: (error: unknown) => void;
  readonly #removePath: (path: string) => void;
  readonly #renamePath: (source: string, destination: string) => void;
  #disposed = false;

  constructor(
    options: Partial<GraphRetentionOptions> = {},
    maintenance: WebGraphStoreMaintenance = {},
  ) {
    this.#options = resolveGraphRetentionOptions(options);
    this.#onMaintenanceError = maintenance.onError ?? (() => {});
    this.#removePath = maintenance.removePath
      ?? ((path) => rmSync(path, { recursive: true, force: true }));
    this.#renamePath = maintenance.renamePath ?? renameSync;
    this.rootPath = realpathSync.native(mkdtempSync(join(tmpdir(), "meridian-web-graphs-")));
    this.#sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch (error) {
        this.#reportMaintenanceError(error);
      }
    }, this.#options.sweepIntervalMs);
    this.#sweepTimer.unref();
  }

  publish(registration: WebGraphRegistration): WebGraphDescriptor {
    return this.publishBatch([registration])[0]!;
  }

  /**
   * Atomically publish one coherent graph set, such as a PR's HEAD and merge-base pair.
   *
   * Calling this method transfers every distinct source lease immediately. Capacity is proven for
   * the whole set before an existing registration is evicted, and no new id becomes visible until
   * every artifact is staged and every destination rename succeeds.
   */
  publishBatch(registrations: readonly WebGraphRegistration[]): WebGraphDescriptor[] {
    const transferredLeases = new Set<WebGraphSourceLease>();
    const retainedLeases = new Set<WebGraphSourceLease>();
    const stages: PreparedGraphPublication[] = [];
    let duplicateSourceLease = false;
    for (const registration of registrations) {
      const sourceLease = registration.metadata.sourceLease;
      if (sourceLease === undefined) continue;
      if (transferredLeases.has(sourceLease)) {
        duplicateSourceLease = true;
        continue;
      }
      transferredLeases.add(sourceLease);
    }
    try {
      if (duplicateSourceLease) {
        throw new Error("a source workspace lease cannot be published more than once");
      }
      this.#assertActive();
      if (registrations.length === 0) return [];

      const ids = new Set<string>();
      const prepared: PreparedGraphPublication[] = registrations.map((registration) => {
        const id = requireNonEmptyString(registration.id, "graph id");
        if (ids.has(id)) throw new Error(`duplicate graph publication id: ${id}`);
        ids.add(id);
        const material = requireArtifactMaterial(registration.material, id);
        const descriptor = parseDescriptor({
          formatVersion: DESCRIPTOR_FORMAT_VERSION,
          id,
          byteDigest: material.byteDigest,
          summary: material.summary,
          sourceRoot: registration.metadata.sourceRoot,
          source: registration.metadata.source,
          synthetic: registration.metadata.synthetic,
        }, id);
        const sourceLease = registration.metadata.sourceLease;
        const existingState = this.#entries.get(id);
        if (existingState !== undefined) {
          const existing = this.#readDescriptor(existingState);
          return {
            id,
            descriptor: this.#acceptExactRepublish(existing, descriptor),
            artifactBytes: existingState.artifactBytes,
            ...(sourceLease === undefined ? {} : { sourceLease }),
            existingState,
          };
        }
        const destinationPath = this.#entryPath(id);
        if (existsSync(destinationPath)) {
          throw new Error(`graph id '${id}' has an unowned registry entry`);
        }
        return {
          id,
          descriptor,
          artifactBytes: artifactMaterialSize(material),
          material,
          ...(sourceLease === undefined ? {} : { sourceLease }),
          destinationPath,
        };
      });

      const now = this.#now();
      const evictionVictims = this.#planAdmission(prepared.map((item) => ({
        id: item.id,
        artifactBytes: item.artifactBytes,
        sourceLeases: (item.existingState?.sourceLease ?? item.sourceLease) === undefined ? 0 : 1,
        publishedAtMs: item.existingState?.publishedAtMs ?? now,
        lastAccessAtMs: now,
        pinned: true,
        handoffUntilMs: now + this.#options.publicationHandoffTtlMs,
      })));

      // Feasibility is known before any artifact bytes are copied. Record the expected complete
      // size as soon as a stage directory exists so even a partial write plus failed cleanup stays
      // inside retained-byte accounting.
      for (const item of prepared) {
        if (item.material === undefined) continue;
        const stagePath = mkdtempSync(join(this.rootPath, ".stage-"));
        item.stagePath = stagePath;
        stages.push(item);
        publishArtifactMaterial(item.material, join(stagePath, ARTIFACT_NAME));
        const stagedBytes = statSync(join(stagePath, ARTIFACT_NAME)).size;
        if (stagedBytes !== item.artifactBytes) {
          throw new Error(`graph '${item.id}' artifact changed during publication`);
        }
        writeFileSync(
          join(stagePath, DESCRIPTOR_NAME),
          `${JSON.stringify(item.descriptor, null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      }

      const reservation = this.#reserveEvictions(evictionVictims);
      const moved: PreparedGraphPublication[] = [];
      try {
        for (const item of prepared) {
          if (item.stagePath === undefined || item.destinationPath === undefined) continue;
          try {
            this.#renamePath(item.stagePath, item.destinationPath);
          } catch (error) {
            if (!existsSync(item.destinationPath)) throw error;
            throw new Error(`graph id '${item.id}' has an unowned registry entry`, { cause: error });
          }
          moved.push(item);
        }
      } catch (error) {
        this.#rollbackNewPublications(moved);
        this.#restoreReservedEvictions(reservation);
        throw error;
      }

      try {
        this.#commitReservedEvictions(reservation);
      } catch (error) {
        this.#rollbackNewPublications(moved);
        this.#restoreReservedEvictions(reservation);
        throw error;
      }

      for (const item of prepared) {
        if (item.existingState !== undefined) {
          item.existingState.lastAccessAtMs = now;
          item.existingState.handoffUntilMs = Math.max(
            item.existingState.handoffUntilMs,
            now + this.#options.publicationHandoffTtlMs,
          );
          if (item.sourceLease !== undefined && item.existingState.sourceLease === undefined) {
            item.existingState.sourceLease = item.sourceLease;
            retainedLeases.add(item.sourceLease);
          }
          continue;
        }
        this.#entries.set(item.id, {
          id: item.id,
          entryPath: item.destinationPath!,
          artifactBytes: item.artifactBytes,
          publishedAtMs: now,
          lastAccessAtMs: now,
          handoffUntilMs: now + this.#options.publicationHandoffTtlMs,
          requestPins: 0,
          viewPins: 0,
          ...(item.sourceLease === undefined ? {} : { sourceLease: item.sourceLease }),
        });
        if (item.sourceLease !== undefined) retainedLeases.add(item.sourceLease);
      }

      // Filesystem deletion is the irreversible side of the transaction. It starts only after
      // every destination rename and registry/source-ownership commit succeeds. A partial cleanup
      // failure therefore cannot corrupt a graph we attempt to roll back: the new publication
      // remains committed, leftover victim bytes are conservatively accounted, and later
      // admissions stop until maintenance removes them.
      this.#removeCommittedEvictions(reservation);

      return prepared.map((item) => item.descriptor);
    } finally {
      for (const stage of stages) {
        if (stage.stagePath !== undefined && existsSync(stage.stagePath)) {
          this.#discardUnregisteredPath(stage.stagePath, stage.artifactBytes);
        }
      }
      for (const lease of transferredLeases) {
        if (!retainedLeases.has(lease)) releaseSourceLease(lease);
      }
    }
  }

  /** Acquire one request-scoped registration reference. Callers must release it in `finally`. */
  acquire(id: string): WebGraphRegistrationHandle | undefined {
    this.#assertActive();
    if (id.length === 0) return undefined;
    const state = this.#entries.get(id);
    if (state === undefined) return undefined;
    const descriptor = this.#readDescriptor(state);
    const artifactPath = join(state.entryPath, ARTIFACT_NAME);
    requirePlainFile(artifactPath, `graph '${id}' artifact`);
    state.lastAccessAtMs = this.#now();
    state.requestPins += 1;
    let released = false;
    return {
      descriptor,
      artifactPath,
      loadArtifact: () => this.#loadPinnedArtifact(state, descriptor),
      release: () => {
        if (released) return;
        released = true;
        if (state.requestPins > 0) state.requestPins -= 1;
        if (!this.#disposed) this.#enforceRetention();
      },
    };
  }

  /** Create the lease injected into one `/view` document and pin its immutable boot graph. */
  createViewLease(
    baseGraphId: string,
    graphIds: readonly string[] = [baseGraphId],
  ): WebGraphViewLeaseGrant {
    this.#assertActive();
    const now = this.#now();
    this.#expireViews(now);
    if (this.#views.size >= this.#options.maxViewLeases) {
      throw new WebGraphViewLeaseError("capacity", "too many active graph views");
    }
    const nextIds = this.#validateViewSelection(baseGraphId, graphIds);
    const nextStates = new Map<string, WebGraphEntryState>();
    for (const id of nextIds) {
      const state = this.#entries.get(id);
      if (state === undefined) {
        throw new WebGraphViewLeaseError("expired_graph", "a graph needed by this view is no longer available");
      }
      nextStates.set(id, state);
    }
    const leaseId = this.#newLeaseId();
    const expiresAtMs = now + this.#options.viewLeaseTtlMs;
    for (const state of nextStates.values()) {
      state.viewPins += 1;
      state.lastAccessAtMs = now;
    }
    this.#views.set(leaseId, {
      baseGraphId,
      graphIds: nextIds,
      expiresAtMs,
    });
    return {
      leaseId,
      expiresAtMs,
      heartbeatIntervalMs: Math.max(1, Math.floor(this.#options.viewLeaseTtlMs / 3)),
    };
  }

  /** Atomically replace the exact graph set protected by one active browser view. */
  renewViewLease(leaseId: string, graphIds: readonly string[]): WebGraphViewLeaseGrant {
    this.#assertActive();
    const now = this.#now();
    this.#expireViews(now);
    const view = this.#views.get(leaseId);
    if (view === undefined) {
      throw new WebGraphViewLeaseError("unknown_lease", "the graph view lease has expired");
    }
    const nextIds = this.#validateViewSelection(view.baseGraphId, graphIds);
    const nextStates = new Map<string, WebGraphEntryState>();
    for (const id of nextIds) {
      const state = this.#entries.get(id);
      if (state === undefined) {
        throw new WebGraphViewLeaseError("expired_graph", "a graph needed by this view is no longer available");
      }
      nextStates.set(id, state);
    }
    // Validation is complete before any counter changes, so a failed replacement preserves the
    // old view exactly (the refresh rollback boundary in the renderer depends on this).
    for (const id of nextIds) {
      if (!view.graphIds.has(id)) nextStates.get(id)!.viewPins += 1;
      const state = nextStates.get(id)!;
      state.lastAccessAtMs = now;
    }
    for (const id of view.graphIds) {
      if (nextIds.has(id)) continue;
      const state = this.#entries.get(id);
      if (state !== undefined && state.viewPins > 0) state.viewPins -= 1;
    }
    view.graphIds = nextIds;
    view.expiresAtMs = now + this.#options.viewLeaseTtlMs;
    this.#enforceRetention();
    return {
      leaseId,
      expiresAtMs: view.expiresAtMs,
      heartbeatIntervalMs: Math.max(1, Math.floor(this.#options.viewLeaseTtlMs / 3)),
    };
  }

  /** Explicit close is best-effort and idempotent; crashes are reclaimed by TTL. */
  releaseViewLease(leaseId: string): void {
    if (this.#disposed) return;
    const view = this.#views.get(leaseId);
    if (view === undefined) return;
    this.#views.delete(leaseId);
    this.#unpinView(view);
    this.#enforceRetention();
  }

  /** Run one deterministic expiry/capacity pass. Public for fake-clock tests and diagnostics. */
  sweep(): void {
    if (this.#disposed) return;
    this.#retryTrashRemoval();
    const now = this.#now();
    this.#expireViews(now);
    const selection = selectGraphRetentionCandidates(
      [...this.#entries.values()].map((entry) => this.#retentionCandidate(entry)),
      this.#options,
      this.#trashUsage(),
    );
    for (const decision of selection.selected) {
      this.#evict(decision.candidate.id);
    }
  }

  stats(): WebGraphStoreStats {
    this.#assertActive();
    this.#expireViews(this.#now());
    let artifactBytes = 0;
    let sourceLeases = 0;
    for (const entry of this.#entries.values()) {
      artifactBytes += entry.artifactBytes;
      if (entry.sourceLease !== undefined) sourceLeases += 1;
    }
    const trashBytes = this.#trashBytes();
    return {
      registrations: this.#entries.size,
      artifactBytes: artifactBytes + trashBytes,
      sourceLeases,
      viewLeases: this.#views.size,
      trashEntries: this.#trashPaths.size,
      trashBytes,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#sweepTimer);
    this.#views.clear();
    for (const entry of this.#entries.values()) {
      if (entry.sourceLease !== undefined) releaseSourceLease(entry.sourceLease);
    }
    this.#entries.clear();
    this.#trashPaths.clear();
    try {
      rmSync(this.rootPath, { recursive: true, force: true });
    } catch (error) {
      this.#reportMaintenanceError(error);
    }
  }

  #acceptExactRepublish(
    existing: WebGraphDescriptor,
    candidate: WebGraphDescriptor,
  ): WebGraphDescriptor {
    if (!isDeepStrictEqual(existing, candidate)) {
      throw new Error(`graph id '${candidate.id}' is already registered with different immutable coordinates`);
    }
    requirePlainFile(join(this.#entryPath(candidate.id), ARTIFACT_NAME), `graph '${candidate.id}' artifact`);
    return existing;
  }

  #loadPinnedArtifact(
    state: WebGraphEntryState,
    descriptor: WebGraphDescriptor,
  ): GraphArtifact {
    const path = join(state.entryPath, ARTIFACT_NAME);
    requirePlainFile(path, `graph '${state.id}' artifact`);
    const bytes = readFileSync(path);
    if (digest(bytes) !== descriptor.byteDigest) {
      throw new Error(`graph '${state.id}' artifact digest does not match its descriptor`);
    }
    const artifact = parseArtifact(bytes, `graph '${state.id}' stored artifact`);
    if (!isDeepStrictEqual(artifactSummary(artifact), descriptor.summary)) {
      throw new Error(`graph '${state.id}' artifact summary does not match its descriptor`);
    }
    return artifact;
  }

  #readDescriptor(state: WebGraphEntryState): WebGraphDescriptor {
    requirePlainDirectory(state.entryPath, `graph '${state.id}' entry`);
    const path = join(state.entryPath, DESCRIPTOR_NAME);
    requirePlainFile(path, `graph '${state.id}' descriptor`);
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`graph '${state.id}' descriptor is not valid JSON`, { cause: error });
    }
    return parseDescriptor(input, state.id);
  }

  #validateViewSelection(baseGraphId: string, graphIds: readonly string[]): Set<string> {
    if (!Array.isArray(graphIds) || graphIds.length === 0 || graphIds.length > this.#options.maxIdsPerView) {
      throw new WebGraphViewLeaseError("invalid_selection", "graph view selection is outside its bounded size");
    }
    const ids = new Set<string>();
    for (const rawId of graphIds) {
      if (typeof rawId !== "string" || rawId.trim().length === 0 || rawId !== rawId.trim() || ids.has(rawId)) {
        throw new WebGraphViewLeaseError("invalid_selection", "graph view selection contains an invalid graph id");
      }
      ids.add(rawId);
    }
    if (!ids.has(baseGraphId)) {
      throw new WebGraphViewLeaseError("invalid_selection", "graph view selection must retain its boot graph");
    }
    return ids;
  }

  #expireViews(now: number): void {
    for (const [leaseId, view] of this.#views) {
      if (view.expiresAtMs > now) continue;
      this.#views.delete(leaseId);
      this.#unpinView(view);
    }
  }

  #unpinView(view: WebGraphViewState): void {
    for (const id of view.graphIds) {
      const entry = this.#entries.get(id);
      if (entry !== undefined && entry.viewPins > 0) entry.viewPins -= 1;
    }
  }

  #enforceRetention(): void {
    if (this.#disposed) return;
    this.sweep();
  }

  /**
   * Reserve hard-bounded capacity for a new or republished registration before it becomes visible.
   * The proposed candidate is treated as pinned while the deterministic selector evicts eligible
   * inactive entries. If active/request/handoff owners occupy the budget, publication is rejected
   * without rebinding an id or consuming its source lease.
   */
  #planAdmission(proposed: readonly GraphRetentionCandidate[]): WebGraphEntryState[] {
    const now = this.#now();
    this.#retryTrashRemoval();
    this.#expireViews(now);
    const proposedIds = new Set(proposed.map(({ id }) => id));
    if (proposedIds.size !== proposed.length) {
      throw new Error("duplicate proposed graph registration id");
    }
    const candidates = [
      ...[...this.#entries.values()]
        .filter((entry) => !proposedIds.has(entry.id))
        .map((entry) => this.#retentionCandidate(entry)),
      ...proposed,
    ];
    const selection = selectGraphRetentionCandidates(
      candidates,
      this.#options,
      this.#trashUsage(),
    );
    // Prove feasibility before mutating the existing cache. An oversized batch or active-owner
    // pressure must never evict unrelated registrations and then fail anyway.
    if (!this.#fits(selection.projected)) throw new WebGraphStoreCapacityError();
    return selection.selected.flatMap(({ candidate }) => {
      if (proposedIds.has(candidate.id)) return [];
      const state = this.#entries.get(candidate.id);
      if (state === undefined || state.requestPins > 0 || state.viewPins > 0) {
        throw new Error(`graph '${candidate.id}' changed during synchronous admission planning`);
      }
      return [state];
    });
  }

  #retentionCandidate(entry: WebGraphEntryState): GraphRetentionCandidate {
    return {
      id: entry.id,
      artifactBytes: entry.artifactBytes,
      sourceLeases: entry.sourceLease === undefined ? 0 : 1,
      publishedAtMs: entry.publishedAtMs,
      lastAccessAtMs: entry.lastAccessAtMs,
      handoffUntilMs: entry.handoffUntilMs,
      pinned: entry.requestPins > 0 || entry.viewPins > 0,
    };
  }

  #fits(usage: { entries: number; artifactBytes: number; sourceLeases: number }): boolean {
    return usage.entries <= this.#options.maxEntries
      && usage.artifactBytes <= this.#options.maxArtifactBytes
      && usage.sourceLeases <= this.#options.maxSourceLeases;
  }

  #reserveEvictions(victims: readonly WebGraphEntryState[]): ReservedGraphEvictions | null {
    if (victims.length === 0) return null;
    const rootPath = mkdtempSync(join(this.rootPath, ".eviction-"));
    const entries: Array<{ state: WebGraphEntryState; reservedPath: string }> = [];
    const reservation: ReservedGraphEvictions = { rootPath, entries };
    try {
      for (const [index, state] of victims.entries()) {
        const reservedPath = join(rootPath, String(index));
        this.#renamePath(state.entryPath, reservedPath);
        entries.push({ state, reservedPath });
      }
      return reservation;
    } catch (error) {
      this.#restoreReservedEvictions(reservation);
      throw error;
    }
  }

  #commitReservedEvictions(reservation: ReservedGraphEvictions | null): void {
    if (reservation === null) return;
    for (const { state } of reservation.entries) {
      if (this.#entries.get(state.id) !== state) {
        throw new Error(`graph '${state.id}' changed during synchronous eviction commit`);
      }
    }
    for (const { state } of reservation.entries) {
      this.#entries.delete(state.id);
      if (state.sourceLease !== undefined) releaseSourceLease(state.sourceLease);
    }
  }

  #removeCommittedEvictions(reservation: ReservedGraphEvictions | null): void {
    if (reservation === null) return;
    try {
      this.#removePath(reservation.rootPath);
    } catch (error) {
      this.#reportMaintenanceError(error);
      const retainedBytes = reservation.entries.reduce(
        (total, { state }) => total + state.artifactBytes,
        0,
      );
      // Recursive removal may have made partial progress. Count the full known victim set until a
      // retry succeeds; conservative over-accounting keeps subsequent publication bounded.
      this.#trashPaths.set(reservation.rootPath, retainedBytes);
    }
  }

  #restoreReservedEvictions(reservation: ReservedGraphEvictions | null): void {
    if (reservation === null) return;
    let retainedBytes = 0;
    for (const { state, reservedPath } of [...reservation.entries].reverse()) {
      if (!this.#reservedEntryIsComplete(state, reservedPath)) {
        this.#reportMaintenanceError(new Error(`graph '${state.id}' eviction rollback material is unavailable`));
        this.#entries.delete(state.id);
        if (state.sourceLease !== undefined) releaseSourceLease(state.sourceLease);
        if (existsSync(reservedPath)) retainedBytes += state.artifactBytes;
        continue;
      }
      try {
        this.#renamePath(reservedPath, state.entryPath);
      } catch (error) {
        this.#reportMaintenanceError(error);
        this.#entries.delete(state.id);
        if (state.sourceLease !== undefined) releaseSourceLease(state.sourceLease);
        if (existsSync(reservedPath)) retainedBytes += state.artifactBytes;
      }
    }
    if (existsSync(reservation.rootPath)) {
      // A failed restore may leave complete or partial victim material in the reservation. Count
      // each such victim at its full known size until recursive cleanup succeeds; over-accounting
      // a partial file is safer than allowing a failed rollback to escape the byte bound.
      this.#discardUnregisteredPath(reservation.rootPath, retainedBytes);
    }
  }

  #reservedEntryIsComplete(state: WebGraphEntryState, reservedPath: string): boolean {
    try {
      requirePlainDirectory(reservedPath, `graph '${state.id}' eviction reservation`);
      requirePlainFile(
        join(reservedPath, DESCRIPTOR_NAME),
        `graph '${state.id}' reserved descriptor`,
      );
      const artifactPath = join(reservedPath, ARTIFACT_NAME);
      requirePlainFile(artifactPath, `graph '${state.id}' reserved artifact`);
      return statSync(artifactPath).size === state.artifactBytes;
    } catch {
      return false;
    }
  }

  #rollbackNewPublications(publications: readonly PreparedGraphPublication[]): void {
    for (const item of publications) {
      if (item.destinationPath !== undefined && existsSync(item.destinationPath)) {
        this.#discardUnregisteredPath(item.destinationPath, item.artifactBytes);
      }
    }
  }

  #evict(id: string): boolean {
    const state = this.#entries.get(id);
    if (state === undefined || state.requestPins > 0 || state.viewPins > 0) return false;
    const trash = join(this.rootPath, `.trash-${randomBytes(12).toString("hex")}`);
    try {
      this.#renamePath(state.entryPath, trash);
    } catch (error) {
      this.#reportMaintenanceError(error);
      return false;
    }
    this.#entries.delete(id);
    if (state.sourceLease !== undefined) releaseSourceLease(state.sourceLease);
    this.#trashPaths.set(trash, state.artifactBytes);
    this.#removeTrash(trash);
    return true;
  }

  #retryTrashRemoval(): void {
    for (const path of this.#trashPaths.keys()) this.#removeTrash(path);
  }

  #removeTrash(path: string): void {
    try {
      this.#removePath(path);
      this.#trashPaths.delete(path);
    } catch (error) {
      this.#reportMaintenanceError(error);
    }
  }

  #discardUnregisteredPath(path: string, artifactBytes: number): void {
    this.#trashPaths.set(path, artifactBytes);
    this.#removeTrash(path);
  }

  #trashBytes(): number {
    let bytes = 0;
    for (const artifactBytes of this.#trashPaths.values()) bytes += artifactBytes;
    return bytes;
  }

  #trashUsage(): { entries: number; artifactBytes: number; sourceLeases: number } {
    return {
      entries: this.#trashPaths.size,
      artifactBytes: this.#trashBytes(),
      sourceLeases: 0,
    };
  }

  #reportMaintenanceError(error: unknown): void {
    try {
      this.#onMaintenanceError(error);
    } catch {
      // Diagnostics must never turn best-effort cleanup into a process failure.
    }
  }

  #newLeaseId(): string {
    for (;;) {
      const candidate = randomBytes(24).toString("base64url");
      if (!this.#views.has(candidate)) return candidate;
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #entryPath(id: string): string {
    return join(this.rootPath, createHash("sha256").update(id).digest("hex"));
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("web graph store has been disposed");
  }
}

function releaseSourceLease(lease: WebGraphSourceLease): void {
  try {
    lease.release();
  } catch {
    // Cleanup is best-effort. A lease implementation must not make graph publication or process
    // shutdown fail merely because its bookkeeping was already removed by external cache cleanup.
  }
}

function publishArtifactMaterial(material: WebGraphArtifactMaterial, destination: string): void {
  if (material.kind === "serialized") {
    writeFileSync(destination, material.bytes, { flag: "wx", mode: 0o600 });
    return;
  }
  // COPYFILE_FICLONE requests a copy-on-write clone where the filesystem supports it and falls
  // back to an ordinary copy otherwise. Unlike a hard link, either result gives the graph store an
  // independently owned inode: later cache-file writes cannot mutate bytes behind an immutable id.
  copyFileSync(material.path, destination, constants.COPYFILE_FICLONE);
}

function artifactMaterialSize(material: WebGraphArtifactMaterial): number {
  return material.kind === "serialized" ? material.bytes.length : statSync(material.path).size;
}

function requireArtifactMaterial(material: WebGraphArtifactMaterial, id: string): WebGraphArtifactMaterial {
  if (material === null || typeof material !== "object" || material[MATERIAL_PROOF] !== true) {
    throw new Error(`graph '${id}' requires a proven artifact material`);
  }
  requireSha256(material.byteDigest, `graph '${id}' artifact byte digest`);
  parseSummary(material.summary, `graph '${id}' artifact summary`);
  if (material.kind === "serialized") {
    if (!Buffer.isBuffer(material.bytes)) throw new Error(`graph '${id}' serialized artifact bytes must be a buffer`);
    return material;
  }
  if (material.kind !== "verified-file") throw new Error(`graph '${id}' artifact material kind is invalid`);
  requirePlainFile(material.path, `graph '${id}' verified artifact`);
  return material;
}

function parseArtifact(bytes: Buffer, label: string): GraphArtifact {
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  return validatedArtifact(input, label);
}

function validatedArtifact(input: unknown, label: string): GraphArtifact {
  const result = validateArtifact(input);
  if (!result.ok || result.artifact === undefined) {
    const details = result.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
    throw new Error(`${label} is not a valid graph artifact${details ? `: ${details}` : ""}`);
  }
  return result.artifact;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseDescriptor(input: unknown, expectedId: string): WebGraphDescriptor {
  const descriptor = requireRecord(input, `graph '${expectedId}' descriptor`);
  requireExactKeys(descriptor, [
    "byteDigest",
    "formatVersion",
    "id",
    "source",
    "sourceRoot",
    "summary",
    "synthetic",
  ], `graph '${expectedId}' descriptor`);
  if (descriptor.formatVersion !== DESCRIPTOR_FORMAT_VERSION) {
    throw new Error(`graph '${expectedId}' descriptor has an unsupported format version`);
  }
  const id = requireNonEmptyString(descriptor.id, `graph '${expectedId}' descriptor id`);
  if (id !== expectedId) throw new Error(`graph '${expectedId}' descriptor id does not match its lookup key`);
  const byteDigest = requireSha256(descriptor.byteDigest, `graph '${expectedId}' artifact byte digest`);
  const summary = parseSummary(descriptor.summary, `graph '${expectedId}' summary`);
  const synthetic = requireRecord(descriptor.synthetic, `graph '${expectedId}' synthetic metadata`);
  requireExactKeys(synthetic, ["scenarios", "sourceFingerprint", "trust"], `graph '${expectedId}' synthetic metadata`);
  if (!Array.isArray(synthetic.scenarios)) throw new Error(`graph '${expectedId}' synthetic scenarios must be an array`);

  return {
    formatVersion: DESCRIPTOR_FORMAT_VERSION,
    id,
    byteDigest,
    summary,
    sourceRoot: requireNonEmptyString(descriptor.sourceRoot, `graph '${expectedId}' source root`),
    source: parseSource(descriptor.source, expectedId),
    synthetic: {
      scenarios: synthetic.scenarios.map((scenario, index) => parseScenario(scenario, expectedId, index)),
      sourceFingerprint: nullableNonEmptyString(synthetic.sourceFingerprint, `graph '${expectedId}' synthetic source fingerprint`),
      trust: parseTrust(synthetic.trust, expectedId),
    },
  };
}

function parseSource(input: unknown, id: string): ArtifactSource {
  const source = requireRecord(input, `graph '${id}' source`);
  if (source.kind === "path" || source.kind === "other") {
    requireExactKeys(source, ["kind"], `graph '${id}' source`);
    return { kind: source.kind };
  }
  if (source.kind !== "github") throw new Error(`graph '${id}' source kind is invalid`);
  const keys = source.subdir === undefined ? ["kind", "owner", "repo"] : ["kind", "owner", "repo", "subdir"];
  requireExactKeys(source, keys, `graph '${id}' source`);
  const result: ArtifactSource = {
    kind: "github",
    owner: requireNonEmptyString(source.owner, `graph '${id}' source owner`),
    repo: requireNonEmptyString(source.repo, `graph '${id}' source repo`),
  };
  if (source.subdir !== undefined) result.subdir = requireNonEmptyString(source.subdir, `graph '${id}' source subdir`);
  return result;
}

function parseScenario(input: unknown, id: string, index: number): SyntheticScenarioDescriptor {
  const parsed = syntheticScenarioDescriptorSchema.safeParse(input);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, input)) {
    throw new Error(`graph '${id}' synthetic scenario ${index} is invalid`);
  }
  return parsed.data;
}

function parseTrust(input: unknown, id: string): SyntheticExecutionTrust | null {
  if (input === null) return null;
  const trust = requireRecord(input, `graph '${id}' synthetic trust`);
  if (trust.mode === "local") {
    requireExactKeys(trust, ["mode"], `graph '${id}' synthetic trust`);
    return { mode: "local" };
  }
  if (trust.mode !== "sandboxed-pr") throw new Error(`graph '${id}' synthetic trust mode is invalid`);
  requireExactKeys(trust, ["mode", "provenance"], `graph '${id}' synthetic trust`);
  const provenance = requireRecord(trust.provenance, `graph '${id}' synthetic trust provenance`);
  requireExactKeys(provenance, ["headSha", "repository"], `graph '${id}' synthetic trust provenance`);
  return {
    mode: "sandboxed-pr",
    provenance: {
      repository: requireNonEmptyString(provenance.repository, `graph '${id}' synthetic repository`),
      headSha: requireNonEmptyString(provenance.headSha, `graph '${id}' synthetic head SHA`),
    },
  };
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} fields must be exactly ${expected.join(", ")}`);
  }
}

function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error(`${label} must be a non-empty string`);
  return input;
}

function requireSha256(input: unknown, label: string): string {
  const value = requireNonEmptyString(input, label);
  if (!SHA256.test(value)) throw new Error(`${label} is not SHA-256`);
  return value;
}

function parseSummary(input: unknown, label: string): WebGraphArtifactSummary {
  const summary = requireRecord(input, label);
  requireExactKeys(summary, ["edgeCount", "generatedAt", "nodeCount", "schemaVersion"], label);
  return {
    schemaVersion: requireNonEmptyString(summary.schemaVersion, `${label} schema version`),
    generatedAt: requireNonEmptyString(summary.generatedAt, `${label} generated time`),
    nodeCount: requireCount(summary.nodeCount, `${label} node count`),
    edgeCount: requireCount(summary.edgeCount, `${label} edge count`),
  };
}

function nullableNonEmptyString(input: unknown, label: string): string | null {
  return input === null ? null : requireNonEmptyString(input, label);
}

function requireCount(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return input;
}

function requirePlainDirectory(path: string, label: string): void {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} is not a plain directory`);
}

function requirePlainFile(path: string, label: string): void {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} is not a plain file`);
}
