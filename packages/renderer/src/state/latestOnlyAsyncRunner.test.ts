import { describe, expect, it } from "vitest";
import { LatestOnlyAsyncRunner } from "./latestOnlyAsyncRunner";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("LatestOnlyAsyncRunner", () => {
  it("executes only the active and latest request across any number of supersessions", async () => {
    const activeGate = deferred();
    const latestGate = deferred();
    const started: number[] = [];
    const signals = new Map<number, AbortSignal>();
    const runner = new LatestOnlyAsyncRunner<number>(async (input, signal) => {
      started.push(input);
      signals.set(input, signal);
      await (input === 0 ? activeGate.promise : latestGate.promise);
    });

    const active = runner.run(0);
    const superseded = Array.from({ length: 50 }, (_, index) => runner.run(index + 1));

    expect(started).toEqual([0]);
    expect(signals.get(0)?.aborted).toBe(true);
    await expect(Promise.all(superseded.slice(0, -1))).resolves.toEqual(
      Array.from({ length: 49 }, () => "superseded"),
    );

    activeGate.resolve();
    await expect(active).resolves.toBe("superseded");
    await flushMicrotasks();
    expect(started).toEqual([0, 50]);
    expect(signals.get(50)?.aborted).toBe(false);

    latestGate.resolve();
    await expect(superseded.at(-1)).resolves.toBe("completed");
  });

  it("keeps one global active-plus-latest bound across structural lens changes", async () => {
    type Lens = "module" | "logic" | "minimal";
    interface LayoutRequest { lens: Lens; id: number }
    const activeGate = deferred();
    const latestGate = deferred();
    const started: LayoutRequest[] = [];
    const runner = new LatestOnlyAsyncRunner<LayoutRequest>(async (request) => {
      started.push(request);
      await (request.id === 0 ? activeGate.promise : latestGate.promise);
    });

    const active = runner.run({ lens: "module", id: 0 });
    const logic = runner.run({ lens: "logic", id: 1 });
    const minimal = runner.run({ lens: "minimal", id: 2 });
    const latest = runner.run({ lens: "module", id: 3 });

    await expect(logic).resolves.toBe("superseded");
    await expect(minimal).resolves.toBe("superseded");
    expect(started).toEqual([{ lens: "module", id: 0 }]);

    activeGate.resolve();
    await expect(active).resolves.toBe("superseded");
    await flushMicrotasks();
    expect(started).toEqual([
      { lens: "module", id: 0 },
      { lens: "module", id: 3 },
    ]);

    latestGate.resolve();
    await expect(latest).resolves.toBe("completed");
  });

  it("cancels pending input without starting it and accepts later work", async () => {
    const activeGate = deferred();
    const laterGate = deferred();
    const started: string[] = [];
    const runner = new LatestOnlyAsyncRunner<string>(async (input) => {
      started.push(input);
      await (input === "active" ? activeGate.promise : laterGate.promise);
    });

    const active = runner.run("active");
    const pending = runner.run("pending");
    runner.cancel();

    await expect(pending).resolves.toBe("cancelled");
    expect(started).toEqual(["active"]);
    activeGate.resolve();
    await expect(active).resolves.toBe("superseded");

    const later = runner.run("later");
    expect(started).toEqual(["active", "later"]);
    laterGate.resolve();
    await expect(later).resolves.toBe("completed");
  });

  it("dispose releases pending work and permanently rejects new ownership", async () => {
    const activeGate = deferred();
    const started: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const runner = new LatestOnlyAsyncRunner<string>(async (input, signal) => {
      started.push(input);
      signals.set(input, signal);
      await activeGate.promise;
    });

    const active = runner.run("active");
    const pending = runner.run("pending");
    runner.dispose();
    runner.dispose();

    await expect(pending).resolves.toBe("disposed");
    await expect(runner.run("after-dispose")).resolves.toBe("disposed");
    expect(started).toEqual(["active"]);
    expect(signals.get("active")?.aborted).toBe(true);

    activeGate.resolve();
    await expect(active).resolves.toBe("superseded");
    await flushMicrotasks();
    expect(started).toEqual(["active"]);
  });

  it("reports a current failure but absorbs a superseded job's late failure", async () => {
    const activeGate = deferred();
    const activeFailure = new Error("obsolete failed late");
    const currentFailure = new Error("current failed");
    const runner = new LatestOnlyAsyncRunner<string>(async (input) => {
      if (input === "obsolete") {
        await activeGate.promise;
        throw activeFailure;
      }
      throw currentFailure;
    });

    const obsolete = runner.run("obsolete");
    const current = runner.run("current");
    activeGate.resolve();

    await expect(obsolete).resolves.toBe("superseded");
    await expect(current).rejects.toBe(currentFailure);
  });
});
