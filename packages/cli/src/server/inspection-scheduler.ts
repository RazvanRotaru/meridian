/**
 * A bounded, keyed scheduler for expensive inspections.
 *
 * The scheduler deliberately knows nothing about how an inspection runs. An executor may use an
 * in-process extractor today and a child-process transport later. Callers define the singleflight
 * identity with `key`; every input that can change the result must therefore be represented by
 * that key.
 */

export interface InspectionExecution<Key, Input, Progress = never> {
  readonly key: Key;
  readonly input: Input;
  readonly signal: AbortSignal;
  /** Broadcasts ephemeral progress only to subscribers that are still connected. */
  readonly reportProgress: (progress: Progress) => void;
}

export type InspectionExecutor<Key, Input, Output, Progress = never> = (
  execution: InspectionExecution<Key, Input, Progress>,
) => Output | PromiseLike<Output>;

export interface InspectionSchedulerOptions<Key, Input, Output, Progress = never> {
  /** Maximum number of executors that may be running at once. */
  readonly concurrency: number;
  /** Maximum distinct jobs waiting behind running work. Defaults to 32. */
  readonly maxQueued?: number;
  readonly execute: InspectionExecutor<Key, Input, Output, Progress>;
}

export class InspectionQueueFullError extends Error {
  readonly status = 429;

  constructor() {
    super("inspection queue is full; retry later");
    this.name = "InspectionQueueFullError";
  }
}

export class InspectionSchedulerClosedError extends Error {
  constructor() {
    super("inspection scheduler is closed");
    this.name = "InspectionSchedulerClosedError";
  }
}

export interface InspectionScheduleOptions<Progress = never> {
  /** Cancels only this subscription unless it is the last subscriber for the keyed execution. */
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Progress) => void;
  /**
   * Stable, non-secret identity for related jobs which share a constrained downstream resource.
   * Queued groups are served round-robin. This affects start order only; singleflight identity is
   * still defined exclusively by `key`, and an omitted group participates as the default group.
   */
  readonly fairnessGroup?: string;
  /**
   * Keep a cancelled resource-owning call pending until the shared executor has physically
   * settled. Cancellation still removes this subscriber immediately and aborts the executor when
   * it was the final subscriber; only the returned promise is joined to the executor drain. This
   * is required when caller cleanup would otherwise release files still used by a child process.
   */
  readonly awaitExecutorDrain?: boolean;
  /**
   * The job already consumed a bounded upstream lifecycle slot, so it must be allowed to wait for
   * this nested resource even when the ordinary queue is full. Only bounded internal schedulers
   * may set this; it prevents a post-admission 429 without opening public, unbounded admission.
   */
  readonly admitted?: boolean;
}

export interface InspectionSchedulerCounts {
  readonly queued: number;
  readonly running: number;
}

type JobState = "queued" | "running" | "settled";

interface Subscriber<Output, Progress> {
  readonly resolve: (value: Output | PromiseLike<Output>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onProgress: ((progress: Progress) => void) | undefined;
  onAbort: (() => void) | undefined;
  settled: boolean;
}

interface InspectionJob<Key, Input, Output, Progress> {
  readonly key: Key;
  readonly input: Input;
  readonly fairnessGroup: FairnessGroup;
  readonly controller: AbortController;
  readonly subscribers: Set<Subscriber<Output, Progress>>;
  /** Resolves only after this exact executor has stopped (or a queued job was cancelled). */
  readonly drained: Promise<void>;
  readonly resolveDrained: () => void;
  /** A cancelled executor with the same key must physically drain before this successor starts. */
  readonly blockedBy?: InspectionJob<Key, Input, Output, Progress>;
  state: JobState;
}

const DEFAULT_FAIRNESS_GROUP = Symbol("inspection-default-fairness-group");
type FairnessGroup = string | typeof DEFAULT_FAIRNESS_GROUP;

/**
 * Runs at most `concurrency` distinct keyed jobs and singleflights concurrent calls for one key.
 * Completed values and errors are never cached: after settlement, the key and result are released.
 */
export class InspectionScheduler<Key, Input, Output, Progress = never> {
  private readonly concurrencyLimit: number;
  private readonly execute: InspectionExecutor<Key, Input, Output, Progress>;
  private readonly maxQueuedJobs: number;
  private readonly jobs = new Map<Key, InspectionJob<Key, Input, Output, Progress>>();
  private readonly activeJobs = new Set<InspectionJob<Key, Input, Output, Progress>>();
  private readonly queue: Array<InspectionJob<Key, Input, Output, Progress>> = [];
  private lastDispatchedGroup: FairnessGroup | undefined;
  private running = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: InspectionSchedulerOptions<Key, Input, Output, Progress>) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError("inspection scheduler concurrency must be a positive safe integer");
    }
    const maxQueued = options.maxQueued ?? 32;
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new RangeError("inspection scheduler queue limit must be a non-negative safe integer");
    }
    this.concurrencyLimit = options.concurrency;
    this.maxQueuedJobs = maxQueued;
    this.execute = options.execute;
  }

  get concurrency(): number {
    return this.concurrencyLimit;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get runningCount(): number {
    return this.running;
  }

  get queueLimit(): number {
    return this.maxQueuedJobs;
  }

  /** Returns a point-in-time snapshot suitable for metrics or status responses. */
  get counts(): InspectionSchedulerCounts {
    return { queued: this.queue.length, running: this.running };
  }

  /** Whether a new subscription can be admitted right now without mutating scheduler state. */
  canSchedule(key: Key): boolean {
    return !this.closed && (this.jobs.has(key)
      || this.running < this.concurrencyLimit
      || this.queue.length < this.maxQueuedJobs);
  }

  /**
   * Subscribes to the execution for `key`, creating it if necessary.
   *
   * The first subscriber supplies the input. Later subscribers with the same key share that
   * execution, so callers must include all result-affecting input in the key. Aborting one signal
   * rejects only that subscriber. The executor's signal is aborted once no subscribers remain.
   */
  schedule(key: Key, input: Input, options: InspectionScheduleOptions<Progress> = {}): Promise<Output> {
    if (this.closed) throw new InspectionSchedulerClosedError();
    const { signal } = options;
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }

    let job = this.jobs.get(key);
    const predecessor = job?.state === "running"
      && job.subscribers.size === 0
      && job.controller.signal.aborted
      ? job
      : undefined;
    if (predecessor) job = undefined;
    const created = job === undefined;
    if (job === undefined) {
      if (
        !predecessor
        && options.admitted !== true
        && this.running >= this.concurrencyLimit
        && this.queue.length >= this.maxQueuedJobs
      ) {
        // Deliberately synchronous: HTTP handlers can reject overload before committing a 200
        // streaming response. Existing-key subscribers are checked above and still singleflight.
        throw new InspectionQueueFullError();
      }
      let resolveDrained!: () => void;
      const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
      job = {
        key,
        input,
        fairnessGroup: options.fairnessGroup && options.fairnessGroup.length > 0
          ? options.fairnessGroup
          : DEFAULT_FAIRNESS_GROUP,
        controller: new AbortController(),
        subscribers: new Set(),
        drained,
        resolveDrained,
        ...(predecessor ? { blockedBy: predecessor } : {}),
        state: "queued",
      };
      this.jobs.set(key, job);
      this.activeJobs.add(job);
      this.queue.push(job);
    }

    const promise = this.subscribe(job, signal, options.onProgress);
    if (created) {
      this.drain();
    }
    if (options.awaitExecutorDrain !== true) return promise;
    return promise.catch(async (error) => {
      await job.drained;
      throw error;
    });
  }

  /**
   * Stop admission, cancel every subscription, and resolve only after all executors physically
   * stop. This is the scheduler's process-lifecycle boundary; no result values are retained.
   */
  close(reason: unknown = schedulerClosedReason()): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const jobs = [...this.activeJobs];
    for (const job of jobs) {
      for (const subscriber of [...job.subscribers]) {
        this.cancelSubscriber(job, subscriber, reason);
      }
      if (job.state === "running" && !job.controller.signal.aborted) {
        job.controller.abort(reason);
      }
    }
    return this.closePromise = Promise.all(jobs.map((job) => job.drained)).then(() => undefined);
  }

  private subscribe(
    job: InspectionJob<Key, Input, Output, Progress>,
    signal: AbortSignal | undefined,
    onProgress: ((progress: Progress) => void) | undefined,
  ): Promise<Output> {
    return new Promise<Output>((resolve, reject) => {
      const subscriber: Subscriber<Output, Progress> = {
        resolve,
        reject,
        signal,
        onProgress,
        onAbort: undefined,
        settled: false,
      };

      if (signal !== undefined) {
        subscriber.onAbort = () => {
          this.cancelSubscriber(job, subscriber, abortReason(signal));
        };
        signal.addEventListener("abort", subscriber.onAbort, { once: true });
      }

      job.subscribers.add(subscriber);
    });
  }

  private drain(): void {
    while (this.running < this.concurrencyLimit && this.queue.length > 0) {
      const runnableIndex = this.nextRunnableIndex();
      if (runnableIndex < 0) return;
      const [job] = this.queue.splice(runnableIndex, 1);
      if (job === undefined || job.state !== "queued") {
        continue;
      }

      job.state = "running";
      this.lastDispatchedGroup = job.fairnessGroup;
      this.running += 1;
      this.start(job);
    }
  }

  /** Pick the next runnable group after the one most recently dispatched, then retain FIFO order
   * inside that group. A group with two sides can consume spare slots immediately, but once capacity
   * is saturated it cannot monopolize the next released slot while another group is waiting. */
  private nextRunnableIndex(): number {
    const groups: FairnessGroup[] = [];
    const seen = new Set<FairnessGroup>();
    for (const candidate of this.queue) {
      if (!isRunnable(candidate) || seen.has(candidate.fairnessGroup)) continue;
      seen.add(candidate.fairnessGroup);
      groups.push(candidate.fairnessGroup);
    }
    if (groups.length === 0) return -1;

    let selectedGroup = groups[0]!;
    if (this.lastDispatchedGroup !== undefined) {
      const previousIndex = groups.indexOf(this.lastDispatchedGroup);
      if (previousIndex >= 0 && groups.length > 1) {
        selectedGroup = groups[(previousIndex + 1) % groups.length]!;
      }
    }
    return this.queue.findIndex((candidate) => (
      isRunnable(candidate) && candidate.fairnessGroup === selectedGroup
    ));
  }

  private start(job: InspectionJob<Key, Input, Output, Progress>): void {
    // Enter through a promise so a synchronously throwing executor cannot recursively drain a
    // large queue. It also lets a same-turn cancellation prevent unnecessary executor startup.
    void Promise.resolve()
      .then(() => {
        if (job.subscribers.size === 0) {
          throw abortReason(job.controller.signal);
        }
        return this.execute({
          key: job.key,
          input: job.input,
          signal: job.controller.signal,
          reportProgress: (progress) => this.reportProgress(job, progress),
        });
      })
      .then(
        (value) => this.finish(job, true, value),
        (error: unknown) => this.finish(job, false, error),
      );
  }

  private cancelSubscriber(
    job: InspectionJob<Key, Input, Output, Progress>,
    subscriber: Subscriber<Output, Progress>,
    reason: unknown,
  ): void {
    if (subscriber.settled || !job.subscribers.delete(subscriber)) {
      return;
    }

    this.settleSubscriber(subscriber, false, reason);
    if (job.subscribers.size > 0) {
      return;
    }

    if (!job.controller.signal.aborted) {
      job.controller.abort(reason);
    }

    if (job.state === "queued") {
      this.restoreDrainingPredecessorOrDelete(job);
      const queueIndex = this.queue.indexOf(job);
      if (queueIndex >= 0) {
        this.queue.splice(queueIndex, 1);
      }
      job.state = "settled";
      this.activeJobs.delete(job);
      job.resolveDrained();
    }
    // A running executor retains both its slot and a same-key tombstone until it actually settles.
    // A later subscriber may queue one blocked successor, but can never overlap the draining job.
  }

  private reportProgress(job: InspectionJob<Key, Input, Output, Progress>, progress: Progress): void {
    for (const subscriber of job.subscribers) {
      if (subscriber.settled || !subscriber.onProgress) continue;
      try {
        subscriber.onProgress(progress);
      } catch {
        // A broken response writer is isolated to its request cancellation path.
      }
    }
  }

  private finish(job: InspectionJob<Key, Input, Output, Progress>, succeeded: boolean, result: unknown): void {
    if (job.state !== "running") {
      return;
    }

    job.state = "settled";
    this.running -= 1;
    this.activeJobs.delete(job);
    this.deleteJobIfCurrent(job);

    const subscribers = [...job.subscribers];
    job.subscribers.clear();
    for (const subscriber of subscribers) {
      this.settleSubscriber(subscriber, succeeded, result);
    }

    job.resolveDrained();
    this.drain();
  }

  private settleSubscriber(subscriber: Subscriber<Output, Progress>, succeeded: boolean, result: unknown): void {
    if (subscriber.settled) {
      return;
    }
    subscriber.settled = true;
    if (subscriber.signal !== undefined && subscriber.onAbort !== undefined) {
      subscriber.signal.removeEventListener("abort", subscriber.onAbort);
    }
    subscriber.onAbort = undefined;

    if (succeeded) {
      subscriber.resolve(result as Output);
    } else {
      subscriber.reject(result);
    }
  }

  private deleteJobIfCurrent(job: InspectionJob<Key, Input, Output, Progress>): void {
    // An abandoned running job may settle after a new job with the same key was scheduled.
    if (this.jobs.get(job.key) === job) {
      this.jobs.delete(job.key);
    }
  }

  private restoreDrainingPredecessorOrDelete(job: InspectionJob<Key, Input, Output, Progress>): void {
    if (this.jobs.get(job.key) !== job) {
      return;
    }
    // A blocked successor temporarily replaces its abandoned predecessor in `jobs` so new callers
    // can join the successor. If that successor is itself abandoned, put the still-draining executor
    // back as the keyed tombstone. Otherwise a third request could start beside the first executor.
    if (job.blockedBy?.state === "running") {
      this.jobs.set(job.key, job.blockedBy);
      return;
    }
    this.jobs.delete(job.key);
  }
}

function schedulerClosedReason(): Error {
  const error = new Error("inspection scheduler closed");
  error.name = "AbortError";
  return error;
}

function isRunnable<Key, Input, Output, Progress>(
  job: InspectionJob<Key, Input, Output, Progress>,
): boolean {
  return job.state === "queued" && (!job.blockedBy || job.blockedBy.state === "settled");
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
