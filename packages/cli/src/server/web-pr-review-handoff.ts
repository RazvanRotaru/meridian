/**
 * Service-owned admission and resource lifetime for prepared progressive PR-review pairs.
 *
 * The graph store and projection cache remain the authorities for their individual artifacts. This
 * registry owns only the composite handoff: one exact pair occupies one bounded admission slot,
 * pins all four resources while claims are live, and releases them together on settlement, expiry,
 * cancellation, or shutdown.
 */

import { randomBytes } from "node:crypto";
import { ServiceShutdownError } from "./service-shutdown";
import type {
  WebGraphRegistrationHandle,
  WebGraphStore,
} from "./web-graph-store";
import type {
  WebGraphProjectCache,
  WebGraphProjectCacheHandle,
} from "./web-graph-project-cache";

const DEFAULT_MAX_ACTIVE_PAIRS = 2;
const DEFAULT_PINNED_BYTE_BUDGET = 1024 * 1024 * 1024;
const DEFAULT_READY_TTL_MS = 30_000;
const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_MAX_CLAIMS_PER_PAIR = 64;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const MAX_SETTLED_CLAIMS = 1_024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface PrReviewHandoffPair {
  readonly key: string;
  readonly headGraphId: string;
  readonly comparisonGraphId: string;
  readonly headProjectionKey: string;
  readonly comparisonProjectionKey: string;
}

export interface PrReviewHandoffProducedPair extends PrReviewHandoffPair {
  /**
   * Optional producer-owned pins which bridge publication to registry acquisition. The registry
   * invokes this exactly once after it has either acquired all four resources or abandoned the
   * result. Implementations must be idempotent so producer-local failure cleanup can share it.
   */
  readonly releasePreparationPins?: () => void;
}

export type PrReviewHandoffProducer = (
  signal: AbortSignal,
) => PrReviewHandoffProducedPair | Promise<PrReviewHandoffProducedPair>;

export interface PrReviewHandoffClaim {
  readonly version: 1;
  readonly claimId: string;
  readonly pair: PrReviewHandoffPair;
  readonly expiresAtMs: number;
  readonly attachedViewLeaseId: string | null;
}

export type PrReviewHandoffClaimSettlement = "committed" | "released";

export interface PrReviewHandoffRegistryOptions {
  /** Distinct preparing or ready pairs. A ready pair retains its slot until every claim settles. */
  readonly maxActivePairs?: number;
  /** Distinct FIFO entries waiting for an active-pair slot. Same-key followers never consume it. */
  readonly maxQueuedPairs?: number;
  /** Hard aggregate byte limit over projection cache handles currently owned by the registry. */
  readonly maxPinnedBytes?: number;
  /** Maximum anonymous lifetime after production completes and before the first claim is issued. */
  readonly readyTtlMs?: number;
  /** Independent lifetime of each issued claim. Issuing a sibling never extends an older claim. */
  readonly claimTtlMs?: number;
  /** Hard timer/capability bound for concurrent consumers of one immutable pair. */
  readonly maxClaimsPerPair?: number;
  readonly now?: () => number;
  /** Cleanup diagnostics; every sibling handle is still released when one release reports an error. */
  readonly onError?: (error: unknown) => void;
}

export interface PrReviewHandoffRegistryStats {
  readonly closed: boolean;
  readonly activePairs: number;
  readonly queuedPairs: number;
  readonly preparingPairs: number;
  readonly readyPairs: number;
  readonly activeClaims: number;
  readonly attachedClaims: number;
  readonly unclaimedEntitlements: number;
  readonly pinnedBytes: number;
  readonly graphHandles: number;
  readonly projectionHandles: number;
}

export type PrReviewHandoffOverloadReason = "queue" | "pinned-bytes" | "claims";

/** A safe, retryable refusal which never supersedes an already admitted pair. */
export class PrReviewHandoffOverloadedError extends Error {
  readonly retryAfterSeconds = DEFAULT_RETRY_AFTER_SECONDS;

  constructor(readonly reason: PrReviewHandoffOverloadReason) {
    super(reason === "pinned-bytes"
      ? "PR review handoff pinned-byte capacity is full; try again shortly"
      : reason === "claims"
        ? "PR review handoff consumer capacity is full; try again shortly"
        : "PR review handoff capacity is full; try again shortly");
    this.name = "PrReviewHandoffOverloadedError";
  }
}

export class PrReviewHandoffRegistryClosedError extends ServiceShutdownError {
  constructor() {
    super("PR review handoff registry is closed");
    this.name = "PrReviewHandoffRegistryClosedError";
  }
}

export class PrReviewHandoffResourceError extends Error {
  constructor(readonly resource: "head-graph" | "comparison-graph" | "head-projection" | "comparison-projection") {
    super(`prepared PR review ${resource} is unavailable`);
    this.name = "PrReviewHandoffResourceError";
  }
}

export class PrReviewHandoffClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrReviewHandoffClaimError";
  }
}

type EntryState = "queued" | "preparing" | "abandoned" | "ready" | "closing";

interface PrepareWaiter {
  active: boolean;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (pair: PrReviewHandoffPair) => void;
  readonly reject: (error: unknown) => void;
}

interface PairResources {
  readonly headGraph: WebGraphRegistrationHandle;
  readonly comparisonGraph: WebGraphRegistrationHandle;
  readonly headProjection: WebGraphProjectCacheHandle;
  readonly comparisonProjection: WebGraphProjectCacheHandle;
  readonly pinnedBytes: number;
}

interface HandoffEntry {
  readonly key: string;
  readonly controller: AbortController;
  readonly producer: PrReviewHandoffProducer;
  readonly waiters: Set<PrepareWaiter>;
  readonly claimIds: Set<string>;
  unclaimedEntitlements: number;
  state: EntryState;
  slotHeld: boolean;
  pair?: PrReviewHandoffPair;
  resources?: PairResources;
  readyTimer?: ReturnType<typeof setTimeout>;
  run?: Promise<void>;
}

interface ClaimState {
  readonly claimId: string;
  readonly entry: HandoffEntry;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  attachedViewLeaseId: string | null;
}

interface SettledClaimState {
  readonly settlement: PrReviewHandoffClaimSettlement;
  readonly attachedViewLeaseId: string | null;
  readonly expiresAtMs: number;
}

/**
 * Pair-level singleflight plus bounded, claim-aware ownership of exact prepared review resources.
 *
 * The active-pair limit intentionally includes ready entries: this is the hard bound which permits
 * projection-cache pins to exceed that cache's soft LRU target without becoming unbounded.
 */
export class PrReviewHandoffRegistry {
  readonly #graphStore: WebGraphStore;
  readonly #projectCache: WebGraphProjectCache;
  readonly #maxActivePairs: number;
  readonly #maxQueuedPairs: number;
  readonly #maxPinnedBytes: number;
  readonly #readyTtlMs: number;
  readonly #claimTtlMs: number;
  readonly #maxClaimsPerPair: number;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #entries = new Map<string, HandoffEntry>();
  readonly #queue: HandoffEntry[] = [];
  readonly #claims = new Map<string, ClaimState>();
  readonly #settledClaims = new Map<string, SettledClaimState>();
  readonly #runs = new Set<Promise<void>>();
  #activePairs = 0;
  #pinnedBytes = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    graphStore: WebGraphStore,
    projectCache: WebGraphProjectCache,
    options: PrReviewHandoffRegistryOptions = {},
  ) {
    this.#graphStore = graphStore;
    this.#projectCache = projectCache;
    this.#maxActivePairs = positiveInteger(
      options.maxActivePairs ?? DEFAULT_MAX_ACTIVE_PAIRS,
      "maxActivePairs",
    );
    this.#maxQueuedPairs = nonNegativeInteger(
      options.maxQueuedPairs ?? this.#maxActivePairs * 2,
      "maxQueuedPairs",
    );
    this.#maxPinnedBytes = positiveSafeInteger(
      options.maxPinnedBytes ?? DEFAULT_PINNED_BYTE_BUDGET,
      "maxPinnedBytes",
    );
    this.#readyTtlMs = positiveTimerInteger(options.readyTtlMs ?? DEFAULT_READY_TTL_MS, "readyTtlMs");
    this.#claimTtlMs = positiveTimerInteger(options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS, "claimTtlMs");
    this.#maxClaimsPerPair = positiveInteger(
      options.maxClaimsPerPair ?? DEFAULT_MAX_CLAIMS_PER_PAIR,
      "maxClaimsPerPair",
    );
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {});
  }

  /**
   * Prepare one exact semantic pair. Equal in-flight keys share the first producer and independent
   * waiters; completed resources remain process-private until explicitly claimed or their TTL ends.
   */
  prepare(
    key: string,
    signal: AbortSignal,
    producer: PrReviewHandoffProducer,
  ): Promise<PrReviewHandoffPair> {
    const exactKey = requireNonEmptyString(key, "handoff key");
    if (this.#closed) return Promise.reject(new PrReviewHandoffRegistryClosedError());
    if (signal.aborted) return Promise.reject(signalAbortReason(signal));
    const existing = this.#entries.get(exactKey);
    if (existing?.state === "ready") {
      this.#recordUnclaimedEntitlement(existing);
      return Promise.resolve(existing.pair!);
    }
    if (existing?.state === "abandoned" || existing?.state === "closing") {
      return Promise.reject(signalAbortReason(existing.controller.signal));
    }

    let entry = existing;
    if (entry === undefined) {
      if (this.#activePairs >= this.#maxActivePairs && this.#queue.length >= this.#maxQueuedPairs) {
        return Promise.reject(new PrReviewHandoffOverloadedError("queue"));
      }
      entry = {
        key: exactKey,
        controller: new AbortController(),
        producer,
        waiters: new Set(),
        claimIds: new Set(),
        unclaimedEntitlements: 0,
        state: "queued",
        slotHeld: false,
      };
      this.#entries.set(exactKey, entry);
      if (this.#activePairs >= this.#maxActivePairs) this.#queue.push(entry);
    }

    const result = this.#attachWaiter(entry, signal);
    if (!entry.slotHeld && entry.state === "queued" && !this.#queue.includes(entry)) {
      this.#admit(entry);
    }
    return result;
  }

  /** Issue one independent, high-entropy capability for an already prepared exact pair. */
  issueClaim(key: string): PrReviewHandoffClaim {
    this.#assertOpen();
    const entry = this.#entries.get(requireNonEmptyString(key, "handoff key"));
    if (entry?.state !== "ready" || entry.pair === undefined || entry.resources === undefined) {
      throw new PrReviewHandoffClaimError("prepared PR review handoff is not ready");
    }
    if (entry.claimIds.size >= this.#maxClaimsPerPair) {
      throw new PrReviewHandoffOverloadedError("claims");
    }
    const claimId = this.#newClaimId();
    const expiresAtMs = safeDeadline(this.#now(), this.#claimTtlMs);
    const timer = setTimeout(() => this.#expireClaim(claimId), this.#claimTtlMs);
    timer.unref?.();
    const claim: ClaimState = {
      claimId,
      entry,
      expiresAtMs,
      attachedViewLeaseId: null,
      timer,
    };
    if (entry.unclaimedEntitlements > 0) entry.unclaimedEntitlements -= 1;
    if (entry.unclaimedEntitlements === 0 && entry.readyTimer !== undefined) {
      clearTimeout(entry.readyTimer);
      entry.readyTimer = undefined;
    }
    entry.claimIds.add(claimId);
    this.#claims.set(claimId, claim);
    return claimDescriptor(claim);
  }

  /** Read one live capability without changing its binding or lifetime. */
  inspectClaim(claimId: string): PrReviewHandoffClaim {
    this.#assertOpen();
    return claimDescriptor(this.#activeClaim(claimId));
  }

  /** Bind a claim to exactly one browser view. A retry for that same lease is idempotent. */
  attach(claimId: string, viewLeaseId: string): PrReviewHandoffClaim {
    this.#assertOpen();
    const claim = this.#activeClaim(claimId);
    const leaseId = requireNonEmptyString(viewLeaseId, "view lease id");
    if (!this.#claimLeaseProtects(claim, leaseId)) {
      throw new PrReviewHandoffClaimError("view lease does not protect the prepared PR review pair");
    }
    if (
      claim.attachedViewLeaseId !== null
      && claim.attachedViewLeaseId !== leaseId
      && this.#claimLeaseProtects(claim, claim.attachedViewLeaseId)
    ) {
      throw new PrReviewHandoffClaimError("PR review handoff claim is already attached to another view");
    }
    // A renderer may recreate an expired graph lease before repeating its idempotent attach. Move
    // the claim only after the old lease has demonstrably stopped protecting the pair.
    claim.attachedViewLeaseId = leaseId;
    return claimDescriptor(claim);
  }

  /** Commit one attached claim. Repeating either settlement operation preserves the first result. */
  commit(claimId: string, viewLeaseId?: string): PrReviewHandoffClaimSettlement {
    const exactId = requireNonEmptyString(claimId, "claim id");
    const expectedLeaseId = viewLeaseId === undefined
      ? undefined
      : requireNonEmptyString(viewLeaseId, "view lease id");
    const settled = this.#settledClaims.get(exactId);
    if (settled !== undefined) {
      if (
        settled.settlement === "committed"
        && expectedLeaseId !== undefined
        && settled.attachedViewLeaseId !== expectedLeaseId
      ) {
        throw new PrReviewHandoffClaimError("committed PR review handoff belongs to another view");
      }
      return settled.settlement;
    }
    const claim = this.#activeClaimOrSettleExpired(exactId);
    if (claim === undefined) return "released";
    if (claim.attachedViewLeaseId === null) {
      throw new PrReviewHandoffClaimError("PR review handoff claim must be attached before commit");
    }
    if (expectedLeaseId !== undefined && claim.attachedViewLeaseId !== expectedLeaseId) {
      throw new PrReviewHandoffClaimError("PR review handoff claim is attached to another view");
    }
    if (!this.#claimLeaseProtects(claim, claim.attachedViewLeaseId)) {
      throw new PrReviewHandoffClaimError("attached view lease no longer protects the prepared pair");
    }
    return this.#settleClaim(claim, "committed");
  }

  /** Release one claim before or after attachment. Repeated release/commit calls are idempotent. */
  release(claimId: string): PrReviewHandoffClaimSettlement {
    const exactId = requireNonEmptyString(claimId, "claim id");
    const settled = this.#settledClaims.get(exactId);
    if (settled !== undefined) return settled.settlement;
    const claim = this.#claims.get(exactId);
    if (claim === undefined) throw new PrReviewHandoffClaimError("unknown PR review handoff claim");
    return this.#settleClaim(claim, "released");
  }

  stats(): PrReviewHandoffRegistryStats {
    let preparingPairs = 0;
    let readyPairs = 0;
    let graphHandles = 0;
    let projectionHandles = 0;
    for (const entry of this.#entries.values()) {
      if (entry.state === "preparing" || entry.state === "abandoned" || entry.state === "closing") {
        preparingPairs += entry.slotHeld ? 1 : 0;
      } else if (entry.state === "ready") {
        readyPairs += 1;
      }
      if (entry.resources !== undefined) {
        graphHandles += 2;
        projectionHandles += 2;
      }
    }
    let attachedClaims = 0;
    for (const claim of this.#claims.values()) {
      if (claim.attachedViewLeaseId !== null) attachedClaims += 1;
    }
    let unclaimedEntitlements = 0;
    for (const entry of this.#entries.values()) {
      unclaimedEntitlements += entry.unclaimedEntitlements;
    }
    return {
      closed: this.#closed,
      activePairs: this.#activePairs,
      queuedPairs: this.#queue.length,
      preparingPairs,
      readyPairs,
      activeClaims: this.#claims.size,
      attachedClaims,
      unclaimedEntitlements,
      pinnedBytes: this.#pinnedBytes,
      graphHandles,
      projectionHandles,
    };
  }

  /** Reject new work, abort/drain producers, and release every owned resource before resolving. */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const error = new PrReviewHandoffRegistryClosedError();

    for (const entry of [...this.#queue]) {
      if (!entry.controller.signal.aborted) entry.controller.abort(error);
      this.#rejectWaiters(entry, error);
      this.#releaseEntry(entry, "released");
    }
    this.#queue.length = 0;
    for (const entry of [...this.#entries.values()]) {
      if (entry.state === "ready") {
        this.#releaseEntry(entry, "released");
        continue;
      }
      if (entry.state === "preparing" || entry.state === "abandoned") {
        entry.state = "closing";
        this.#rejectWaiters(entry, error);
        if (!entry.controller.signal.aborted) entry.controller.abort(error);
      }
    }

    const runs = [...this.#runs];
    this.#closePromise = Promise.allSettled(runs).then(() => {
      for (const entry of [...this.#entries.values()]) this.#releaseEntry(entry, "released");
    });
    return this.#closePromise;
  }

  #attachWaiter(entry: HandoffEntry, signal: AbortSignal): Promise<PrReviewHandoffPair> {
    return new Promise<PrReviewHandoffPair>((resolve, reject) => {
      let waiter!: PrepareWaiter;
      const onAbort = () => this.#abortWaiter(entry, waiter);
      waiter = { active: true, signal, onAbort, resolve, reject };
      entry.waiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  #abortWaiter(entry: HandoffEntry, waiter: PrepareWaiter): void {
    if (!waiter.active) return;
    // A follower may leave immediately while another waiter still owns the producer. The final
    // waiter is different: its promise is the caller's cleanup boundary, so do not reject it until
    // the aborted producer has drained and released every preparation pin. This prevents an outer
    // graph-publication rollback from racing the producer's request-scoped graph handles.
    if (entry.waiters.size === 1 && entry.state === "preparing") {
      entry.state = "abandoned";
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(signalAbortReason(waiter.signal));
      }
      return;
    }
    this.#settleWaiter(entry, waiter, { error: signalAbortReason(waiter.signal) });
    if (entry.waiters.size !== 0) return;
    if (entry.state === "queued") {
      const index = this.#queue.indexOf(entry);
      if (index >= 0) this.#queue.splice(index, 1);
      this.#releaseEntry(entry, "released");
      this.#drain();
    } else if (entry.state === "preparing") {
      entry.state = "abandoned";
      if (!entry.controller.signal.aborted) entry.controller.abort(signalAbortReason(waiter.signal));
    }
  }

  #admit(entry: HandoffEntry): void {
    if (this.#closed || entry.state !== "queued" || entry.waiters.size === 0) return;
    entry.state = "preparing";
    entry.slotHeld = true;
    this.#activePairs += 1;
    const run = Promise.resolve()
      .then(() => entry.producer(entry.controller.signal))
      .then(
        (pair) => this.#producerSucceeded(entry, pair),
        (error: unknown) => this.#producerFailed(entry, error),
      );
    entry.run = run;
    this.#runs.add(run);
    void run.then(
      () => { this.#runs.delete(run); },
      () => { this.#runs.delete(run); },
    );
  }

  #producerSucceeded(entry: HandoffEntry, candidate: PrReviewHandoffProducedPair): void {
    let releasePreparationPins: (() => void) | undefined;
    try {
      releasePreparationPins = validatedPreparationPinRelease(candidate);
      if (entry.state !== "preparing" || entry.controller.signal.aborted || entry.waiters.size === 0) {
        this.#releaseEntry(entry, "released");
        this.#drain();
        return;
      }
      const pair = validatedPair(candidate, entry.key);
      const resources = this.#acquireResources(pair);
      entry.pair = pair;
      entry.resources = resources;
      entry.state = "ready";
      this.#pinnedBytes += resources.pinnedBytes;
      for (const waiter of [...entry.waiters]) {
        this.#recordUnclaimedEntitlement(entry);
        this.#settleWaiter(entry, waiter, { pair });
      }
    } catch (error) {
      this.#producerFailed(entry, error);
    } finally {
      this.#releasePreparationPins(releasePreparationPins);
    }
  }

  #producerFailed(entry: HandoffEntry, error: unknown): void {
    if (entry.state === "closing") {
      this.#releaseEntry(entry, "released");
      return;
    }
    const reason = entry.controller.signal.aborted ? signalAbortReason(entry.controller.signal) : error;
    this.#rejectWaiters(entry, reason);
    this.#releaseEntry(entry, "released");
    this.#drain();
  }

  #acquireResources(pair: PrReviewHandoffPair): PairResources {
    let headGraph: WebGraphRegistrationHandle | undefined;
    let comparisonGraph: WebGraphRegistrationHandle | undefined;
    let headProjection: WebGraphProjectCacheHandle | undefined;
    let comparisonProjection: WebGraphProjectCacheHandle | undefined;
    try {
      headGraph = this.#graphStore.acquire(pair.headGraphId);
      if (headGraph === undefined) throw new PrReviewHandoffResourceError("head-graph");
      comparisonGraph = this.#graphStore.acquire(pair.comparisonGraphId);
      if (comparisonGraph === undefined) throw new PrReviewHandoffResourceError("comparison-graph");
      headProjection = this.#projectCache.acquire(pair.headProjectionKey);
      if (headProjection === undefined) throw new PrReviewHandoffResourceError("head-projection");
      comparisonProjection = this.#projectCache.acquire(pair.comparisonProjectionKey);
      if (comparisonProjection === undefined) throw new PrReviewHandoffResourceError("comparison-projection");
      const pinnedBytes = safeByteSum(headProjection.bytes, comparisonProjection.bytes);
      if (pinnedBytes > this.#maxPinnedBytes - this.#pinnedBytes) {
        throw new PrReviewHandoffOverloadedError("pinned-bytes");
      }
      return { headGraph, comparisonGraph, headProjection, comparisonProjection, pinnedBytes };
    } catch (error) {
      this.#releaseHandles([comparisonProjection, headProjection, comparisonGraph, headGraph]);
      throw error;
    }
  }

  #activeClaim(rawClaimId: string): ClaimState {
    const claimId = requireNonEmptyString(rawClaimId, "claim id");
    const claim = this.#activeClaimOrSettleExpired(claimId);
    if (claim !== undefined) return claim;
    throw new PrReviewHandoffClaimError("PR review handoff claim has expired");
  }

  #activeClaimOrSettleExpired(claimId: string): ClaimState | undefined {
    const claim = this.#claims.get(claimId);
    if (claim === undefined) throw new PrReviewHandoffClaimError("unknown PR review handoff claim");
    if (claim.expiresAtMs > this.#now()) return claim;
    if (this.#renewAttachedClaim(claim)) return claim;
    this.#settleClaim(claim, "released");
    return undefined;
  }

  #settleClaim(
    claim: ClaimState,
    settlement: PrReviewHandoffClaimSettlement,
  ): PrReviewHandoffClaimSettlement {
    if (this.#claims.get(claim.claimId) !== claim) {
      return this.#settledClaims.get(claim.claimId)?.settlement ?? settlement;
    }
    clearTimeout(claim.timer);
    this.#claims.delete(claim.claimId);
    claim.entry.claimIds.delete(claim.claimId);
    this.#rememberSettlement(claim, settlement);
    if (
      claim.entry.state === "ready"
      && claim.entry.claimIds.size === 0
      && claim.entry.unclaimedEntitlements === 0
    ) {
      this.#releaseEntry(claim.entry, settlement);
      this.#drain();
    }
    return settlement;
  }

  #expireClaim(claimId: string): void {
    const claim = this.#claims.get(claimId);
    if (claim === undefined) return;
    const now = this.#now();
    if (claim.expiresAtMs > now) {
      this.#armClaimTimer(claim, claim.expiresAtMs - now);
      return;
    }
    if (this.#renewAttachedClaim(claim)) return;
    this.#settleClaim(claim, "released");
  }

  #renewAttachedClaim(claim: ClaimState): boolean {
    if (
      claim.attachedViewLeaseId === null
      || !this.#claimLeaseProtects(claim, claim.attachedViewLeaseId)
    ) {
      return false;
    }
    claim.expiresAtMs = safeDeadline(this.#now(), this.#claimTtlMs);
    this.#armClaimTimer(claim, this.#claimTtlMs);
    return true;
  }

  #armClaimTimer(claim: ClaimState, delayMs: number): void {
    clearTimeout(claim.timer);
    claim.timer = setTimeout(() => this.#expireClaim(claim.claimId), delayMs);
    claim.timer.unref?.();
  }

  #claimLeaseProtects(claim: ClaimState, leaseId: string): boolean {
    try {
      return this.#graphStore.viewLeaseProtects(leaseId, [
        claim.entry.pair!.headGraphId,
        claim.entry.pair!.comparisonGraphId,
      ]);
    } catch (error) {
      this.#reportError(error);
      return false;
    }
  }

  #releaseEntry(entry: HandoffEntry, claimSettlement: PrReviewHandoffClaimSettlement): void {
    if (entry.readyTimer !== undefined) {
      clearTimeout(entry.readyTimer);
      entry.readyTimer = undefined;
    }
    for (const claimId of [...entry.claimIds]) {
      const claim = this.#claims.get(claimId);
      if (claim !== undefined) {
        clearTimeout(claim.timer);
        this.#claims.delete(claimId);
        this.#rememberSettlement(claim, claimSettlement);
      }
      entry.claimIds.delete(claimId);
    }
    entry.unclaimedEntitlements = 0;
    if (entry.resources !== undefined) {
      const resources = entry.resources;
      entry.resources = undefined;
      this.#pinnedBytes -= resources.pinnedBytes;
      this.#releaseHandles([
        resources.comparisonProjection,
        resources.headProjection,
        resources.comparisonGraph,
        resources.headGraph,
      ]);
    }
    this.#rejectWaiters(entry, signalAbortReason(entry.controller.signal));
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    const queuedIndex = this.#queue.indexOf(entry);
    if (queuedIndex >= 0) this.#queue.splice(queuedIndex, 1);
    if (entry.slotHeld) {
      entry.slotHeld = false;
      this.#activePairs -= 1;
    }
  }

  #releaseHandles(handles: ReadonlyArray<{ release(): void } | undefined>): void {
    for (const handle of handles) {
      if (handle === undefined) continue;
      try {
        handle.release();
      } catch (error) {
        this.#reportError(error);
      }
    }
  }

  #releasePreparationPins(release: (() => void) | undefined): void {
    if (release === undefined) return;
    try {
      release();
    } catch (error) {
      this.#reportError(error);
    }
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Diagnostics must not interrupt registry cleanup.
    }
  }

  #recordUnclaimedEntitlement(entry: HandoffEntry): void {
    if (entry.unclaimedEntitlements < Number.MAX_SAFE_INTEGER) {
      entry.unclaimedEntitlements += 1;
    }
    if (entry.readyTimer !== undefined) clearTimeout(entry.readyTimer);
    entry.readyTimer = setTimeout(() => {
      if (entry.state !== "ready") return;
      entry.unclaimedEntitlements = 0;
      entry.readyTimer = undefined;
      if (entry.claimIds.size === 0) {
        this.#releaseEntry(entry, "released");
        this.#drain();
      }
    }, this.#readyTtlMs);
    entry.readyTimer.unref?.();
  }

  #rejectWaiters(entry: HandoffEntry, error: unknown): void {
    for (const waiter of [...entry.waiters]) this.#settleWaiter(entry, waiter, { error });
  }

  #settleWaiter(
    entry: HandoffEntry,
    waiter: PrepareWaiter,
    outcome: { pair: PrReviewHandoffPair } | { error: unknown },
  ): void {
    if (!waiter.active) return;
    waiter.active = false;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    entry.waiters.delete(waiter);
    if ("pair" in outcome) waiter.resolve(outcome.pair);
    else waiter.reject(outcome.error);
  }

  #drain(): void {
    if (this.#closed) return;
    while (this.#activePairs < this.#maxActivePairs && this.#queue.length > 0) {
      const entry = this.#queue.shift()!;
      if (entry.state !== "queued" || entry.waiters.size === 0) continue;
      this.#admit(entry);
    }
  }

  #newClaimId(): string {
    for (;;) {
      const candidate = randomBytes(24).toString("base64url");
      if (!this.#claims.has(candidate) && !this.#settledClaims.has(candidate)) return candidate;
    }
  }

  #rememberSettlement(claim: ClaimState, settlement: PrReviewHandoffClaimSettlement): void {
    this.#settledClaims.set(claim.claimId, {
      settlement,
      attachedViewLeaseId: claim.attachedViewLeaseId,
      expiresAtMs: claim.expiresAtMs,
    });
    while (this.#settledClaims.size > MAX_SETTLED_CLAIMS) {
      const oldest = this.#settledClaims.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#settledClaims.delete(oldest);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new PrReviewHandoffRegistryClosedError();
  }
}

function validatedPair(value: PrReviewHandoffPair, expectedKey: string): PrReviewHandoffPair {
  if (typeof value !== "object" || value === null) throw new TypeError("PR review handoff producer returned no pair");
  const pair = Object.freeze({
    key: requireNonEmptyString(value.key, "produced handoff key"),
    headGraphId: requireNonEmptyString(value.headGraphId, "head graph id"),
    comparisonGraphId: requireNonEmptyString(value.comparisonGraphId, "comparison graph id"),
    headProjectionKey: requireNonEmptyString(value.headProjectionKey, "head projection key"),
    comparisonProjectionKey: requireNonEmptyString(value.comparisonProjectionKey, "comparison projection key"),
  });
  if (pair.key !== expectedKey) throw new TypeError("PR review handoff producer returned a different key");
  if (pair.headGraphId === pair.comparisonGraphId) {
    throw new TypeError("PR review handoff graph ids must be distinct");
  }
  if (pair.headProjectionKey === pair.comparisonProjectionKey) {
    throw new TypeError("PR review handoff projection keys must be distinct");
  }
  return pair;
}

function validatedPreparationPinRelease(
  value: PrReviewHandoffProducedPair,
): (() => void) | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const release = value.releasePreparationPins;
  if (release !== undefined && typeof release !== "function") {
    throw new TypeError("releasePreparationPins must be a function");
  }
  return release;
}

function claimDescriptor(claim: ClaimState): PrReviewHandoffClaim {
  return Object.freeze({
    version: 1,
    claimId: claim.claimId,
    pair: claim.entry.pair!,
    expiresAtMs: claim.expiresAtMs,
    attachedViewLeaseId: claim.attachedViewLeaseId,
  });
}

function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must not be empty`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return value;
}

function positiveTimerInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`${label} must be a positive timer-safe integer`);
  }
  return value;
}

function safeByteSum(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    throw new RangeError("projection cache handle bytes must be non-negative safe integers");
  }
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new RangeError("projection cache handle byte total is unsafe");
  return total;
}

function safeDeadline(now: number, ttlMs: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("handoff clock must be a non-negative safe integer");
  const deadline = now + ttlMs;
  if (!Number.isSafeInteger(deadline)) throw new RangeError("handoff deadline is unsafe");
  return deadline;
}

function signalAbortReason(signal: AbortSignal): unknown {
  if (signal.aborted && signal.reason !== undefined) return signal.reason;
  const error = new Error("PR review handoff preparation was aborted");
  error.name = "AbortError";
  return error;
}
