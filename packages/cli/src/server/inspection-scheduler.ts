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

export interface InspectionScheduleOptions<Progress = never> {
  /** Cancels only this subscription unless it is the last subscriber for the keyed execution. */
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Progress) => void;
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
  readonly controller: AbortController;
  readonly subscribers: Set<Subscriber<Output, Progress>>;
  /** A cancelled executor with the same key must physically drain before this successor starts. */
  readonly blockedBy?: InspectionJob<Key, Input, Output, Progress>;
  state: JobState;
}

/**
 * Runs at most `concurrency` distinct keyed jobs and singleflights concurrent calls for one key.
 * Completed values and errors are never cached: after settlement, the key and result are released.
 */
export class InspectionScheduler<Key, Input, Output, Progress = never> {
  private readonly concurrencyLimit: number;
  private readonly execute: InspectionExecutor<Key, Input, Output, Progress>;
  private readonly maxQueuedJobs: number;
  private readonly jobs = new Map<Key, InspectionJob<Key, Input, Output, Progress>>();
  private readonly queue: Array<InspectionJob<Key, Input, Output, Progress>> = [];
  private running = 0;

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
    return this.jobs.has(key)
      || this.running < this.concurrencyLimit
      || this.queue.length < this.maxQueuedJobs;
  }

  /**
   * Subscribes to the execution for `key`, creating it if necessary.
   *
   * The first subscriber supplies the input. Later subscribers with the same key share that
   * execution, so callers must include all result-affecting input in the key. Aborting one signal
   * rejects only that subscriber. The executor's signal is aborted once no subscribers remain.
   */
  schedule(key: Key, input: Input, options: InspectionScheduleOptions<Progress> = {}): Promise<Output> {
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
      job = {
        key,
        input,
        controller: new AbortController(),
        subscribers: new Set(),
        ...(predecessor ? { blockedBy: predecessor } : {}),
        state: "queued",
      };
      this.jobs.set(key, job);
      this.queue.push(job);
    }

    const promise = this.subscribe(job, signal, options.onProgress);
    if (created) {
      this.drain();
    }
    return promise;
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
      const runnableIndex = this.queue.findIndex((candidate) =>
        candidate.state === "queued" && (!candidate.blockedBy || candidate.blockedBy.state === "settled")
      );
      if (runnableIndex < 0) return;
      const [job] = this.queue.splice(runnableIndex, 1);
      if (job === undefined || job.state !== "queued") {
        continue;
      }

      job.state = "running";
      this.running += 1;
      this.start(job);
    }
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
    this.deleteJobIfCurrent(job);

    const subscribers = [...job.subscribers];
    job.subscribers.clear();
    for (const subscriber of subscribers) {
      this.settleSubscriber(subscriber, succeeded, result);
    }

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

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
