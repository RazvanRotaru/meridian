import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import { runElkLayout } from "../layout/elkLayout";
import { ALPHA_RUN, freshStore } from "../parity/surfaceFixture";

const layoutControl = vi.hoisted(() => ({
  gates: [] as Promise<void>[],
}));

vi.mock("../layout/elkLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../layout/elkLayout")>();
  return {
    ...actual,
    runElkLayout: vi.fn(async (graph: ElkNode) => {
      const gate = layoutControl.gates.shift();
      if (gate !== undefined) await gate;
      return actual.runElkLayout(graph);
    }),
  };
});

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  layoutControl.gates.length = 0;
  vi.mocked(runElkLayout).mockClear();
});

describe("store layout ownership", () => {
  it("does not commit an outgoing Map result after rapid navigation to Logic", async () => {
    const moduleGate = deferred();
    const logicGate = deferred();
    layoutControl.gates.push(moduleGate.promise, logicGate.promise);
    const store = freshStore();

    const moduleLayout = store.getState().moduleRelayout({ label: "outgoing Map" });
    await vi.waitFor(() => expect(runElkLayout).toHaveBeenCalledTimes(1));

    store.setState({ logicRoot: ALPHA_RUN });
    store.getState().setViewMode("logic");
    moduleGate.resolve();

    await vi.waitFor(() => expect(runElkLayout).toHaveBeenCalledTimes(2));
    expect(store.getState().moduleRfNodes).toEqual([]);
    expect(store.getState().moduleRfEdges).toEqual([]);

    logicGate.resolve();
    await moduleLayout;
    await vi.waitFor(() => expect(store.getState().logicLayoutStatus).toBe("ready"));
    expect(store.getState().logicRfNodes.length).toBeGreaterThan(0);
    expect(store.getState().moduleRfNodes).toEqual([]);
  });
});
