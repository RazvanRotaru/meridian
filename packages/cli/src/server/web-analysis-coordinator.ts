/**
 * Process-local coordination for repository preparation and expensive graph analysis.
 *
 * Equal in-flight keys share one job, but jobs themselves start immediately: cache reads and Git
 * preparation must not wait behind CPU-heavy extraction. Callers explicitly enter independent,
 * bounded preparation, process-local coordination, and analysis pools around only the
 * resource-owning phases. Cache probes stay outside those pools, so warm requests are never queued
 * behind cold work.
 */

import { ServiceShutdownError } from "./service-shutdown";

export type AnalysisProgressListener<Progress> = (progress: Progress) => void | Promise<void>;
export type AnalysisWork<Result> = (signal: AbortSignal) => Result | Promise<Result>;
export interface PhaseAdmissionOptions {
  /** Number of memory-accounted worker slots this one phase owns atomically. */
  slots?: number;
}
export type PhaseAdmission = <Result>(
  work: AnalysisWork<Result>,
  options?: PhaseAdmissionOptions,
) => Promise<Result>;
export type PhaseTryAdmissionResult<Result> =
  | { readonly kind: "admitted"; readonly value: Result }
  | { readonly kind: "unavailable" };
export type PhaseTryAdmission = <Result>(
  work: AnalysisWork<Result>,
  options?: PhaseAdmissionOptions,
) => Promise<PhaseTryAdmissionResult<Result>>;
export type CoordinationWork<Result> = (
  signal: AbortSignal,
  tryRunAnalysis: PhaseTryAdmission,
) => Result | Promise<Result>;
/** Bounded process-local admission for waiting on an external coordination resource. */
export type CoordinationAdmission = <Result>(
  work: CoordinationWork<Result>,
) => Promise<Result>;

export interface AnalysisWaiterOptions<Progress> {
  signal?: AbortSignal;
  onProgress?: AnalysisProgressListener<Progress>;
}

export interface AnalysisJobContext<Progress> {
  /** Immutable process-local worker capacity resolved from the server memory policy. */
  readonly analysisCapacity: number;
  readonly signal: AbortSignal;
  /**
   * Retain one latest value per optional replay key for waiters joining concurrent progress lanes.
   * Omitting the key preserves the historical single-latest-value behavior.
   */
  report(progress: Progress, replayKey?: string): void;
  runPreparation<Result>(work: AnalysisWork<Result>): Promise<Result>;
  /**
   * Enter the bounded FIFO for an external coordination wait without owning an analysis slot.
   * Its callback may probe `tryRunAnalysis`, but blocking analysis admission is forbidden while
   * this admission is held.
   */
  runCoordination<Result>(work: CoordinationWork<Result>): Promise<Result>;
  runAnalysis<Result>(
    work: AnalysisWork<Result>,
    options?: PhaseAdmissionOptions,
  ): Promise<Result>;
  /** Acquire analysis capacity only when all requested slots are immediately available. */
  tryRunAnalysis<Result>(
    work: AnalysisWork<Result>,
    options?: PhaseAdmissionOptions,
  ): Promise<PhaseTryAdmissionResult<Result>>;
}

export interface AnalysisCoordinatorOptions {
  maxConcurrentAnalyses: number;
  maxConcurrentPreparations?: number;
  maxQueuedAnalyses?: number;
  maxQueuedCoordinations?: number;
  maxQueuedPreparations?: number;
}

export type AnalysisAdmissionPhase = "preparation" | "coordination" | "analysis";

const DEFAULT_MAX_CONCURRENT_PREPARATIONS = 2;
const DEFAULT_PROGRESS_REPLAY_KEY = "";

export class AnalysisCoordinatorClosedError extends ServiceShutdownError {
  constructor() {
    super("analysis coordinator is closed");
    this.name = "AnalysisCoordinatorClosedError";
  }
}

export class AnalysisCoordinatorAbortError extends Error {
  constructor(message = "analysis request was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/** A safe, retryable refusal raised before work enters a full bounded queue. */
export class AnalysisCoordinatorOverloadedError extends Error {
  readonly phase: AnalysisAdmissionPhase;

  constructor(phase: AnalysisAdmissionPhase) {
    super(`repository ${phase} capacity is full; try again shortly`);
    this.name = "AnalysisCoordinatorOverloadedError";
    this.phase = phase;
  }
}

type CoordinatedWork<Result, Progress> = (context: AnalysisJobContext<Progress>) => Result | Promise<Result>;

interface Waiter<Result, Progress> {
  active: boolean;
  entry: JobEntry<Result, Progress>;
  onProgress?: AnalysisProgressListener<Progress>;
  progressTail: Promise<void>;
  reject(error: unknown): void;
  resolve(result: Result): void;
  signal?: AbortSignal;
  signalListener?: () => void;
}

type JobState = "running" | "abandoned" | "settled";

interface JobEntry<Result, Progress> {
  activeCoordination?: boolean;
  activePhase?: AnalysisAdmissionPhase;
  coordinationScope?: object;
  controller: AbortController;
  done: Promise<void>;
  key: string;
  latestProgress: Map<string, Progress>;
  resolveDone(): void;
  state: JobState;
  waiters: Set<Waiter<Result, Progress>>;
}

type AdmissionTaskState = "queued" | "running" | "settled";

interface AdmissionTask<Result> {
  controller: AbortController;
  reject(error: unknown): void;
  resolve(result: Result): void;
  slots: number;
  sourceListener: () => void;
  sourceSignal: AbortSignal;
  state: AdmissionTaskState;
  work?: AnalysisWork<Result>;
}

/** FIFO admission for one explicitly marked resource-owning phase of a coordinated job. */
class BoundedAdmission {
  readonly #limit: number;
  readonly #maxQueued: number;
  readonly #phase: AnalysisAdmissionPhase;
  readonly #queue: Array<AdmissionTask<unknown>> = [];
  readonly #running = new Set<AdmissionTask<unknown>>();
  #runningSlots = 0;
  #closedReason: AnalysisCoordinatorClosedError | undefined;
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;

  constructor(phase: AnalysisAdmissionPhase, limit: number, maxQueued: number) {
    this.#phase = phase;
    this.#limit = limit;
    this.#maxQueued = maxQueued;
  }

  get capacity(): number {
    return this.#limit;
  }

  run<Result>(
    sourceSignal: AbortSignal,
    work: AnalysisWork<Result>,
    slots = 1,
  ): Promise<Result> {
    requirePositiveInteger(slots, `${this.#phase} slots`);
    if (slots > this.#limit) {
      return Promise.reject(new RangeError(
        `${this.#phase} slots cannot exceed the configured capacity of ${this.#limit}`,
      ));
    }
    if (this.#closedReason) {
      return Promise.reject(this.#closedReason);
    }
    if (sourceSignal.aborted) {
      return Promise.reject(signalAbortReason(sourceSignal));
    }
    const mustQueue = this.#queue.length > 0 || this.#runningSlots + slots > this.#limit;
    if (mustQueue && this.#queue.length >= this.#maxQueued) {
      return Promise.reject(new AnalysisCoordinatorOverloadedError(this.#phase));
    }

    return new Promise<Result>((resolve, reject) => {
      const controller = new AbortController();
      const task: AdmissionTask<Result> = {
        controller,
        reject,
        resolve,
        slots,
        sourceListener: () => {
          const reason = signalAbortReason(sourceSignal);
          if (!controller.signal.aborted) {
            controller.abort(reason);
          }
          if (task.state === "queued") {
            this.#cancelQueued(task, reason);
          }
        },
        sourceSignal,
        state: "queued",
        work,
      };
      sourceSignal.addEventListener("abort", task.sourceListener, { once: true });
      this.#queue.push(task as AdmissionTask<unknown>);
      this.#drain();
    });
  }

  tryRun<Result>(
    sourceSignal: AbortSignal,
    work: AnalysisWork<Result>,
    slots = 1,
  ): Promise<PhaseTryAdmissionResult<Result>> {
    requirePositiveInteger(slots, `${this.#phase} slots`);
    if (slots > this.#limit) {
      return Promise.reject(new RangeError(
        `${this.#phase} slots cannot exceed the configured capacity of ${this.#limit}`,
      ));
    }
    if (this.#closedReason) return Promise.reject(this.#closedReason);
    if (sourceSignal.aborted) return Promise.reject(signalAbortReason(sourceSignal));
    if (this.#queue.length > 0 || this.#runningSlots + slots > this.#limit) {
      return Promise.resolve({ kind: "unavailable" });
    }
    return this.run(sourceSignal, work, slots).then((value) => ({ kind: "admitted", value }));
  }

  close(reason: AnalysisCoordinatorClosedError): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#closedReason = reason;
    this.#closePromise = new Promise<void>((resolve) => {
      this.#resolveClose = resolve;
    });

    for (const task of [...this.#queue]) {
      if (!task.controller.signal.aborted) {
        task.controller.abort(reason);
      }
      this.#cancelQueued(task, reason);
    }
    for (const task of this.#running) {
      if (!task.controller.signal.aborted) {
        task.controller.abort(reason);
      }
    }
    this.#resolveCloseIfDrained();
    return this.#closePromise;
  }

  #cancelQueued<Result>(task: AdmissionTask<Result>, error: unknown): void {
    if (task.state !== "queued") {
      return;
    }
    task.state = "settled";
    task.work = undefined;
    const index = this.#queue.indexOf(task as AdmissionTask<unknown>);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
    removeAdmissionSourceListener(task);
    task.reject(error);
    this.#drain();
  }

  #drain(): void {
    if (this.#closedReason) {
      return;
    }
    while (this.#queue.length > 0) {
      const task = this.#queue[0]!;
      if (task.state !== "queued") {
        this.#queue.shift();
        continue;
      }
      if (task.controller.signal.aborted) {
        this.#cancelQueued(task, signalAbortReason(task.controller.signal));
        continue;
      }
      // Strict FIFO avoids starving a two-slot PR pair behind a stream of one-slot jobs.
      if (this.#runningSlots + task.slots > this.#limit) {
        return;
      }
      this.#queue.shift();
      this.#start(task);
    }
  }

  #start(task: AdmissionTask<unknown>): void {
    const work = task.work;
    if (!work) {
      throw new Error(`queued ${this.#phase} has no work factory`);
    }
    task.work = undefined;
    task.state = "running";
    this.#running.add(task);
    this.#runningSlots += task.slots;

    void Promise.resolve()
      .then(() => {
        if (task.controller.signal.aborted) {
          throw signalAbortReason(task.controller.signal);
        }
        return work(task.controller.signal);
      })
      .then(
        // A last-waiter abort wins even when non-cooperative work resolves. Resource-owning callers
        // therefore register cleanup handles as soon as admitted work allocates them.
        (result) => this.#settle(task, task.controller.signal.aborted
          ? { error: signalAbortReason(task.controller.signal) }
          : { result }),
        (error: unknown) => this.#settle(task, {
          error: task.controller.signal.aborted ? signalAbortReason(task.controller.signal) : error,
        }),
      );
  }

  #settle<Result>(
    task: AdmissionTask<Result>,
    outcome: { result: Result } | { error: unknown },
  ): void {
    if (task.state !== "running") {
      return;
    }
    task.state = "settled";
    this.#running.delete(task as AdmissionTask<unknown>);
    this.#runningSlots -= task.slots;
    removeAdmissionSourceListener(task);
    if ("error" in outcome) {
      task.reject(outcome.error);
    } else {
      task.resolve(outcome.result);
    }
    this.#drain();
    this.#resolveCloseIfDrained();
  }

  #resolveCloseIfDrained(): void {
    if (this.#closedReason && this.#running.size === 0) {
      this.#resolveClose?.();
      this.#resolveClose = undefined;
    }
  }
}

/**
 * Waiter-aware keyed singleflight with independent bounded preparation and analysis pools.
 *
 * A key is a caller-owned semantic identity: callers that reuse it promise that the first work
 * factory is valid for every joined waiter. Completed results are never cached here; after a job
 * settles, the next call for the same key starts new work (normally after the durable cache check).
 */
export class AnalysisCoordinator {
  readonly #analysisAdmission: BoundedAdmission;
  readonly #coordinationAdmission: BoundedAdmission;
  readonly #preparationAdmission: BoundedAdmission;
  readonly #jobs = new Map<string, JobEntry<unknown, unknown>>();
  readonly #activeJobs = new Set<JobEntry<unknown, unknown>>();
  readonly #activeWaiters = new Set<Waiter<unknown, unknown>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: AnalysisCoordinatorOptions) {
    const maxConcurrentPreparations = options.maxConcurrentPreparations
      ?? DEFAULT_MAX_CONCURRENT_PREPARATIONS;
    const maxQueuedAnalyses = options.maxQueuedAnalyses ?? options.maxConcurrentAnalyses * 2;
    const maxQueuedCoordinations = options.maxQueuedCoordinations ?? maxQueuedAnalyses;
    const maxQueuedPreparations = options.maxQueuedPreparations ?? maxConcurrentPreparations * 2;
    requirePositiveInteger(options.maxConcurrentAnalyses, "maxConcurrentAnalyses");
    requirePositiveInteger(maxConcurrentPreparations, "maxConcurrentPreparations");
    requireNonNegativeInteger(maxQueuedAnalyses, "maxQueuedAnalyses");
    requireNonNegativeInteger(maxQueuedCoordinations, "maxQueuedCoordinations");
    requireNonNegativeInteger(maxQueuedPreparations, "maxQueuedPreparations");
    this.#analysisAdmission = new BoundedAdmission(
      "analysis",
      options.maxConcurrentAnalyses,
      maxQueuedAnalyses,
    );
    this.#coordinationAdmission = new BoundedAdmission(
      "coordination",
      1,
      maxQueuedCoordinations,
    );
    this.#preparationAdmission = new BoundedAdmission(
      "preparation",
      maxConcurrentPreparations,
      maxQueuedPreparations,
    );
  }

  run<Result, Progress = never>(
    key: string,
    work: CoordinatedWork<Result, Progress>,
    options: AnalysisWaiterOptions<Progress> = {},
  ): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new AnalysisCoordinatorClosedError());
    }
    if (options.signal?.aborted) {
      return Promise.reject(signalAbortReason(options.signal));
    }

    let entry = this.#jobs.get(key) as JobEntry<Result, Progress> | undefined;
    const created = entry === undefined;
    if (!entry) {
      entry = createJobEntry(key);
      this.#jobs.set(key, entry as JobEntry<unknown, unknown>);
    }

    const result = this.#attachWaiter(entry, options);
    if (created) {
      this.#start(entry, work);
    }
    return result;
  }

  /**
   * Stop new jobs and all admissions, reject every waiter, abort active work, and wait for every
   * coordinated job and admitted phase to settle. Repeated calls return the same promise.
   */
  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closed = true;
    let resolveClose: (() => void) | undefined;
    this.#closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const error = new AnalysisCoordinatorClosedError();
    const jobSettlements = [...this.#activeJobs].map((entry) => entry.done);
    const admissionSettlements = [
      this.#preparationAdmission.close(error),
      this.#coordinationAdmission.close(error),
      this.#analysisAdmission.close(error),
    ];

    // A job may already have settled while an asynchronous progress callback is still draining.
    // Track waiters independently so close also prevents that request from publishing afterwards.
    for (const waiter of [...this.#activeWaiters]) {
      this.#rejectWaiter(waiter.entry, waiter, error, error);
    }
    for (const entry of this.#activeJobs) {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(error);
      }
    }

    void Promise.allSettled([...jobSettlements, ...admissionSettlements]).then(() => resolveClose?.());
    return this.#closePromise;
  }

  #attachWaiter<Result, Progress>(
    entry: JobEntry<Result, Progress>,
    options: AnalysisWaiterOptions<Progress>,
  ): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      const waiter: Waiter<Result, Progress> = {
        active: true,
        entry,
        onProgress: options.onProgress,
        progressTail: Promise.resolve(),
        reject,
        resolve,
        signal: options.signal,
      };
      if (options.signal) {
        waiter.signalListener = () => this.#rejectWaiter(entry, waiter, signalAbortReason(options.signal!));
        options.signal.addEventListener("abort", waiter.signalListener, { once: true });
      }
      entry.waiters.add(waiter);
      this.#activeWaiters.add(waiter as Waiter<unknown, unknown>);
      for (const progress of entry.latestProgress.values()) {
        this.#deliverProgress(entry, waiter, progress);
      }
    });
  }

  #deliverProgress<Result, Progress>(
    entry: JobEntry<Result, Progress>,
    waiter: Waiter<Result, Progress>,
    progress: Progress,
  ): void {
    if (!waiter.active || !waiter.onProgress) {
      return;
    }
    waiter.progressTail = waiter.progressTail.then(async () => {
      if (!waiter.active) {
        return;
      }
      try {
        await waiter.onProgress?.(progress);
      } catch (error) {
        this.#rejectWaiter(entry, waiter, error);
      }
    });
  }

  #report<Result, Progress>(
    entry: JobEntry<Result, Progress>,
    progress: Progress,
    replayKey = DEFAULT_PROGRESS_REPLAY_KEY,
  ): void {
    if (entry.state !== "running" || entry.waiters.size === 0) {
      return;
    }
    // Map iteration is the replay order. Move an updated lane to the end so a late waiter finishes
    // on the globally newest observation instead of an older sibling lane.
    entry.latestProgress.delete(replayKey);
    entry.latestProgress.set(replayKey, progress);
    for (const waiter of [...entry.waiters]) {
      this.#deliverProgress(entry, waiter, progress);
    }
  }

  #rejectWaiter<Result, Progress>(
    entry: JobEntry<Result, Progress>,
    waiter: Waiter<Result, Progress>,
    error: unknown,
    jobAbortReason?: Error,
  ): void {
    if (!waiter.active) {
      return;
    }
    waiter.active = false;
    removeSignalListener(waiter);
    entry.waiters.delete(waiter);
    this.#activeWaiters.delete(waiter as Waiter<unknown, unknown>);
    waiter.reject(error);

    if (entry.waiters.size === 0 && entry.state === "running") {
      this.#abandon(entry, jobAbortReason);
    }
  }

  #abandon<Result, Progress>(entry: JobEntry<Result, Progress>, abortReason?: Error): void {
    if (this.#jobs.get(entry.key) === entry) {
      this.#jobs.delete(entry.key);
    }
    entry.state = "abandoned";
    entry.latestProgress.clear();
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(
        abortReason ?? new AnalysisCoordinatorAbortError("coordinated job has no remaining waiters"),
      );
    }
  }

  #start<Result, Progress>(
    entry: JobEntry<Result, Progress>,
    work: CoordinatedWork<Result, Progress>,
  ): void {
    this.#activeJobs.add(entry as JobEntry<unknown, unknown>);
    const context: AnalysisJobContext<Progress> = {
      analysisCapacity: this.#analysisAdmission.capacity,
      signal: entry.controller.signal,
      report: (progress, replayKey) => this.#report(entry, progress, replayKey),
      runPreparation: (preparation) => this.#runPhase(entry, "preparation", preparation),
      runCoordination: (coordination) => this.#runCoordination(entry, coordination),
      runAnalysis: (analysis, options) => this.#runPhase(
        entry,
        "analysis",
        analysis,
        options?.slots,
      ),
      tryRunAnalysis: (analysis, options) => this.#tryRunPhase(
        entry,
        "analysis",
        analysis,
        options?.slots,
      ),
    };

    void Promise.resolve()
      .then(() => {
        if (entry.controller.signal.aborted) {
          throw signalAbortReason(entry.controller.signal);
        }
        return work(context);
      })
      .then(
        (result) => this.#settle(entry, { result }),
        (error: unknown) => this.#settle(entry, { error }),
      );
  }

  #runPhase<Result, Progress>(
    entry: JobEntry<unknown, Progress>,
    phase: AnalysisAdmissionPhase,
    work: AnalysisWork<Result>,
    slots = 1,
  ): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new AnalysisCoordinatorClosedError());
    }
    if (entry.controller.signal.aborted) {
      return Promise.reject(signalAbortReason(entry.controller.signal));
    }
    if (entry.state !== "running") {
      return Promise.reject(new AnalysisCoordinatorAbortError("coordinated job is no longer active"));
    }
    if (entry.activePhase || entry.activeCoordination) {
      return Promise.reject(new Error("one coordinated job cannot run overlapping admitted phases"));
    }
    entry.activePhase = phase;
    const admission = phase === "preparation" ? this.#preparationAdmission : this.#analysisAdmission;
    try {
      return admission.run(entry.controller.signal, work, slots).finally(() => {
        entry.activePhase = undefined;
      });
    } catch (error) {
      entry.activePhase = undefined;
      return Promise.reject(error);
    }
  }

  #runCoordination<Result, Progress>(
    entry: JobEntry<unknown, Progress>,
    work: CoordinationWork<Result>,
  ): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new AnalysisCoordinatorClosedError());
    }
    if (entry.controller.signal.aborted) {
      return Promise.reject(signalAbortReason(entry.controller.signal));
    }
    if (entry.state !== "running") {
      return Promise.reject(new AnalysisCoordinatorAbortError("coordinated job is no longer active"));
    }
    if (entry.activePhase || entry.activeCoordination) {
      return Promise.reject(new Error("one coordinated job cannot run overlapping admitted phases"));
    }
    entry.activeCoordination = true;
    let admitted: Promise<Result>;
    try {
      admitted = this.#coordinationAdmission.run(
        entry.controller.signal,
        async (coordinationSignal) => {
          const scope = {};
          entry.coordinationScope = scope;
          try {
            return await work(
              coordinationSignal,
              (analysis, options) => this.#tryRunPhase(
                entry,
                "analysis",
                analysis,
                options?.slots,
                scope,
              ),
            );
          } finally {
            if (entry.coordinationScope === scope) entry.coordinationScope = undefined;
          }
        },
      );
    } catch (error) {
      entry.activeCoordination = undefined;
      return Promise.reject(error);
    }
    return admitted.finally(() => {
      entry.activeCoordination = undefined;
    });
  }

  #tryRunPhase<Result, Progress>(
    entry: JobEntry<unknown, Progress>,
    phase: AnalysisAdmissionPhase,
    work: AnalysisWork<Result>,
    slots = 1,
    coordinationScope?: object,
  ): Promise<PhaseTryAdmissionResult<Result>> {
    if (this.#closed) {
      return Promise.reject(new AnalysisCoordinatorClosedError());
    }
    if (entry.controller.signal.aborted) {
      return Promise.reject(signalAbortReason(entry.controller.signal));
    }
    if (entry.state !== "running") {
      return Promise.reject(new AnalysisCoordinatorAbortError("coordinated job is no longer active"));
    }
    // Only the scoped capability supplied to the currently executing coordination callback may
    // make this non-blocking probe while it owns an external fence. The ordinary context method,
    // leaked/expired capabilities, and `#runPhase` all reject in the same state.
    const scopedCoordination = coordinationScope !== undefined
      && entry.coordinationScope === coordinationScope;
    if (
      entry.activePhase
      || (entry.activeCoordination && !scopedCoordination)
      || (coordinationScope !== undefined && !scopedCoordination)
    ) {
      return Promise.reject(new Error("one coordinated job cannot run overlapping admitted phases"));
    }
    entry.activePhase = phase;
    const admission = phase === "preparation" ? this.#preparationAdmission : this.#analysisAdmission;
    try {
      return admission.tryRun(entry.controller.signal, work, slots).finally(() => {
        entry.activePhase = undefined;
      });
    } catch (error) {
      entry.activePhase = undefined;
      return Promise.reject(error);
    }
  }

  #settle<Result, Progress>(
    entry: JobEntry<Result, Progress>,
    outcome: { result: Result } | { error: unknown },
  ): void {
    if (entry.state !== "running" && entry.state !== "abandoned") {
      return;
    }
    entry.state = "settled";
    if (this.#jobs.get(entry.key) === entry) {
      this.#jobs.delete(entry.key);
    }
    this.#activeJobs.delete(entry as JobEntry<unknown, unknown>);
    entry.latestProgress.clear();

    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const waiter of waiters) {
      this.#completeWaiter(waiter, outcome);
    }
    entry.resolveDone();
  }

  #completeWaiter<Result, Progress>(
    waiter: Waiter<Result, Progress>,
    outcome: { result: Result } | { error: unknown },
  ): void {
    void waiter.progressTail.then(() => {
      if (!waiter.active) {
        return;
      }
      waiter.active = false;
      removeSignalListener(waiter);
      this.#activeWaiters.delete(waiter as Waiter<unknown, unknown>);
      if ("error" in outcome) {
        waiter.reject(outcome.error);
      } else {
        waiter.resolve(outcome.result);
      }
    });
  }
}

function createJobEntry<Result, Progress>(key: string): JobEntry<Result, Progress> {
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    controller: new AbortController(),
    done,
    key,
    latestProgress: new Map(),
    resolveDone: () => resolveDone?.(),
    state: "running",
    waiters: new Set(),
  };
}

function removeAdmissionSourceListener<Result>(task: AdmissionTask<Result>): void {
  task.sourceSignal.removeEventListener("abort", task.sourceListener);
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
}

function removeSignalListener<Result, Progress>(waiter: Waiter<Result, Progress>): void {
  if (waiter.signal && waiter.signalListener) {
    waiter.signal.removeEventListener("abort", waiter.signalListener);
    waiter.signalListener = undefined;
  }
}

function signalAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AnalysisCoordinatorAbortError();
}
