/**
 * Subscriber-aware singleflight with two independent memory boundaries:
 *
 * - live physical reads are count/weight admitted before their loader starts;
 * - settled values live in a count/byte-bounded LRU.
 *
 * A subscriber owns only its subscription. Cancelling the final subscriber aborts the shared
 * loader, while one cancelled subscriber never interrupts another reader of the same immutable
 * key. Aborted transports remain admission-counted until they actually drain; there is no timeout
 * that pretends a still-running fetch released memory.
 */

export interface BoundedAsyncValueCacheLimits {
  /** Settled LRU entries. */
  maxEntries: number;
  /** Settled decoded value bytes. */
  maxResidentBytes: number;
  /** Active, queued, and abort-draining physical flights combined. */
  maxFlights: number;
  /** Physical loaders admitted at once. */
  maxActiveFlights: number;
  /** Conservative transient liability admitted across active loaders. */
  maxActiveBytes: number;
  /** Live callers, including subscribers waiting for an aborted same-key flight to drain. */
  maxSubscribers: number;
}

export interface AsyncValueLoadOptions {
  /** Conservative transient allocation retained while this physical loader runs. */
  estimatedBytes: number;
  signal?: AbortSignal;
}

interface ResidentEntry<Value> {
  value: Value;
  residentBytes: number;
}

interface SharedFlight<Value> {
  controller: AbortController;
  promise: Promise<Value>;
  subscribers: number;
  settled: boolean;
}

export class BoundedAsyncValueCache<Key, Value> {
  private readonly residents = new Map<Key, ResidentEntry<Value>>();
  private readonly flights = new Map<Key, SharedFlight<Value>>();
  private readonly admission: WeightedFlightAdmission;
  private readonly maxEntries: number;
  private readonly maxResidentBytes: number;
  private readonly maxFlights: number;
  private readonly maxSubscribers: number;
  private residentBytes = 0;
  private subscribers = 0;

  constructor(
    limits: BoundedAsyncValueCacheLimits,
    private readonly residentSize: (value: Value) => number,
  ) {
    this.maxEntries = nonNegativeSafeInteger(limits.maxEntries, "maxEntries");
    this.maxResidentBytes = nonNegativeSafeInteger(limits.maxResidentBytes, "maxResidentBytes");
    this.maxFlights = positiveSafeInteger(limits.maxFlights, "maxFlights");
    this.maxSubscribers = positiveSafeInteger(limits.maxSubscribers, "maxSubscribers");
    const maxActiveFlights = positiveSafeInteger(limits.maxActiveFlights, "maxActiveFlights");
    if (maxActiveFlights > this.maxFlights) {
      throw new RangeError("maxActiveFlights cannot exceed maxFlights");
    }
    this.admission = new WeightedFlightAdmission(
      maxActiveFlights,
      positiveSafeInteger(limits.maxActiveBytes, "maxActiveBytes"),
    );
  }

  get size(): number {
    return this.residents.size;
  }

  get residentByteLength(): number {
    return this.residentBytes;
  }

  get flightCount(): number {
    return this.flights.size;
  }

  get activeFlightCount(): number {
    return this.admission.activeCount;
  }

  get queuedFlightCount(): number {
    return this.admission.queuedCount;
  }

  get activeFlightByteLength(): number {
    return this.admission.activeByteLength;
  }

  get subscriberCount(): number {
    return this.subscribers;
  }

  /**
   * Read one immutable key. The first subscriber owns the physical loader; later subscribers share
   * it and independently cancel. A success is inserted into the settled LRU only while at least one
   * subscriber still wants it.
   */
  load(
    key: Key,
    options: AsyncValueLoadOptions,
    loader: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> {
    throwIfAborted(options.signal);
    const estimatedBytes = positiveSafeInteger(options.estimatedBytes, "estimatedBytes");
    if (estimatedBytes > this.admission.maxByteLength) {
      throw new RangeError("estimatedBytes exceeds the active-flight byte budget");
    }
    if (this.subscribers >= this.maxSubscribers) {
      throw new Error("too many async value subscribers are already active");
    }
    this.subscribers += 1;
    return this.subscribe(key, estimatedBytes, loader, options.signal).finally(() => {
      this.subscribers -= 1;
    });
  }

  delete(key: Key): boolean {
    const entry = this.residents.get(key);
    if (entry === undefined) return false;
    this.residents.delete(key);
    this.residentBytes -= entry.residentBytes;
    return true;
  }

  /** Release settled values and cancel every live subscription-owned transport. */
  clear(reason: unknown = new DOMException("Async value cache cleared", "AbortError")): void {
    this.residents.clear();
    this.residentBytes = 0;
    for (const flight of this.flights.values()) {
      if (!flight.settled && !flight.controller.signal.aborted) flight.controller.abort(reason);
    }
  }

  private subscribe(
    key: Key,
    estimatedBytes: number,
    loader: (signal: AbortSignal) => Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> {
    throwIfAborted(signal);
    const resident = this.residents.get(key);
    if (resident !== undefined) {
      this.residents.delete(key);
      this.residents.set(key, resident);
      return Promise.resolve(resident.value);
    }

    let flight = this.flights.get(key);
    if (flight?.controller.signal.aborted && !flight.settled) {
      // The old physical read still owns admission. One successor starts only after it drains; all
      // callers reaching this branch converge on that successor through the normal key lookup.
      const drained = flight.promise.then(() => undefined, () => undefined);
      return awaitWithSignal(
        drained.then(() => this.subscribe(key, estimatedBytes, loader, signal)),
        signal,
      );
    }
    if (flight === undefined) {
      if (this.flights.size >= this.maxFlights) {
        return Promise.reject(new Error("too many async value flights are already active"));
      }
      const controller = new AbortController();
      flight = {
        controller,
        subscribers: 0,
        settled: false,
        // Register the flight before this microtask invokes loader, closing the re-entrant race in
        // which two same-key callers could otherwise start separate physical reads.
        promise: Promise.resolve().then(async () => {
          const release = await this.admission.acquire(estimatedBytes, controller.signal);
          try {
            const value = await loader(controller.signal);
            throwIfAborted(controller.signal);
            const current = this.flights.get(key);
            if (current !== undefined && current.controller === controller && current.subscribers > 0) {
              this.publish(key, value);
            }
            return value;
          } finally {
            release();
          }
        }),
      };
      this.flights.set(key, flight);
      const owned = flight;
      void owned.promise.then(
        () => this.settleFlight(key, owned),
        () => this.settleFlight(key, owned),
      );
    }

    flight.subscribers += 1;
    let released = false;
    const releaseSubscription = () => {
      if (released) return;
      released = true;
      flight!.subscribers -= 1;
      if (flight!.subscribers === 0 && !flight!.settled && !flight!.controller.signal.aborted) {
        flight!.controller.abort(new DOMException("All async value subscribers left", "AbortError"));
      }
    };
    return awaitWithSignal(flight.promise, signal).finally(releaseSubscription);
  }

  private publish(key: Key, value: Value): void {
    const residentBytes = nonNegativeSafeInteger(this.residentSize(value), "residentSize");
    this.delete(key);
    if (this.maxEntries === 0 || residentBytes > this.maxResidentBytes) return;
    this.residents.set(key, { value, residentBytes });
    this.residentBytes += residentBytes;
    while (this.residents.size > this.maxEntries || this.residentBytes > this.maxResidentBytes) {
      const oldest = this.residents.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  private settleFlight(key: Key, flight: SharedFlight<Value>): void {
    flight.settled = true;
    if (this.flights.get(key) === flight) this.flights.delete(key);
  }
}

interface PendingAdmission {
  bytes: number;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

class WeightedFlightAdmission {
  private readonly queue: PendingAdmission[] = [];
  private active = 0;
  private activeBytes = 0;

  constructor(
    private readonly maxActive: number,
    readonly maxByteLength: number,
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get activeByteLength(): number {
    return this.activeBytes;
  }

  acquire(bytes: number, signal: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.canAdmit(bytes) && this.queue.length === 0) {
      return Promise.resolve(this.admit(bytes));
    }
    return new Promise<() => void>((resolve, reject) => {
      const pending: PendingAdmission = {
        bytes,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(pending);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason ?? new DOMException("Async value admission aborted", "AbortError"));
        },
      };
      this.queue.push(pending);
      signal.addEventListener("abort", pending.onAbort, { once: true });
      if (signal.aborted) pending.onAbort();
    });
  }

  private canAdmit(bytes: number): boolean {
    return this.active < this.maxActive && this.activeBytes + bytes <= this.maxByteLength;
  }

  private admit(bytes: number): () => void {
    this.active += 1;
    this.activeBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.activeBytes -= bytes;
      this.drain();
    };
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const pending = this.queue[0]!;
      if (pending.signal.aborted) {
        this.queue.shift();
        pending.signal.removeEventListener("abort", pending.onAbort);
        pending.reject(pending.signal.reason ?? new DOMException("Async value admission aborted", "AbortError"));
        continue;
      }
      if (!this.canAdmit(pending.bytes)) return;
      this.queue.shift();
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.resolve(this.admit(pending.bytes));
    }
  }
}

function awaitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return pending;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (succeeded: boolean, value: T | unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (succeeded) resolve(value as T);
      else reject(value);
    };
    const abort = () => finish(
      false,
      signal.reason ?? new DOMException("Async value subscription aborted", "AbortError"),
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void pending.then(
      (value) => finish(true, value),
      (error: unknown) => finish(false, error),
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}
