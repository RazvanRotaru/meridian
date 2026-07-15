import { describe, expect, it } from "vitest";
import { InspectionQueueFullError, InspectionScheduler } from "./inspection-scheduler";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("InspectionScheduler", () => {
  it("bounds distinct executions and reports queued and running counts", async () => {
    const gates = new Map([
      ["a", deferred<string>()],
      ["b", deferred<string>()],
      ["c", deferred<string>()],
    ]);
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const scheduler = new InspectionScheduler<string, string, string>({
      concurrency: 2,
      execute: ({ key }) => {
        starts.push(key);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        return gates.get(key)!.promise.finally(() => {
          active -= 1;
        });
      },
    });

    const first = scheduler.schedule("a", "input-a");
    const second = scheduler.schedule("b", "input-b");
    const third = scheduler.schedule("c", "input-c");

    expect(scheduler.concurrency).toBe(2);
    expect(scheduler.counts).toEqual({ queued: 1, running: 2 });
    expect(scheduler.queuedCount).toBe(1);
    expect(scheduler.runningCount).toBe(2);
    await flushMicrotasks();
    expect(starts).toEqual(["a", "b"]);

    gates.get("a")!.resolve("result-a");
    await expect(first).resolves.toBe("result-a");
    await flushMicrotasks();
    expect(starts).toEqual(["a", "b", "c"]);
    expect(scheduler.counts).toEqual({ queued: 0, running: 2 });

    gates.get("b")!.resolve("result-b");
    gates.get("c")!.resolve("result-c");
    await expect(Promise.all([second, third])).resolves.toEqual(["result-b", "result-c"]);
    expect(maximumActive).toBe(2);
    expect(scheduler.counts).toEqual({ queued: 0, running: 0 });
  });

  it("singleflights a key while keeping subscriber cancellation independent", async () => {
    const gate = deferred<number>();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstReason = new Error("first caller left");
    let calls = 0;
    let executorSignal: AbortSignal | undefined;
    let executorInput: string | undefined;
    const scheduler = new InspectionScheduler<string, string, number>({
      concurrency: 1,
      execute: ({ input, signal }) => {
        calls += 1;
        executorInput = input;
        executorSignal = signal;
        return gate.promise;
      },
    });

    const first = scheduler.schedule("same", "first input wins", { signal: firstController.signal });
    const second = scheduler.schedule("same", "ignored duplicate input", { signal: secondController.signal });
    const firstOutcome = first.catch((error: unknown) => error);
    await flushMicrotasks();

    expect(calls).toBe(1);
    expect(executorInput).toBe("first input wins");
    firstController.abort(firstReason);
    await expect(firstOutcome).resolves.toBe(firstReason);
    expect(executorSignal?.aborted).toBe(false);

    gate.resolve(42);
    await expect(second).resolves.toBe(42);
    expect(scheduler.counts).toEqual({ queued: 0, running: 0 });
  });

  it("broadcasts progress to live subscribers without retaining a disconnected writer", async () => {
    const gate = deferred<string>();
    const firstController = new AbortController();
    let report!: (progress: string) => void;
    const firstProgress: string[] = [];
    const secondProgress: string[] = [];
    const scheduler = new InspectionScheduler<string, undefined, string, string>({
      concurrency: 1,
      execute: (execution) => {
        report = execution.reportProgress;
        return gate.promise;
      },
    });
    const first = scheduler.schedule("same", undefined, {
      signal: firstController.signal,
      onProgress: (stage) => firstProgress.push(stage),
    });
    const second = scheduler.schedule("same", undefined, {
      onProgress: (stage) => secondProgress.push(stage),
    });
    const firstOutcome = first.catch((error: unknown) => error);
    await flushMicrotasks();

    report("clone");
    firstController.abort(new Error("first response closed"));
    await firstOutcome;
    report("extract");
    gate.resolve("done");
    await expect(second).resolves.toBe("done");

    expect(firstProgress).toEqual(["clone"]);
    expect(secondProgress).toEqual(["clone", "extract"]);
  });

  it("aborts a running executor only after its last subscriber leaves", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstReason = new Error("first caller left");
    const lastReason = new Error("last caller left");
    let executorSignal: AbortSignal | undefined;
    const scheduler = new InspectionScheduler<string, undefined, never>({
      concurrency: 1,
      execute: ({ signal }) => {
        executorSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    const first = scheduler.schedule("same", undefined, { signal: firstController.signal });
    const second = scheduler.schedule("same", undefined, { signal: secondController.signal });
    const outcomes = Promise.all([first.catch((error: unknown) => error), second.catch((error: unknown) => error)]);
    await flushMicrotasks();

    firstController.abort(firstReason);
    expect(executorSignal?.aborted).toBe(false);
    secondController.abort(lastReason);
    expect(executorSignal?.aborted).toBe(true);
    expect(executorSignal?.reason).toBe(lastReason);
    await expect(outcomes).resolves.toEqual([firstReason, lastReason]);
    await flushMicrotasks();
    expect(scheduler.counts).toEqual({ queued: 0, running: 0 });
  });

  it("does not overlap a same-key successor while a cancelled executor is still draining", async () => {
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();
    const controller = new AbortController();
    const starts: number[] = [];
    const scheduler = new InspectionScheduler<string, undefined, string>({
      concurrency: 2,
      maxQueued: 0,
      execute: () => {
        starts.push(starts.length + 1);
        return starts.length === 1 ? firstGate.promise : secondGate.promise;
      },
    });

    const abandoned = scheduler.schedule("same", undefined, { signal: controller.signal });
    const abandonedOutcome = abandoned.catch((error: unknown) => error);
    await flushMicrotasks();
    controller.abort(new Error("left"));
    await abandonedOutcome;

    const successor = scheduler.schedule("same", undefined);
    await flushMicrotasks();
    expect(starts).toEqual([1]);
    expect(scheduler.counts).toEqual({ running: 1, queued: 1 });

    firstGate.reject(new Error("cancelled executor drained"));
    await flushMicrotasks();
    expect(starts).toEqual([1, 2]);
    secondGate.resolve("fresh");
    await expect(successor).resolves.toBe("fresh");
  });

  it("keeps the draining tombstone when a blocked same-key successor is cancelled", async () => {
    const firstGate = deferred<string>();
    const thirdGate = deferred<string>();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const starts: number[] = [];
    const scheduler = new InspectionScheduler<string, undefined, string>({
      concurrency: 2,
      maxQueued: 0,
      execute: () => {
        starts.push(starts.length + 1);
        return starts.length === 1 ? firstGate.promise : thirdGate.promise;
      },
    });

    const first = scheduler.schedule("same", undefined, { signal: firstController.signal });
    const firstOutcome = first.catch((error: unknown) => error);
    await flushMicrotasks();
    firstController.abort(new Error("first caller left"));
    await firstOutcome;

    const second = scheduler.schedule("same", undefined, { signal: secondController.signal });
    const secondOutcome = second.catch((error: unknown) => error);
    secondController.abort(new Error("second caller left"));
    await secondOutcome;

    const third = scheduler.schedule("same", undefined);
    await flushMicrotasks();
    expect(starts).toEqual([1]);
    expect(scheduler.counts).toEqual({ running: 1, queued: 1 });

    firstGate.reject(new Error("first executor drained"));
    await flushMicrotasks();
    expect(starts).toEqual([1, 2]);
    thirdGate.resolve("third result");
    await expect(third).resolves.toBe("third result");
  });

  it("removes a cancelled queued job without invoking its executor", async () => {
    const runningGate = deferred<string>();
    const queuedController = new AbortController();
    const queuedReason = new Error("queued caller left");
    const starts: string[] = [];
    const scheduler = new InspectionScheduler<string, undefined, string>({
      concurrency: 1,
      execute: ({ key }) => {
        starts.push(key);
        return runningGate.promise;
      },
    });

    const running = scheduler.schedule("running", undefined);
    const queued = scheduler.schedule("queued", undefined, { signal: queuedController.signal });
    const queuedOutcome = queued.catch((error: unknown) => error);
    expect(scheduler.counts).toEqual({ queued: 1, running: 1 });

    queuedController.abort(queuedReason);
    await expect(queuedOutcome).resolves.toBe(queuedReason);
    expect(scheduler.counts).toEqual({ queued: 0, running: 1 });
    await flushMicrotasks();
    expect(starts).toEqual(["running"]);

    runningGate.resolve("done");
    await expect(running).resolves.toBe("done");
    expect(scheduler.counts).toEqual({ queued: 0, running: 0 });
  });

  it("lets an upstream-admitted job wait without weakening ordinary queue overload", async () => {
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();
    const starts: string[] = [];
    const scheduler = new InspectionScheduler<string, undefined, string>({
      concurrency: 1,
      maxQueued: 0,
      execute: ({ key }) => {
        starts.push(key);
        return key === "running" ? firstGate.promise : secondGate.promise;
      },
    });

    const running = scheduler.schedule("running", undefined);
    const reserved = scheduler.schedule("reserved", undefined, { admitted: true });
    expect(() => scheduler.schedule("ordinary", undefined)).toThrow(InspectionQueueFullError);
    expect(scheduler.counts).toEqual({ running: 1, queued: 1 });

    firstGate.resolve("first");
    await expect(running).resolves.toBe("first");
    await flushMicrotasks();
    expect(starts).toEqual(["running", "reserved"]);
    secondGate.resolve("second");
    await expect(reserved).resolves.toBe("second");
  });

  it("fans out failures, cleans up, and executes the key again on a later call", async () => {
    const failure = new Error("extractor failed");
    let calls = 0;
    const scheduler = new InspectionScheduler<string, undefined, number>({
      concurrency: 1,
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          throw failure;
        }
        return calls;
      },
    });

    const first = scheduler.schedule("retryable", undefined);
    const duplicate = scheduler.schedule("retryable", undefined);
    const outcomes = await Promise.allSettled([first, duplicate]);
    expect(outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(calls).toBe(1);
    expect(scheduler.counts).toEqual({ queued: 0, running: 0 });

    await expect(scheduler.schedule("retryable", undefined)).resolves.toBe(2);
    expect(calls).toBe(2);
    expect(scheduler.counts).toEqual({ queued: 0, running: 0 });
  });

  it("does not enqueue a subscriber whose signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("already gone");
    controller.abort(reason);
    let calls = 0;
    const scheduler = new InspectionScheduler<string, undefined, void>({
      concurrency: 1,
      execute: () => {
        calls += 1;
      },
    });

    await expect(scheduler.schedule("unused", undefined, { signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toBe(0);
    expect(scheduler.counts).toEqual({ queued: 0, running: 0 });
  });

  it("bounds distinct queued jobs while still accepting subscribers for an existing key", async () => {
    const runningGate = deferred<string>();
    const queuedGate = deferred<string>();
    const scheduler = new InspectionScheduler<string, undefined, string>({
      concurrency: 1,
      maxQueued: 1,
      execute: ({ key }) => key === "running" ? runningGate.promise : queuedGate.promise,
    });
    const running = scheduler.schedule("running", undefined);
    const queued = scheduler.schedule("queued", undefined);
    const duplicate = scheduler.schedule("queued", undefined);

    expect(scheduler.queueLimit).toBe(1);
    expect(scheduler.canSchedule("queued")).toBe(true);
    expect(scheduler.canSchedule("overflow")).toBe(false);
    expect(() => scheduler.schedule("overflow", undefined)).toThrow(InspectionQueueFullError);
    expect(scheduler.counts).toEqual({ running: 1, queued: 1 });

    runningGate.resolve("first");
    await expect(running).resolves.toBe("first");
    queuedGate.resolve("second");
    await expect(Promise.all([queued, duplicate])).resolves.toEqual(["second", "second"]);
  });

  it("supports strict backpressure while still joining a saturated key", async () => {
    const gate = deferred<string>();
    const scheduler = new InspectionScheduler<string, undefined, string>({
      concurrency: 1,
      maxQueued: 0,
      execute: () => gate.promise,
    });
    const running = scheduler.schedule("same", undefined);
    const duplicate = scheduler.schedule("same", undefined);
    expect(() => scheduler.schedule("different", undefined)).toThrow(InspectionQueueFullError);

    gate.resolve("done");
    await expect(Promise.all([running, duplicate])).resolves.toEqual(["done", "done"]);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])("rejects invalid concurrency %s", (concurrency) => {
    expect(
      () =>
        new InspectionScheduler<string, undefined, void>({
          concurrency,
          execute: () => undefined,
        }),
    ).toThrow(RangeError);
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])("rejects invalid queue limit %s", (maxQueued) => {
    expect(() => new InspectionScheduler({ concurrency: 1, maxQueued, execute: () => undefined })).toThrow(RangeError);
  });
});
