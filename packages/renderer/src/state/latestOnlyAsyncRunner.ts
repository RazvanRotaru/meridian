/**
 * Serialize expensive asynchronous work while retaining only the request currently executing and
 * the newest request which arrived behind it. Superseding a job aborts it cooperatively; the next
 * job still waits for the physical work to settle, so an implementation which ignores AbortSignal
 * (ELK today) can never multiply retained inputs or concurrent CPU work.
 */

export type LatestOnlyAsyncOutcome = "completed" | "superseded" | "cancelled" | "disposed";

interface Job<Input> {
  input: Input;
  controller: AbortController;
  obsoleteOutcome: Exclude<LatestOnlyAsyncOutcome, "completed"> | null;
  promise: Promise<LatestOnlyAsyncOutcome>;
  resolve: (outcome: LatestOnlyAsyncOutcome) => void;
  reject: (error: unknown) => void;
}

export class LatestOnlyAsyncRunner<Input> {
  private active: Job<Input> | null = null;
  private pending: Job<Input> | null = null;
  private disposed = false;

  constructor(
    private readonly execute: (input: Input, signal: AbortSignal) => Promise<void>,
  ) {}

  run(input: Input): Promise<LatestOnlyAsyncOutcome> {
    if (this.disposed) return Promise.resolve("disposed");

    const job = createJob(input);
    if (this.active === null) {
      this.start(job);
      return job.promise;
    }

    this.markObsolete(this.active, "superseded");
    if (this.pending !== null) {
      const replaced = this.pending;
      this.pending = null;
      this.settleWithoutStarting(replaced, "superseded");
    }
    this.pending = job;
    return job.promise;
  }

  /** Cancel the lane without permanently closing it. The active job remains the sole physical owner
   * until it settles; pending input is released synchronously because it never started. */
  cancel(): void {
    this.cancelWhere(() => true);
  }

  /** Cancel only matching ownership. A shared coordinator can invalidate one surface without
   * aborting another surface which intentionally owns the projection install in progress. */
  cancelWhere(predicate: (input: Input) => boolean): void {
    if (this.active !== null && predicate(this.active.input)) {
      this.markObsolete(this.active, "cancelled");
    }
    if (this.pending !== null && predicate(this.pending.input)) {
      const pending = this.pending;
      this.pending = null;
      this.settleWithoutStarting(pending, "cancelled");
    }
  }

  /** Permanently close the lane. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.markObsolete(this.active, "disposed");
    if (this.pending !== null) {
      const pending = this.pending;
      this.pending = null;
      this.settleWithoutStarting(pending, "disposed");
    }
  }

  private start(job: Job<Input>): void {
    this.active = job;
    let execution: Promise<void>;
    try {
      execution = this.execute(job.input, job.controller.signal);
    } catch (error) {
      execution = Promise.reject(error);
    }
    void execution.then(
      () => {
        job.resolve(job.obsoleteOutcome ?? "completed");
      },
      (error: unknown) => {
        if (job.obsoleteOutcome === null) {
          job.reject(error);
        } else {
          job.resolve(job.obsoleteOutcome);
        }
      },
    ).finally(() => {
      if (this.active !== job) return;
      this.active = null;
      const next = this.pending;
      this.pending = null;
      if (next === null) return;
      if (this.disposed) {
        this.settleWithoutStarting(next, "disposed");
        return;
      }
      this.start(next);
    });
  }

  private markObsolete(
    job: Job<Input> | null,
    outcome: Exclude<LatestOnlyAsyncOutcome, "completed">,
  ): void {
    if (job === null || job.obsoleteOutcome !== null) return;
    job.obsoleteOutcome = outcome;
    job.controller.abort();
  }

  private settleWithoutStarting(
    job: Job<Input>,
    outcome: Exclude<LatestOnlyAsyncOutcome, "completed">,
  ): void {
    job.obsoleteOutcome = outcome;
    job.controller.abort();
    job.resolve(outcome);
  }
}

function createJob<Input>(input: Input): Job<Input> {
  let resolve!: (outcome: LatestOnlyAsyncOutcome) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<LatestOnlyAsyncOutcome>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {
    input,
    controller: new AbortController(),
    obsoleteOutcome: null,
    promise,
    resolve,
    reject,
  };
}
