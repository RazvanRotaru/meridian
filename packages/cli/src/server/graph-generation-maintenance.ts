/** Per-server ownership for bounded, recurring immutable graph-cache collection. */

import type {
  GraphGenerationGarbageCollector,
  GraphGenerationRootAuthority,
} from "./graph-generation-gc";

const DEFAULT_PUBLICATION_THRESHOLD = 16;
const DEFAULT_MAX_INTERVAL_MS = 10 * 60_000;

export interface GraphGenerationMaintenanceOptions {
  readonly collector: Pick<GraphGenerationGarbageCollector, "collect">;
  readonly roots: GraphGenerationRootAuthority;
  readonly shutdownSignal: AbortSignal;
  readonly publicationThreshold?: number;
  readonly maxIntervalMs?: number;
}

/**
 * Coalesces post-publication and periodic collection requests without global state.
 *
 * One server owns one coordinator. Collection never overlaps itself, work requested during an
 * active pass becomes exactly one successor pass, and close aborts then physically joins the
 * active collector. The timer is only a liveness backstop for services that publish fewer than
 * the threshold; high-throughput services collect by publication count.
 */
export class GraphGenerationMaintenanceCoordinator {
  readonly #collector: GraphGenerationMaintenanceOptions["collector"];
  readonly #roots: GraphGenerationRootAuthority;
  readonly #shutdownSignal: AbortSignal;
  readonly #publicationThreshold: number;
  readonly #maxIntervalMs: number;
  #publications = 0;
  #requested = false;
  #active: Promise<void> | null = null;
  #activeController: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #startPromise: Promise<void> | null = null;
  #lastError: unknown;
  #closePromise: Promise<void> | null = null;

  constructor(options: GraphGenerationMaintenanceOptions) {
    this.#collector = options.collector;
    this.#roots = options.roots;
    this.#shutdownSignal = options.shutdownSignal;
    this.#publicationThreshold = positiveInteger(
      options.publicationThreshold,
      DEFAULT_PUBLICATION_THRESHOLD,
      "graph generation publication threshold",
    );
    this.#maxIntervalMs = positiveInteger(
      options.maxIntervalMs,
      DEFAULT_MAX_INTERVAL_MS,
      "graph generation maintenance interval",
    );
  }

  /** Run and await the mandatory startup reconciliation pass. */
  start(): Promise<void> {
    if (this.#closed) return Promise.reject(coordinatorClosedError());
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.requestNow();
    return this.#startPromise;
  }

  /** Record one immutable generation publication without adding latency to its request. */
  notePublication(): void {
    if (this.#closed) return;
    this.#publications += 1;
    if (this.#publications < this.#publicationThreshold) return;
    this.#publications = 0;
    this.#requested = true;
    this.#ensureWorker();
  }

  /** Request a coalesced pass and resolve after that worker, including one queued successor. */
  requestNow(): Promise<void> {
    if (this.#closed) return Promise.reject(coordinatorClosedError());
    this.#clearTimer();
    this.#requested = true;
    const worker = this.#ensureWorker();
    return this.#awaitRequestedDrain(worker);
  }

  /** Stop admission and the timer, abort the active pass, and join its physical drain. */
  close(reason: unknown = coordinatorClosedError()): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#requested = false;
    this.#clearTimer();
    this.#activeController?.abort(reason);
    return this.#closePromise = this.#finishClose(reason);
  }

  #ensureWorker(): Promise<void> {
    if (this.#active) return this.#active;
    const worker = this.#drain();
    this.#active = worker;
    // Always observe background rejection. Explicit request/start/close callers still receive the
    // original worker promise; this branch only owns state transition and unhandled-rejection safety.
    void worker.then(
      () => {
        this.#lastError = undefined;
        this.#finishWorker(worker);
      },
      (error: unknown) => {
        this.#lastError = error;
        this.#finishWorker(worker);
      },
    );
    return worker;
  }

  async #drain(): Promise<void> {
    while (this.#requested && !this.#closed) {
      this.#requested = false;
      // This pass covers every publication observed before it starts. Publications arriving while
      // collection is active increment from zero and can request one coalesced successor pass.
      this.#publications = 0;
      const controller = new AbortController();
      this.#activeController = controller;
      const signal = AbortSignal.any([controller.signal, this.#shutdownSignal]);
      try {
        await this.#collector.collect(this.#roots, signal);
      } finally {
        if (this.#activeController === controller) this.#activeController = null;
      }
    }
  }

  async #awaitRequestedDrain(worker: Promise<void>): Promise<void> {
    await worker;
    const successor = this.#active;
    if (successor && successor !== worker) await this.#awaitRequestedDrain(successor);
  }

  #finishWorker(worker: Promise<void>): void {
    if (this.#active !== worker) return;
    this.#active = null;
    if (this.#closed) return;
    if (this.#requested) this.#ensureWorker();
    else this.#scheduleTimer();
  }

  async #finishClose(reason: unknown): Promise<void> {
    const active = this.#active;
    if (active) {
      try {
        await active;
      } catch (error) {
        if (!expectedAbort(error, reason, this.#shutdownSignal)) throw error;
      }
    }
    if (this.#lastError !== undefined
      && !expectedAbort(this.#lastError, reason, this.#shutdownSignal)) {
      throw this.#lastError;
    }
  }

  #scheduleTimer(): void {
    if (this.#timer || this.#closed) return;
    const timer = setTimeout(() => {
      if (this.#timer !== timer || this.#closed) return;
      this.#timer = null;
      this.#requested = true;
      this.#ensureWorker();
    }, this.#maxIntervalMs);
    timer.unref?.();
    this.#timer = timer;
  }

  #clearTimer(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function expectedAbort(
  error: unknown,
  closeReason: unknown,
  shutdownSignal: AbortSignal,
): boolean {
  if (error === closeReason || (shutdownSignal.aborted && error === shutdownSignal.reason)) return true;
  return error instanceof Error && error.name === "AbortError";
}

function coordinatorClosedError(): Error {
  return new Error("graph generation maintenance coordinator is closed");
}
