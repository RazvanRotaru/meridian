import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { throwIfAborted } from "./web-cancellation";

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60_000;

const DEFAULT_MAX_BYTES = 20 * GIB;
const DEFAULT_MAX_IDLE_MS = 30 * DAY_MS;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60_000;
const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_ACCESS_TOUCH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_CAPACITY_GRACE_MS = 5 * 60_000;
const DEFAULT_LOW_WATER_RATIO = 0.8;

const MAX_GIB_ENV = "MERIDIAN_REPOSITORY_CACHE_MAX_GIB";
const MAX_AGE_DAYS_ENV = "MERIDIAN_REPOSITORY_CACHE_MAX_AGE_DAYS";

/** Fully resolved repository-store retention policy. */
export interface RepositoryRetentionOptions {
  readonly maxBytes: number;
  readonly lowWaterBytes: number;
  readonly maxIdleMs: number;
  readonly sweepIntervalMs: number;
  readonly initialDelayMs: number;
  readonly accessTouchIntervalMs: number;
  /** Hard post-access residency window, including publication-to-lease handoff. */
  readonly capacityGraceMs: number;
  /** Test seam for deterministic age decisions. */
  readonly now?: () => number;
}

/** One independently removable unit observed during a background store scan. */
export interface RepositoryRetentionCandidate {
  /** Stable identity used as the deterministic LRU tie-breaker. */
  readonly id: string;
  readonly sizeBytes: number;
  readonly lastAccessMs: number;
  /** A live lease is a soft pin: skip this run, but keep considering later candidates. */
  readonly pinned: boolean;
}

export interface RepositoryRetentionSnapshot<
  Candidate extends RepositoryRetentionCandidate = RepositoryRetentionCandidate,
> {
  /** Size of the complete store, including non-candidate mirror data and metadata. */
  readonly totalBytes: number;
  readonly candidates: readonly Candidate[];
}

export type RepositoryRetentionReason = "max-idle" | "capacity";

export interface RepositoryRetentionDecision<
  Candidate extends RepositoryRetentionCandidate = RepositoryRetentionCandidate,
> {
  readonly candidate: Candidate;
  readonly reason: RepositoryRetentionReason;
}

export interface RepositoryRetentionDeferral<
  Candidate extends RepositoryRetentionCandidate = RepositoryRetentionCandidate,
> {
  readonly candidate: Candidate;
  readonly reason: "pinned" | "recent";
  readonly trigger: RepositoryRetentionReason;
}

export interface CapacityRetentionOptions {
  readonly targetBytes: number;
  /** Capacity pressure never evicts data within this handoff/navigation grace window. */
  readonly minimumAccessAgeMs?: number;
  readonly now?: number;
}

export interface RepositoryRetentionSelection<
  Candidate extends RepositoryRetentionCandidate = RepositoryRetentionCandidate,
> {
  readonly selected: readonly RepositoryRetentionDecision<Candidate>[];
  readonly deferred: readonly RepositoryRetentionDeferral<Candidate>[];
  readonly totalBytes: number;
  readonly selectedBytes: number;
  /** Best-effort size after deleting every selected candidate. */
  readonly projectedBytes: number;
  /** Whether the post-age-eviction projection crossed the high watermark. */
  readonly pressure: boolean;
}

export type RepositoryRetentionPass<
  Candidate extends RepositoryRetentionCandidate = RepositoryRetentionCandidate,
> = Omit<RepositoryRetentionSelection<Candidate>, "pressure">;

/**
 * Apply defaults and validate a caller-supplied policy.
 *
 * When only the high watermark is overridden, the low watermark remains 80% of that value. This
 * preserves the default 20 GiB / 16 GiB hysteresis and avoids a default low watermark that is
 * invalid for a smaller configured cache.
 */
export function resolveRepositoryRetentionOptions(
  options: Partial<RepositoryRetentionOptions> = {},
): RepositoryRetentionOptions {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lowWaterBytes = options.lowWaterBytes ?? Math.floor(maxBytes * DEFAULT_LOW_WATER_RATIO);
  const maxIdleMs = options.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const accessTouchIntervalMs = options.accessTouchIntervalMs ?? DEFAULT_ACCESS_TOUCH_INTERVAL_MS;
  const capacityGraceMs = options.capacityGraceMs ?? DEFAULT_CAPACITY_GRACE_MS;

  requirePositiveSafeInteger(maxBytes, "maxBytes");
  requireNonNegativeSafeInteger(lowWaterBytes, "lowWaterBytes");
  if (lowWaterBytes >= maxBytes) {
    throw new RangeError("lowWaterBytes must be less than maxBytes");
  }
  requirePositiveSafeInteger(maxIdleMs, "maxIdleMs");
  requirePositiveSafeInteger(sweepIntervalMs, "sweepIntervalMs");
  requireNonNegativeSafeInteger(initialDelayMs, "initialDelayMs");
  requireNonNegativeSafeInteger(accessTouchIntervalMs, "accessTouchIntervalMs");
  requireNonNegativeSafeInteger(capacityGraceMs, "capacityGraceMs");
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("now must be a function");
  }

  return {
    maxBytes,
    lowWaterBytes,
    maxIdleMs,
    sweepIntervalMs,
    initialDelayMs,
    accessTouchIntervalMs,
    capacityGraceMs,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

/** Parse only explicit environment overrides; defaults remain owned by the resolver above. */
export function repositoryRetentionOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<RepositoryRetentionOptions> {
  const maxGiB = optionalPositiveDecimal(env[MAX_GIB_ENV], MAX_GIB_ENV);
  const maxAgeDays = optionalPositiveDecimal(env[MAX_AGE_DAYS_ENV], MAX_AGE_DAYS_ENV);
  const maxBytes = maxGiB === undefined ? undefined : decimalUnit(maxGiB, GIB, MAX_GIB_ENV);
  return {
    ...(maxBytes === undefined
      ? {}
      : { maxBytes, lowWaterBytes: Math.floor(maxBytes * DEFAULT_LOW_WATER_RATIO) }),
    ...(maxAgeDays === undefined
      ? {}
      : { maxIdleMs: decimalUnit(maxAgeDays, DAY_MS, MAX_AGE_DAYS_ENV) }),
  };
}

/**
 * Deterministic pure policy: expire old workspaces first, then use LRU eviction to drain from the
 * high watermark to the low watermark. Pinned candidates are reported and skipped, not treated as
 * a global stop condition.
 */
export function selectRetentionCandidates<
  Candidate extends RepositoryRetentionCandidate,
>(
  snapshot: RepositoryRetentionSnapshot<Candidate>,
  policy: RepositoryRetentionOptions,
): RepositoryRetentionSelection<Candidate> {
  const resolvedPolicy = resolveRepositoryRetentionOptions(policy);
  const now = resolvedPolicy.now?.() ?? Date.now();
  const idle = selectIdleRetentionCandidates(snapshot, resolvedPolicy.maxIdleMs, now);
  const selectedIds = new Set(idle.selected.map(({ candidate }) => candidate.id));
  const pressure = idle.projectedBytes > resolvedPolicy.maxBytes;
  const capacity = pressure
    ? selectCapacityRetentionCandidates({
      totalBytes: idle.projectedBytes,
      candidates: snapshot.candidates.filter(({ id }) => !selectedIds.has(id)),
    }, {
      targetBytes: resolvedPolicy.lowWaterBytes,
      minimumAccessAgeMs: resolvedPolicy.capacityGraceMs,
      now,
    })
    : emptyRetentionPass<Candidate>(idle.projectedBytes);
  const deferred = deduplicateDeferrals([...idle.deferred, ...capacity.deferred]);

  return {
    selected: [...idle.selected, ...capacity.selected],
    deferred,
    totalBytes: snapshot.totalBytes,
    selectedBytes: addSafe(idle.selectedBytes, capacity.selectedBytes, "selected candidate sizes"),
    projectedBytes: capacity.projectedBytes,
    pressure,
  };
}

/** Select every unpinned candidate whose persisted access time has exceeded the idle limit. */
export function selectIdleRetentionCandidates<
  Candidate extends RepositoryRetentionCandidate,
>(
  snapshot: RepositoryRetentionSnapshot<Candidate>,
  maxIdleMs: number,
  now: number,
): RepositoryRetentionPass<Candidate> {
  requirePositiveSafeInteger(maxIdleMs, "maxIdleMs");
  requireNonNegativeSafeInteger(now, "now");
  const candidates = validatedCandidates(snapshot);
  return selectRetentionPass(
    snapshot.totalBytes,
    candidates.filter(({ lastAccessMs }) => now - lastAccessMs >= maxIdleMs),
    "max-idle",
    0,
    false,
  );
}

/** Continue an already-triggered capacity pass until the requested target is reached. */
export function selectCapacityRetentionCandidates<
  Candidate extends RepositoryRetentionCandidate,
>(
  snapshot: RepositoryRetentionSnapshot<Candidate>,
  options: CapacityRetentionOptions,
): RepositoryRetentionPass<Candidate> {
  const targetBytes = options.targetBytes;
  requireNonNegativeSafeInteger(targetBytes, "targetBytes");
  const minimumAccessAgeMs = options.minimumAccessAgeMs ?? 0;
  requireNonNegativeSafeInteger(minimumAccessAgeMs, "minimumAccessAgeMs");
  const now = options.now ?? Date.now();
  requireNonNegativeSafeInteger(now, "now");
  const candidates = validatedCandidates(snapshot);
  return selectRetentionPass(
    snapshot.totalBytes,
    candidates,
    "capacity",
    targetBytes,
    true,
    { minimumAccessAgeMs, now },
  );
}

/**
 * Asynchronously sum non-directory inode sizes without traversing symbolic links. A path that
 * disappears during the background walk contributes zero; other I/O errors remain visible.
 */
export async function sizeOfPathNoFollow(path: string, signal?: AbortSignal): Promise<number> {
  const pending = [path];
  let total = 0;
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop()!;
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    throwIfAborted(signal);
    if (!stats.isDirectory()) {
      total = addSafe(total, stats.size, "repository cache size");
      continue;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      // The directory may be concurrently evicted or replaced. Re-lstat every child before use,
      // so a symlink observed in the directory listing is never followed.
      if (isMissingPath(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
      throw error;
    }
    throwIfAborted(signal);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push(join(current, entries[index]!.name));
    }
  }
  return total;
}

/**
 * Cooperatively remove one private quarantine tree without following symbolic links. Partial
 * progress is intentionally safe: a cancelled sweep resumes the same exact quarantine next time.
 */
export async function removePathNoFollow(path: string, signal?: AbortSignal): Promise<number> {
  const pending: Array<{ path: string; childrenVisited: boolean }> = [
    { path, childrenVisited: false },
  ];
  let removedBytes = 0;
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop()!;
    let stats;
    try {
      stats = await lstat(current.path);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    if (!stats.isDirectory()) {
      try {
        await unlink(current.path);
        removedBytes = addSafe(removedBytes, stats.size, "removed repository cache size");
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
      continue;
    }
    if (current.childrenVisited) {
      try {
        await rmdir(current.path);
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
      continue;
    }
    const entries = await readdir(current.path, { withFileTypes: true });
    pending.push({ path: current.path, childrenVisited: true });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push({ path: join(current.path, entries[index]!.name), childrenVisited: false });
    }
  }
  return removedBytes;
}

export interface RepositoryRetentionSchedulerOptions {
  readonly initialDelayMs: number;
  readonly sweepIntervalMs: number;
  readonly sweep: (signal: AbortSignal) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

/** Background-only, non-overlapping retention scheduler. */
export class RepositoryRetentionScheduler {
  readonly #options: RepositoryRetentionSchedulerOptions;
  #controller: AbortController | undefined;
  #timer: NodeJS.Timeout | undefined;
  #active: Promise<void> | undefined;
  #stopped = false;

  constructor(options: RepositoryRetentionSchedulerOptions) {
    requireNonNegativeSafeInteger(options.initialDelayMs, "initialDelayMs");
    requirePositiveSafeInteger(options.sweepIntervalMs, "sweepIntervalMs");
    this.#options = options;
  }

  get started(): boolean {
    return this.#controller !== undefined;
  }

  /** Idempotently schedule the first sweep after the configured initial delay. */
  start(): void {
    if (this.#stopped || this.#controller !== undefined) return;
    this.#controller = new AbortController();
    this.#schedule(this.#options.initialDelayMs);
  }

  /** Trigger a sweep now. Concurrent triggers share the active sweep. */
  trigger(): Promise<void> {
    const controller = this.#controller;
    if (controller === undefined) {
      return Promise.reject(new Error("repository retention scheduler is not started"));
    }
    if (this.#active !== undefined) return this.#active;
    const active = Promise.resolve()
      .then(() => this.#options.sweep(controller.signal))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        try {
          this.#options.onError?.(error);
        } catch {
          // A reporting hook must not terminate future background sweeps.
        }
      })
      .finally(() => {
        if (this.#active === active) this.#active = undefined;
      });
    this.#active = active;
    return active;
  }

  /** Abort the current sweep, cancel future work, and wait for cooperative shutdown. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const controller = this.#controller;
    this.#controller = undefined;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    controller?.abort();
    await this.#active;
  }

  #schedule(delayMs: number): void {
    if (this.#controller === undefined || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.trigger().catch(() => {
        // stop() can win after the timer is queued but before this callback observes the controller.
      }).finally(() => {
        if (this.#controller !== undefined) this.#schedule(this.#options.sweepIntervalMs);
      });
    }, delayMs);
    this.#timer.unref();
  }
}

function compareCandidates(left: RepositoryRetentionCandidate, right: RepositoryRetentionCandidate): number {
  if (left.lastAccessMs !== right.lastAccessMs) return left.lastAccessMs - right.lastAccessMs;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function validatedCandidates<Candidate extends RepositoryRetentionCandidate>(
  snapshot: RepositoryRetentionSnapshot<Candidate>,
): Candidate[] {
  requireNonNegativeSafeInteger(snapshot.totalBytes, "snapshot.totalBytes");
  const seen = new Set<string>();
  const candidates = [...snapshot.candidates];
  for (const candidate of candidates) {
    if (candidate.id.length === 0) throw new TypeError("retention candidate id must not be empty");
    if (seen.has(candidate.id)) throw new TypeError(`duplicate retention candidate id: ${candidate.id}`);
    seen.add(candidate.id);
    requireNonNegativeSafeInteger(candidate.sizeBytes, `candidate ${candidate.id} sizeBytes`);
    requireNonNegativeSafeInteger(candidate.lastAccessMs, `candidate ${candidate.id} lastAccessMs`);
    if (typeof candidate.pinned !== "boolean") {
      throw new TypeError(`candidate ${candidate.id} pinned must be a boolean`);
    }
  }
  candidates.sort(compareCandidates);
  return candidates;
}

function selectRetentionPass<Candidate extends RepositoryRetentionCandidate>(
  totalBytes: number,
  candidates: readonly Candidate[],
  reason: RepositoryRetentionReason,
  targetBytes: number,
  stopAtTarget: boolean,
  protection?: { minimumAccessAgeMs: number; now: number },
): RepositoryRetentionPass<Candidate> {
  const selected: RepositoryRetentionDecision<Candidate>[] = [];
  const deferred: RepositoryRetentionDeferral<Candidate>[] = [];
  let selectedBytes = 0;
  let projectedBytes = totalBytes;
  for (const candidate of candidates) {
    if (stopAtTarget && projectedBytes <= targetBytes) break;
    if (candidate.sizeBytes === 0) continue;
    if (candidate.pinned) {
      deferred.push({ candidate, reason: "pinned", trigger: reason });
      continue;
    }
    if (
      protection !== undefined
      && protection.now - candidate.lastAccessMs < protection.minimumAccessAgeMs
    ) {
      deferred.push({ candidate, reason: "recent", trigger: reason });
      continue;
    }
    selected.push({ candidate, reason });
    selectedBytes = addSafe(selectedBytes, candidate.sizeBytes, "selected candidate sizes");
    projectedBytes = Math.max(0, projectedBytes - candidate.sizeBytes);
  }
  return { selected, deferred, totalBytes, selectedBytes, projectedBytes };
}

function emptyRetentionPass<Candidate extends RepositoryRetentionCandidate>(
  totalBytes: number,
): RepositoryRetentionPass<Candidate> {
  return { selected: [], deferred: [], totalBytes, selectedBytes: 0, projectedBytes: totalBytes };
}

function deduplicateDeferrals<Candidate extends RepositoryRetentionCandidate>(
  deferrals: readonly RepositoryRetentionDeferral<Candidate>[],
): RepositoryRetentionDeferral<Candidate>[] {
  const seen = new Set<string>();
  return deferrals.filter(({ candidate }) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function optionalPositiveDecimal(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    throw new TypeError(`${name} must be a positive decimal number`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be greater than zero`);
  }
  return parsed;
}

function decimalUnit(value: number, unit: number, name: string): number {
  const result = Math.floor(value * unit);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(`${name} is outside the supported range`);
  }
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

function addSafe(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceed the supported range`);
  return result;
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
