import { describe, expect, it } from "vitest";
import { LatestOnlyLayoutCoordinator } from "./latestOnlyLayoutCoordinator";

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

describe("LatestOnlyLayoutCoordinator", () => {
  it("keeps one active-plus-latest owner across structural lens navigation", async () => {
    const activeGate = deferred();
    const latestGate = deferred();
    const started: string[] = [];
    const coordinator = new LatestOnlyLayoutCoordinator();

    const module = coordinator.run("module", async () => {
      started.push("module");
      await activeGate.promise;
    });
    const logic = coordinator.run("logic", async () => { started.push("logic"); });
    const minimal = coordinator.run("minimal", async () => { started.push("minimal"); });
    const latest = coordinator.run("module", async () => {
      started.push("latest-module");
      await latestGate.promise;
    });

    await expect(logic).resolves.toBe("superseded");
    await expect(minimal).resolves.toBe("superseded");
    expect(started).toEqual(["module"]);

    activeGate.resolve();
    await expect(module).resolves.toBe("superseded");
    await flushMicrotasks();
    expect(started).toEqual(["module", "latest-module"]);

    latestGate.resolve();
    await expect(latest).resolves.toBe("completed");
  });

  it("cancels outgoing projection owners while retaining explicit install consumers", async () => {
    const structuralGate = deferred();
    const flowGate = deferred();
    const structuralSignals: AbortSignal[] = [];
    const flowSignals: AbortSignal[] = [];
    const coordinator = new LatestOnlyLayoutCoordinator();

    const logic = coordinator.run("logic", async (signal) => {
      structuralSignals.push(signal);
      await structuralGate.promise;
    });
    const flow = coordinator.run("flow-pane", async (signal) => {
      flowSignals.push(signal);
      await flowGate.promise;
    });

    // The new projection was installed for the visible flow pane, not for the outgoing Logic lens.
    coordinator.cancelAllExcept(new Set(["flow-pane"]));
    expect(structuralSignals[0]?.aborted).toBe(true);
    expect(flowSignals[0]?.aborted).toBe(false);

    structuralGate.resolve();
    flowGate.resolve();
    await expect(logic).resolves.toBe("cancelled");
    await expect(flow).resolves.toBe("completed");
  });

  it("disposes structural and concurrently visible flow-pane pending ownership", async () => {
    const structuralGate = deferred();
    const flowGate = deferred();
    const coordinator = new LatestOnlyLayoutCoordinator();
    const structural = coordinator.run("module", async () => { await structuralGate.promise; });
    const structuralPending = coordinator.run("minimal", async () => {});
    const flow = coordinator.run("flow-pane", async () => { await flowGate.promise; });
    const flowPending = coordinator.run("flow-pane", async () => {});

    coordinator.dispose();
    await expect(structuralPending).resolves.toBe("disposed");
    await expect(flowPending).resolves.toBe("disposed");

    structuralGate.resolve();
    flowGate.resolve();
    await expect(structural).resolves.toBe("superseded");
    await expect(flow).resolves.toBe("superseded");
  });
});
