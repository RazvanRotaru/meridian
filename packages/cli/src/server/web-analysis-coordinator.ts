/**
 * Process-local coordination for repository preparation and expensive graph analysis.
 *
 * Equal in-flight keys share one job, but jobs themselves start immediately: cache reads and Git
 * preparation must not wait behind CPU-heavy extraction. Callers explicitly enter the bounded
 * heavy-analysis pool through `context.runAnalysis` only around the memory-intensive phase.
 */

export type AnalysisProgressListener<Progress> = (progress: Progress) => void | Promise<void>;
export type AnalysisWork<Result> = (signal: AbortSignal) => Result | Promise<Result>;

export interface AnalysisWaiterOptions<Progress> {
  signal?: AbortSignal;
  onProgress?: AnalysisProgressListener<Progress>;
}

export interface AnalysisJobContext<Progress> {
  readonly signal: AbortSignal;
  report(progress: Progress): void;
  runAnalysis<Result>(work: AnalysisWork<Result>): Promise<Result>;
}

export interface AnalysisCoordinatorOptions {
  maxConcurrentAnalyses: number;
}

export class AnalysisCoordinatorClosedError extends Error {
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
  analysisActive: boolean;
  controller: AbortController;
  done: Promise<void>;
  hasLatestProgress: boolean;
  key: string;
  latestProgress?: Progress;
  resolveDone(): void;
  state: JobState;
  waiters: Set<Waiter<Result, Progress>>;
}

type AnalysisTaskState = "queued" | "running" | "settled";

interface AnalysisTask<Result> {
  controller: AbortController;
  reject(error: unknown): void;
  resolve(result: Result): void;
  sourceListener: () => void;
  sourceSignal: AbortSignal;
  state: AnalysisTaskState;
  work?: AnalysisWork<Result>;
}

/** FIFO admission for only the explicitly marked heavy section of a coordinated job. */
class AnalysisAdmission {
  readonly #limit: number;
  readonly #queue: Array<AnalysisTask<unknown>> = [];
  readonly #running = new Set<AnalysisTask<unknown>>();
  #closedReason: AnalysisCoordinatorClosedError | undefined;
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;

  constructor(limit: number) {
    this.#limit = limit;
  }

  run<Result>(sourceSignal: AbortSignal, work: AnalysisWork<Result>): Promise<Result> {
    if (this.#closedReason) {
      return Promise.reject(this.#closedReason);
    }
    if (sourceSignal.aborted) {
      return Promise.reject(signalAbortReason(sourceSignal));
    }

    return new Promise<Result>((resolve, reject) => {
      const controller = new AbortController();
      const task: AnalysisTask<Result> = {
        controller,
        reject,
        resolve,
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
      this.#queue.push(task as AnalysisTask<unknown>);
      this.#drain();
    });
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

  #cancelQueued<Result>(task: AnalysisTask<Result>, error: unknown): void {
    if (task.state !== "queued") {
      return;
    }
    task.state = "settled";
    task.work = undefined;
    const index = this.#queue.indexOf(task as AnalysisTask<unknown>);
    if (index >= 0) {
      this.#queue.splice(index, 1);
    }
    removeAnalysisSourceListener(task);
    task.reject(error);
    this.#drain();
  }

  #drain(): void {
    if (this.#closedReason) {
      return;
    }
    while (this.#running.size < this.#limit && this.#queue.length > 0) {
      const task = this.#queue.shift()!;
      if (task.state !== "queued") {
        continue;
      }
      if (task.controller.signal.aborted) {
        this.#cancelQueued(task, signalAbortReason(task.controller.signal));
        continue;
      }
      this.#start(task);
    }
  }

  #start(task: AnalysisTask<unknown>): void {
    const work = task.work;
    if (!work) {
      throw new Error("queued analysis has no work factory");
    }
    task.work = undefined;
    task.state = "running";
    this.#running.add(task);

    void Promise.resolve()
      .then(() => {
        if (task.controller.signal.aborted) {
          throw signalAbortReason(task.controller.signal);
        }
        return work(task.controller.signal);
      })
      .then(
        (result) => this.#settle(task, task.controller.signal.aborted
          ? { error: signalAbortReason(task.controller.signal) }
          : { result }),
        (error: unknown) => this.#settle(task, {
          error: task.controller.signal.aborted ? signalAbortReason(task.controller.signal) : error,
        }),
      );
  }

  #settle<Result>(
    task: AnalysisTask<Result>,
    outcome: { result: Result } | { error: unknown },
  ): void {
    if (task.state !== "running") {
      return;
    }
    task.state = "settled";
    this.#running.delete(task as AnalysisTask<unknown>);
    removeAnalysisSourceListener(task);
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
 * Waiter-aware keyed singleflight with a distinct, bounded heavy-analysis admission pool.
 *
 * A key is a caller-owned semantic identity: callers that reuse it promise that the first work
 * factory is valid for every joined waiter. Completed results are never cached here; after a job
 * settles, the next call for the same key starts new work (normally after the durable cache check).
 */
export class AnalysisCoordinator {
  readonly #admission: AnalysisAdmission;
  readonly #jobs = new Map<string, JobEntry<unknown, unknown>>();
  readonly #activeJobs = new Set<JobEntry<unknown, unknown>>();
  readonly #activeWaiters = new Set<Waiter<unknown, unknown>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: AnalysisCoordinatorOptions) {
    const { maxConcurrentAnalyses } = options;
    if (!Number.isInteger(maxConcurrentAnalyses) || maxConcurrentAnalyses < 1) {
      throw new RangeError("maxConcurrentAnalyses must be a positive integer");
    }
    this.#admission = new AnalysisAdmission(maxConcurrentAnalyses);
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
   * Stop new jobs and analysis admission, reject every waiter, abort active work, and wait for both
   * coordinated jobs and heavy-analysis workers to settle. Repeated calls return the same promise.
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
    const admissionSettlement = this.#admission.close(error);

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

    void Promise.allSettled([...jobSettlements, admissionSettlement]).then(() => resolveClose?.());
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
      if (entry.hasLatestProgress) {
        this.#deliverProgress(entry, waiter, entry.latestProgress as Progress);
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

  #report<Result, Progress>(entry: JobEntry<Result, Progress>, progress: Progress): void {
    if (entry.state !== "running" || entry.waiters.size === 0) {
      return;
    }
    entry.hasLatestProgress = true;
    entry.latestProgress = progress;
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
    entry.hasLatestProgress = false;
    entry.latestProgress = undefined;
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(
        abortReason ?? new AnalysisCoordinatorAbortError("analysis job has no remaining waiters"),
      );
    }
  }

  #start<Result, Progress>(
    entry: JobEntry<Result, Progress>,
    work: CoordinatedWork<Result, Progress>,
  ): void {
    this.#activeJobs.add(entry as JobEntry<unknown, unknown>);
    const context: AnalysisJobContext<Progress> = {
      signal: entry.controller.signal,
      report: (progress) => this.#report(entry, progress),
      runAnalysis: (analysis) => {
        if (this.#closed) {
          return Promise.reject(new AnalysisCoordinatorClosedError());
        }
        if (entry.controller.signal.aborted) {
          return Promise.reject(signalAbortReason(entry.controller.signal));
        }
        if (entry.state !== "running") {
          return Promise.reject(new AnalysisCoordinatorAbortError("analysis job is no longer active"));
        }
        if (entry.analysisActive) {
          return Promise.reject(new Error("one coordinated job cannot run overlapping analysis phases"));
        }
        entry.analysisActive = true;
        return this.#admission.run(entry.controller.signal, analysis).finally(() => {
          entry.analysisActive = false;
        });
      },
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
    entry.hasLatestProgress = false;
    entry.latestProgress = undefined;

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
    analysisActive: false,
    controller: new AbortController(),
    done,
    hasLatestProgress: false,
    key,
    resolveDone: () => resolveDone?.(),
    state: "running",
    waiters: new Set(),
  };
}

function removeAnalysisSourceListener<Result>(task: AnalysisTask<Result>): void {
  task.sourceSignal.removeEventListener("abort", task.sourceListener);
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
