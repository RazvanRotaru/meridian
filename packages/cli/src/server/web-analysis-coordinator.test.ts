import { describe, expect, it, vi } from "vitest";
import {
  AnalysisCoordinator,
  AnalysisCoordinatorAbortError,
  AnalysisCoordinatorClosedError,
  AnalysisCoordinatorOverloadedError,
} from "./web-analysis-coordinator";

describe("AnalysisCoordinator", () => {
  it("singleflights equal keys without retaining a completed result", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 1 });
    const started = deferred<void>();
    const release = deferred<string>();
    const firstWork = vi.fn(async () => {
      started.resolve();
      return release.promise;
    });
    const ignoredFollowerWork = vi.fn(async () => "follower");

    const first = coordinator.run("same", firstWork);
    await started.promise;
    const follower = coordinator.run("same", ignoredFollowerWork);
    release.resolve("shared");

    await expect(Promise.all([first, follower])).resolves.toEqual(["shared", "shared"]);
    expect(firstWork).toHaveBeenCalledTimes(1);
    expect(ignoredFollowerWork).not.toHaveBeenCalled();

    const nextWork = vi.fn(async () => "fresh");
    await expect(coordinator.run("same", nextWork)).resolves.toBe("fresh");
    expect(nextWork).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it("replays the latest progress to a late waiter and broadcasts later progress in order", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const cloneReported = deferred<void>();
    const continueWork = deferred<void>();
    const firstEvents: string[] = [];
    const followerEvents: string[] = [];

    const first = coordinator.run<number, string>(
      "progress",
      async ({ report }) => {
        report("clone");
        cloneReported.resolve();
        await continueWork.promise;
        report("extract");
        return 7;
      },
      {
        onProgress: (progress) => {
          firstEvents.push(progress);
        },
      },
    );
    await cloneReported.promise;

    const followerFactory = vi.fn(async () => 99);
    const follower = coordinator.run<number, string>("progress", followerFactory, {
      onProgress: (progress) => {
        followerEvents.push(progress);
      },
    });
    await flushMicrotasks();
    expect(followerEvents).toEqual(["clone"]);

    continueWork.resolve();
    await expect(Promise.all([first, follower])).resolves.toEqual([7, 7]);
    expect(firstEvents).toEqual(["clone", "extract"]);
    expect(followerEvents).toEqual(["clone", "extract"]);
    expect(followerFactory).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it("delivers queued progress before resolving that waiter", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const releaseProgress = deferred<void>();
    const events: string[] = [];
    let resolved = false;

    const result = coordinator.run<string, string>(
      "ordered-progress",
      ({ report }) => {
        report("extract");
        return "done";
      },
      {
        onProgress: async (progress) => {
          await releaseProgress.promise;
          events.push(progress);
        },
      },
    );
    void result.then(() => {
      resolved = true;
    });

    await flushMicrotasks();
    expect(resolved).toBe(false);
    releaseProgress.resolve();
    await expect(result).resolves.toBe("done");
    expect(events).toEqual(["extract"]);
    expect(resolved).toBe(true);
    await coordinator.close();
  });

  it("isolates synchronous and asynchronous progress callback failures from shared work", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const release = deferred<void>();
    const syncFailure = new Error("sync writer failed");
    const asyncFailure = new Error("async writer failed");
    const healthyEvents: string[] = [];
    let sharedSignal: AbortSignal | undefined;
    const work = vi.fn(async ({ signal, report }: { signal: AbortSignal; report(progress: string): void }) => {
      sharedSignal = signal;
      report("clone");
      await release.promise;
      return "complete";
    });

    const syncWaiter = coordinator.run<string, string>("callbacks", work, {
      onProgress: () => {
        throw syncFailure;
      },
    });
    const asyncWaiter = coordinator.run<string, string>("callbacks", work, {
      onProgress: async () => {
        throw asyncFailure;
      },
    });
    const healthyWaiter = coordinator.run<string, string>("callbacks", work, {
      onProgress: (progress) => {
        healthyEvents.push(progress);
      },
    });

    await expect(syncWaiter).rejects.toBe(syncFailure);
    await expect(asyncWaiter).rejects.toBe(asyncFailure);
    expect(sharedSignal?.aborted).toBe(false);
    release.resolve();
    await expect(healthyWaiter).resolves.toBe("complete");
    expect(healthyEvents).toEqual(["clone"]);
    expect(work).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it("aborting one waiter leaves shared work alive for the remaining waiter", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const started = deferred<void>();
    const release = deferred<string>();
    let sharedSignal: AbortSignal | undefined;
    const reason = new Error("first request closed");

    const first = coordinator.run(
      "independent-abort",
      async ({ signal }) => {
        sharedSignal = signal;
        started.resolve();
        return release.promise;
      },
      { signal: firstController.signal },
    );
    const second = coordinator.run("independent-abort", async () => "ignored", {
      signal: secondController.signal,
    });
    await started.promise;

    firstController.abort(reason);
    await expect(first).rejects.toBe(reason);
    expect(sharedSignal?.aborted).toBe(false);

    release.resolve("survivor");
    await expect(second).resolves.toBe("survivor");
    expect(secondController.signal.aborted).toBe(false);
    await coordinator.close();
  });

  it("aborts an abandoned running job and lets a replacement use the same key", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const controller = new AbortController();
    const oldStarted = deferred<void>();
    const oldRelease = deferred<string>();
    let oldSignal: AbortSignal | undefined;
    let abortEvents = 0;

    const abandoned = coordinator.run(
      "replaceable",
      async ({ signal }) => {
        oldSignal = signal;
        signal.addEventListener("abort", () => {
          abortEvents += 1;
        });
        oldStarted.resolve();
        return oldRelease.promise;
      },
      { signal: controller.signal },
    );
    await oldStarted.promise;

    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    expect(oldSignal?.reason).toBeInstanceOf(AnalysisCoordinatorAbortError);
    expect(abortEvents).toBe(1);

    const replacementWork = vi.fn(async () => "replacement");
    await expect(coordinator.run("replaceable", replacementWork)).resolves.toBe("replacement");
    expect(replacementWork).toHaveBeenCalledTimes(1);

    oldRelease.resolve("discarded");
    await flushMicrotasks();
    const afterOldSettlement = vi.fn(async () => "after-old");
    await expect(coordinator.run("replaceable", afterOldSettlement)).resolves.toBe("after-old");
    expect(afterOldSettlement).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it("starts cache work immediately while a heavy-analysis permit is saturated", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 1 });
    const heavyStarted = deferred<void>();
    const releaseHeavy = deferred<void>();
    const queuedPrepared = deferred<void>();
    const queuedAnalysis = vi.fn(async () => "queued");

    const heavy = coordinator.run("heavy", ({ runAnalysis }) => runAnalysis(async () => {
      heavyStarted.resolve();
      await releaseHeavy.promise;
      return "heavy";
    }));
    await heavyStarted.promise;

    const queued = coordinator.run("queued-heavy", async ({ runAnalysis }) => {
      queuedPrepared.resolve();
      return runAnalysis(queuedAnalysis);
    });
    await queuedPrepared.promise;
    await flushMicrotasks();
    expect(queuedAnalysis).not.toHaveBeenCalled();

    const cacheHit = vi.fn(async () => "cached");
    await expect(coordinator.run("cache-hit", cacheHit)).resolves.toBe("cached");
    expect(cacheHit).toHaveBeenCalledTimes(1);
    expect(queuedAnalysis).not.toHaveBeenCalled();

    releaseHeavy.resolve();
    await expect(heavy).resolves.toBe("heavy");
    await expect(queued).resolves.toBe("queued");
    expect(queuedAnalysis).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it("bounds explicit heavy analyses and admits the third in FIFO order", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const releases = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const run = (key: string, index: number) => coordinator.run(key, ({ runAnalysis }) =>
      runAnalysis(async () => {
        starts.push(key);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await releases[index]!.promise;
        active -= 1;
        return key;
      }));

    const first = run("first", 0);
    const second = run("second", 1);
    const third = run("third", 2);
    const fourth = run("fourth", 3);
    await flushMicrotasks();
    expect(starts).toEqual(["first", "second"]);

    releases[1]!.resolve();
    await expect(second).resolves.toBe("second");
    await flushMicrotasks();
    expect(starts).toEqual(["first", "second", "third"]);

    releases[0]!.resolve();
    await expect(first).resolves.toBe("first");
    await flushMicrotasks();
    expect(starts).toEqual(["first", "second", "third", "fourth"]);
    expect(maximumActive).toBe(2);

    releases[2]!.resolve();
    releases[3]!.resolve();
    await expect(Promise.all([third, fourth])).resolves.toEqual(["third", "fourth"]);
    await coordinator.close();
  });

  it("bounds preparation independently and rejects beyond the exact queue capacity", async () => {
    const coordinator = new AnalysisCoordinator({
      maxConcurrentAnalyses: 1,
      maxConcurrentPreparations: 1,
      maxQueuedPreparations: 1,
    });
    const runningRelease = deferred<void>();
    const queuedRelease = deferred<void>();
    const starts: string[] = [];
    const run = (key: string, release: ReturnType<typeof deferred<void>>) => coordinator.run(
      key,
      ({ runPreparation }) => runPreparation(async () => {
        starts.push(key);
        await release.promise;
        return key;
      }),
    );

    const running = run("running-preparation", runningRelease);
    await flushMicrotasks();
    const queued = run("queued-preparation", queuedRelease);
    const rejectedWork = vi.fn(async () => "must not run");
    const rejected = coordinator.run(
      "rejected-preparation",
      ({ runPreparation }) => runPreparation(rejectedWork),
    );

    await expect(rejected).rejects.toMatchObject({
      name: "AnalysisCoordinatorOverloadedError",
      phase: "preparation",
    });
    expect(rejectedWork).not.toHaveBeenCalled();
    expect(starts).toEqual(["running-preparation"]);

    runningRelease.resolve();
    await expect(running).resolves.toBe("running-preparation");
    await flushMicrotasks();
    expect(starts).toEqual(["running-preparation", "queued-preparation"]);
    queuedRelease.resolve();
    await expect(queued).resolves.toBe("queued-preparation");
    await coordinator.close();
  });

  it("bounds analysis, lets same-key followers join a full queue, and permits a fresh retry", async () => {
    const coordinator = new AnalysisCoordinator({
      maxConcurrentAnalyses: 1,
      maxQueuedAnalyses: 1,
    });
    const runningRelease = deferred<void>();
    const queuedRelease = deferred<void>();
    const running = coordinator.run("analysis-running", ({ runAnalysis }) => runAnalysis(async () => {
      await runningRelease.promise;
      return "running";
    }));
    await flushMicrotasks();
    const queuedWork = vi.fn(async () => {
      await queuedRelease.promise;
      return "shared";
    });
    const queued = coordinator.run("analysis-shared", ({ runAnalysis }) => runAnalysis(queuedWork));
    const followerFactory = vi.fn(async () => "ignored");
    const follower = coordinator.run("analysis-shared", followerFactory);
    const rejectedWork = vi.fn(async () => "must not run");
    const rejected = coordinator.run("analysis-overflow", ({ runAnalysis }) => runAnalysis(rejectedWork));

    await expect(rejected).rejects.toBeInstanceOf(AnalysisCoordinatorOverloadedError);
    expect(rejectedWork).not.toHaveBeenCalled();
    expect(followerFactory).not.toHaveBeenCalled();

    runningRelease.resolve();
    await expect(running).resolves.toBe("running");
    await flushMicrotasks();
    expect(queuedWork).toHaveBeenCalledTimes(1);
    queuedRelease.resolve();
    await expect(Promise.all([queued, follower])).resolves.toEqual(["shared", "shared"]);

    const retryWork = vi.fn(async () => "retry");
    await expect(coordinator.run(
      "analysis-overflow",
      ({ runAnalysis }) => runAnalysis(retryWork),
    )).resolves.toBe("retry");
    expect(retryWork).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it("keeps preparation and analysis admissions independent", async () => {
    const coordinator = new AnalysisCoordinator({
      maxConcurrentAnalyses: 1,
      maxConcurrentPreparations: 1,
      maxQueuedAnalyses: 0,
      maxQueuedPreparations: 0,
    });
    const analysisRelease = deferred<void>();
    const analysisStarted = deferred<void>();
    const analysis = coordinator.run("analysis", ({ runAnalysis }) => runAnalysis(async () => {
      analysisStarted.resolve();
      await analysisRelease.promise;
      return "analysis";
    }));
    await analysisStarted.promise;

    await expect(coordinator.run(
      "preparation",
      ({ runPreparation }) => runPreparation(async () => "preparation"),
    )).resolves.toBe("preparation");
    await expect(coordinator.run(
      "analysis-overload",
      ({ runAnalysis }) => runAnalysis(async () => "blocked"),
    )).rejects.toMatchObject({ phase: "analysis" });

    analysisRelease.resolve();
    await expect(analysis).resolves.toBe("analysis");
    await coordinator.close();
  });

  it("removes an aborted queued job without starting it or leaking the permit", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 1 });
    const blockerStarted = deferred<void>();
    const releaseBlocker = deferred<void>();
    const queuedController = new AbortController();
    const queuedWork = vi.fn(async () => "should not run");

    const blocker = coordinator.run("blocker", ({ runAnalysis }) => runAnalysis(async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
      return "blocker";
    }));
    await blockerStarted.promise;
    const queuedPrepared = deferred<void>();
    const queued = coordinator.run("queued", async ({ runAnalysis }) => {
      queuedPrepared.resolve();
      return runAnalysis(queuedWork);
    }, { signal: queuedController.signal });
    await queuedPrepared.promise;
    queuedController.abort(new Error("queued request closed"));
    await expect(queued).rejects.toThrow("queued request closed");

    const nextWork = vi.fn(async () => "next");
    const next = coordinator.run("next", ({ runAnalysis }) => runAnalysis(nextWork));
    releaseBlocker.resolve();
    await expect(blocker).resolves.toBe("blocker");
    await expect(next).resolves.toBe("next");
    expect(queuedWork).not.toHaveBeenCalled();
    expect(nextWork).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it("keeps a running analysis permit occupied until aborted work actually settles", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 1 });
    const controller = new AbortController();
    const runningStarted = deferred<void>();
    const releaseRunning = deferred<void>();
    const nextStarted = deferred<void>();
    let analysisSignal: AbortSignal | undefined;
    let nextDidStart = false;

    const running = coordinator.run(
      "aborted-running-analysis",
      ({ runAnalysis }) => runAnalysis(async (signal) => {
        analysisSignal = signal;
        runningStarted.resolve();
        await releaseRunning.promise;
        return "discarded";
      }),
      { signal: controller.signal },
    );
    await runningStarted.promise;
    const next = coordinator.run("next-analysis", ({ runAnalysis }) => runAnalysis(async () => {
      nextDidStart = true;
      nextStarted.resolve();
      return "next";
    }));

    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(analysisSignal?.aborted).toBe(true);
    await flushMicrotasks();
    expect(nextDidStart).toBe(false);

    releaseRunning.resolve();
    await nextStarted.promise;
    await expect(next).resolves.toBe("next");
    await coordinator.close();
  });

  it("releases admission and the singleflight entry after a worker failure", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 1 });
    const failure = new Error("analysis failed");
    const firstWork = vi.fn(() => {
      throw failure;
    });
    const first = coordinator.run("failure", ({ runAnalysis }) => runAnalysis(firstWork));
    const follower = coordinator.run("failure", async () => "ignored");
    const nextWork = vi.fn(async () => "next");
    const next = coordinator.run("next", ({ runAnalysis }) => runAnalysis(nextWork));

    await expect(first).rejects.toBe(failure);
    await expect(follower).rejects.toBe(failure);
    await expect(next).resolves.toBe("next");
    expect(firstWork).toHaveBeenCalledTimes(1);
    expect(nextWork).toHaveBeenCalledTimes(1);

    const retryWork = vi.fn(async () => "retry");
    await expect(coordinator.run("failure", ({ runAnalysis }) => runAnalysis(retryWork))).resolves.toBe("retry");
    expect(retryWork).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it("close rejects queued and running waiters, aborts work, drains, and stays closed", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 1 });
    const runningStarted = deferred<void>();
    const runningRelease = deferred<void>();
    const queuedWork = vi.fn(async () => "queued");
    let runningSignal: AbortSignal | undefined;

    const running = coordinator.run("running", ({ runAnalysis }) => runAnalysis(async (signal) => {
      runningSignal = signal;
      runningStarted.resolve();
      await runningRelease.promise;
      throw signal.reason;
    }));
    await runningStarted.promise;
    const queuedPrepared = deferred<void>();
    const queued = coordinator.run("queued", async ({ runAnalysis }) => {
      queuedPrepared.resolve();
      return runAnalysis(queuedWork);
    });
    await queuedPrepared.promise;

    const closing = coordinator.close();
    const closingAgain = coordinator.close();
    expect(closingAgain).toBe(closing);
    await expect(running).rejects.toBeInstanceOf(AnalysisCoordinatorClosedError);
    await expect(queued).rejects.toBeInstanceOf(AnalysisCoordinatorClosedError);
    expect(runningSignal?.aborted).toBe(true);
    expect(runningSignal?.reason).toBeInstanceOf(AnalysisCoordinatorClosedError);
    expect(queuedWork).not.toHaveBeenCalled();

    let closeResolved = false;
    void closing.then(() => {
      closeResolved = true;
    });
    await flushMicrotasks();
    expect(closeResolved).toBe(false);

    runningRelease.resolve();
    await closing;
    expect(closeResolved).toBe(true);
    await expect(coordinator.run("later", async () => "later")).rejects.toBeInstanceOf(
      AnalysisCoordinatorClosedError,
    );
  });

  it("close rejects a waiter still draining progress after its worker settled", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const progressStarted = deferred<void>();
    const releaseProgress = deferred<void>();
    const result = coordinator.run<string, string>(
      "settling-waiter",
      ({ report }) => {
        report("publish");
        return "must not publish";
      },
      {
        onProgress: async () => {
          progressStarted.resolve();
          await releaseProgress.promise;
        },
      },
    );
    await progressStarted.promise;
    await flushMicrotasks();

    const rejection = expect(result).rejects.toBeInstanceOf(AnalysisCoordinatorClosedError);
    await coordinator.close();
    await rejection;
    releaseProgress.resolve();
    await flushMicrotasks();
  });

  it("uses the explicit limit and rejects invalid limits", async () => {
    expect(() => new AnalysisCoordinator({ maxConcurrentAnalyses: 0 })).toThrow(RangeError);
    expect(() => new AnalysisCoordinator({ maxConcurrentAnalyses: 1.5 })).toThrow(RangeError);
    expect(() => new AnalysisCoordinator({
      maxConcurrentAnalyses: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow("maxConcurrentAnalyses must be a positive integer");
    expect(() => new AnalysisCoordinator({
      maxConcurrentAnalyses: 1,
      maxConcurrentPreparations: 0,
    })).toThrow("maxConcurrentPreparations must be a positive integer");
    expect(() => new AnalysisCoordinator({
      maxConcurrentAnalyses: 1,
      maxQueuedAnalyses: -1,
    })).toThrow("maxQueuedAnalyses must be a non-negative integer");
    expect(() => new AnalysisCoordinator({
      maxConcurrentAnalyses: 1,
      maxQueuedPreparations: 1.5,
    })).toThrow("maxQueuedPreparations must be a non-negative integer");

    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const releases = [deferred<void>(), deferred<void>(), deferred<void>()];
    const starts: number[] = [];
    const jobs = releases.map((release, index) => coordinator.run(String(index), ({ runAnalysis }) =>
      runAnalysis(async () => {
        starts.push(index);
        await release.promise;
        return index;
      })));
    await flushMicrotasks();
    expect(starts).toEqual([0, 1]);
    releases[0]!.resolve();
    await expect(jobs[0]).resolves.toBe(0);
    await flushMicrotasks();
    expect(starts).toEqual([0, 1, 2]);
    releases[1]!.resolve();
    releases[2]!.resolve();
    await expect(Promise.all(jobs.slice(1))).resolves.toEqual([1, 2]);
    await coordinator.close();
  });

  it("allows sequential phases but rejects overlapping phases from one job", async () => {
    const coordinator = new AnalysisCoordinator({ maxConcurrentAnalyses: 2 });
    const release = deferred<void>();
    const firstStarted = deferred<void>();

    const result = coordinator.run("two-sided", async ({ runAnalysis }) => {
      const first = runAnalysis(async () => {
        firstStarted.resolve();
        await release.promise;
        return "head";
      });
      await firstStarted.promise;
      await expect(runAnalysis(async () => "overlap")).rejects.toThrow(
        "one coordinated job cannot run overlapping admitted phases",
      );
      release.resolve();
      expect(await first).toBe("head");
      return runAnalysis(async () => "merge-base");
    });

    await expect(result).resolves.toBe("merge-base");
    await coordinator.close();
  });
});

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await Promise.resolve();
  }
}
