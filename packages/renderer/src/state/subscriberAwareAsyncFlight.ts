/** A cancellable subscriber's view of one shared physical async operation. */
export type AsyncFlightOutcome<Value> =
  | { status: "completed"; value: Value }
  | { status: "cancelled" };

export interface AsyncFlightSubscription<Owner> {
  owner?: Owner;
  signal?: AbortSignal;
}

/**
 * Share one physical async operation without turning its first caller into a permanent owner.
 * Subscribers cancel independently and disappear from the live owner set immediately. The physical
 * controller aborts only when the final subscriber leaves, and remains abort-counted until the
 * operation actually settles; no timeout or synthetic completion is part of the contract.
 */
export class SubscriberAwareAsyncFlight<Owner, Value> {
  readonly controller = new AbortController();

  private readonly subscribers = new Map<symbol, Owner | undefined>();
  private physical: Promise<Value> | null = null;
  private settled = false;

  constructor(
    private readonly execute: (signal: AbortSignal) => Promise<Value>,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get owners(): ReadonlySet<Owner> {
    const owners = new Set<Owner>();
    for (const owner of this.subscribers.values()) {
      if (owner !== undefined) owners.add(owner);
    }
    return owners;
  }

  subscribe(
    subscription: AsyncFlightSubscription<Owner> = {},
  ): Promise<AsyncFlightOutcome<Value>> {
    if (subscription.signal?.aborted || this.controller.signal.aborted) {
      return Promise.resolve({ status: "cancelled" });
    }

    const token = Symbol("async-flight-subscriber");
    this.subscribers.set(token, subscription.owner);
    const physical = this.start();

    return new Promise<AsyncFlightOutcome<Value>>((resolve, reject) => {
      let finished = false;
      const cleanup = (): void => {
        subscription.signal?.removeEventListener("abort", cancel);
        this.controller.signal.removeEventListener("abort", cancel);
      };
      const detach = (): void => {
        this.subscribers.delete(token);
        if (!this.settled && this.subscribers.size === 0 && !this.controller.signal.aborted) {
          this.controller.abort();
        }
      };
      const cancel = (): void => {
        if (finished) return;
        finished = true;
        cleanup();
        detach();
        resolve({ status: "cancelled" });
      };
      const complete = (value: Value): void => {
        if (finished) return;
        finished = true;
        cleanup();
        detach();
        resolve({ status: "completed", value });
      };
      const fail = (error: unknown): void => {
        if (finished) return;
        finished = true;
        cleanup();
        detach();
        reject(error);
      };

      subscription.signal?.addEventListener("abort", cancel, { once: true });
      this.controller.signal.addEventListener("abort", cancel, { once: true });
      // A synchronous executor may already have aborted either signal before listeners attached.
      if (subscription.signal?.aborted || this.controller.signal.aborted) {
        cancel();
      }
      void physical.then(complete, fail);
    });
  }

  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  dispose(): void {
    this.abort();
  }

  private start(): Promise<Value> {
    if (this.physical !== null) return this.physical;
    try {
      this.physical = this.execute(this.controller.signal);
    } catch (error) {
      this.physical = Promise.reject(error);
    }
    void this.physical.then(
      () => { this.settled = true; },
      () => { this.settled = true; },
    );
    return this.physical;
  }
}
