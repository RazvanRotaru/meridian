import { describe, expect, it } from "vitest";
import { composeCausalSlice } from "./causal-flow";
import type { GraphEdge, GraphNode } from "./types";

function node(id: string, kind = "function"): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    location: { file: `${id}.ts`, startLine: 1 },
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  kind: string,
  extras: Partial<GraphEdge> = {},
): GraphEdge {
  return { id, source, target, kind, resolution: "resolved", ...extras };
}

function ids(slice: ReturnType<typeof composeCausalSlice>): string[] {
  return slice.nodes.map((entry) => entry.id);
}

describe("composeCausalSlice", () => {
  it("connects promise settlement to the callable waiting on that promise", () => {
    const nodes = [node("ack"), node("ready", "promise"), node("bootstrap")];
    const edges = [
      edge("settle", "ack", "ready", "resolvesPromise"),
      edge("wait", "bootstrap", "ready", "awaitsPromise"),
    ];

    const slice = composeCausalSlice({ nodes, edges, seedIds: ["ready"] });

    expect(ids(slice)).toEqual(["ack", "ready", "bootstrap"]);
    expect(slice.arcs).toEqual([
      expect.objectContaining({ edgeId: "settle", source: "ack", target: "ready", kind: "resolve", reversed: false }),
      expect.objectContaining({ edgeId: "wait", source: "ready", target: "bootstrap", kind: "await", reversed: true }),
    ]);
    expect(slice.truncated).toBe(false);
  });

  it("uses a returned Promise as a zero-cost resource alias for method selections", () => {
    const nodes = [
      node("ack"),
      node("ready", "promise"),
      node("waitForHookRegistration", "method"),
      node("bootstrap"),
    ];
    const edges = [
      edge("return", "waitForHookRegistration", "ready", "returnsPromise"),
      edge("settle", "ack", "ready", "resolvesPromise"),
      edge("await", "bootstrap", "ready", "awaitsPromise"),
    ];

    const slice = composeCausalSlice({
      nodes,
      edges,
      seedIds: ["waitForHookRegistration"],
    });

    expect(new Set(ids(slice))).toEqual(new Set(["ack", "ready", "waitForHookRegistration", "bootstrap"]));
    expect(slice.nodes.find((entry) => entry.id === "ready")).toEqual({
      id: "ready",
      backwardDepth: 0,
      forwardDepth: 0,
    });
    expect(slice.arcs).toEqual(expect.arrayContaining([
      expect.objectContaining({ edgeId: "return", kind: "alias", source: "waitForHookRegistration", target: "ready" }),
      expect.objectContaining({ edgeId: "settle", kind: "resolve", source: "ack", target: "ready" }),
      expect.objectContaining({ edgeId: "await", kind: "await", source: "ready", target: "bootstrap" }),
    ]));
  });

  it("joins IPC senders and handlers through the existing channel node", () => {
    const nodes = [node("sender"), node("ipc:electron/hooks", "channel"), node("handler")];
    const edges = [
      edge("send", "sender", "ipc:electron/hooks", "sends"),
      edge("handle", "ipc:electron/hooks", "handler", "handles"),
    ];

    const slice = composeCausalSlice({ nodes, edges, seedIds: ["ipc:electron/hooks"] });

    expect(ids(slice)).toEqual(["sender", "ipc:electron/hooks", "handler"]);
    expect(slice.arcs.map(({ source, target, kind }) => ({ source, target, kind }))).toEqual([
      { source: "sender", target: "ipc:electron/hooks", kind: "send" },
      { source: "ipc:electron/hooks", target: "handler", kind: "handle" },
    ]);
  });

  it("composes calls, IPC, promise settlement and awaiting into one causal path", () => {
    const orderedIds = ["trigger", "sender", "channel", "handler", "ack", "ready", "bootstrap", "restore"];
    const nodes = orderedIds.map((id) => node(id, id === "ready" ? "promise" : id === "channel" ? "channel" : "function"));
    const edges = [
      edge("1", "trigger", "sender", "calls"),
      edge("2", "sender", "channel", "sends"),
      edge("3", "channel", "handler", "handles"),
      edge("4", "handler", "ack", "calls"),
      edge("5", "ack", "ready", "resolvesPromise"),
      edge("6", "bootstrap", "ready", "awaitsPromise", {
        callSites: [{ file: "flow.ts", line: 20, col: 2, endLine: 20, endCol: 24 }],
      }),
      edge("7", "bootstrap", "restore", "calls", {
        callSites: [{ file: "flow.ts", line: 21, col: 2, endLine: 21, endCol: 11 }],
      }),
    ];

    const slice = composeCausalSlice({ nodes, edges, seedIds: ["ready"] });

    expect(ids(slice)).toEqual(orderedIds);
    expect(slice.arcs.map((arc) => arc.kind)).toEqual([
      "call",
      "send",
      "handle",
      "call",
      "resolve",
      "await",
      "call",
    ]);
    expect(slice.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(composeCausalSlice({ nodes: [...nodes].reverse(), edges: [...edges].reverse(), seedIds: ["ready"] }).fingerprint)
      .toBe(slice.fingerprint);
  });

  it("prefers a runtime channel delivery over setup and direct-test callers of the handler", () => {
    const callers = Array.from({ length: 20 }, (_, index) => node(`setup-${index}`));
    const nodes = [
      ...callers,
      node("sender"),
      node("channel", "channel"),
      node("handler"),
      node("ack"),
      node("ready", "promise"),
    ];
    const edges = [
      ...callers.map((caller, index) => edge(`setup-${index}`, caller.id, "handler", "calls")),
      edge("send", "sender", "channel", "sends"),
      edge("handle", "channel", "handler", "handles"),
      edge("dispatch", "handler", "ack", "calls"),
      edge("settle", "ack", "ready", "resolvesPromise"),
    ];

    const slice = composeCausalSlice(
      { nodes, edges, seedIds: ["ready"] },
      { maxNodes: 8 },
    );

    expect(ids(slice)).toEqual(["sender", "channel", "handler", "ack", "ready"]);
    expect(slice.arcs.map((arc) => arc.edgeId)).toEqual(["send", "handle", "dispatch", "settle"]);
    expect(slice.truncated).toBe(false);
  });

  it("uses source ranges to admit only effects after a Promise wait", () => {
    const nodes = [
      node("ack"),
      node("ready", "promise"),
      node("bootstrap"),
      node("beforeWait"),
      node("waitOperand"),
      node("afterWait"),
      node("nestedAfterWait"),
      node("sharedTarget"),
    ];
    const edges = [
      edge("settle", "ack", "ready", "resolvesPromise"),
      edge("wait", "bootstrap", "ready", "awaitsPromise", {
        callSites: [{ file: "flow.ts", line: 20, col: 2, endLine: 20, endCol: 24 }],
      }),
      edge("before", "bootstrap", "beforeWait", "calls", {
        callSites: [{ file: "flow.ts", line: 19, col: 2, endLine: 19, endCol: 14 }],
      }),
      // This is the call nested inside `await waitOperand()`, not a consequence of that wait.
      edge("operand", "bootstrap", "waitOperand", "calls", {
        callSites: [{ file: "flow.ts", line: 20, col: 8, endLine: 20, endCol: 24 }],
      }),
      // Same-line statements are orderable when the await has an exclusive end column.
      edge("after", "bootstrap", "afterWait", "calls", {
        callSites: [{ file: "flow.ts", line: 20, col: 26, endLine: 20, endCol: 37 }],
      }),
      // Once afterWait is invoked, its body needs no call-site range relative to bootstrap's await.
      edge("nested", "afterWait", "nestedAfterWait", "calls"),
      // The same target is admitted through a genuinely downstream route. The rejected direct
      // pre-wait edge must not reappear merely because both of its endpoints are now in the slice.
      edge("shared-before", "bootstrap", "sharedTarget", "calls", {
        callSites: [{ file: "flow.ts", line: 18, col: 2, endLine: 18, endCol: 14 }],
      }),
      edge("shared-after", "afterWait", "sharedTarget", "calls"),
    ];

    const slice = composeCausalSlice({ nodes, edges, seedIds: ["ready"] });

    expect(new Set(ids(slice))).toEqual(new Set([
      "ack",
      "ready",
      "bootstrap",
      "afterWait",
      "nestedAfterWait",
      "sharedTarget",
    ]));
    expect(ids(slice)).not.toContain("beforeWait");
    expect(ids(slice)).not.toContain("waitOperand");
    expect(slice.nodes.find((entry) => entry.id === "afterWait")?.forwardDepth).toBe(2);
    expect(slice.nodes.find((entry) => entry.id === "nestedAfterWait")?.forwardDepth).toBe(3);
    expect(slice.arcs.map((arc) => arc.edgeId)).not.toContain("shared-before");
    expect(slice.arcs.map((arc) => arc.edgeId)).toContain("shared-after");
  });

  it("stops forward effect expansion at an awaiter when source-order evidence is absent", () => {
    const nodes = [node("ready", "promise"), node("bootstrap"), node("unprovenConsequence")];
    const edges = [
      edge("wait", "bootstrap", "ready", "awaitsPromise"),
      edge("call", "bootstrap", "unprovenConsequence", "calls", {
        callSites: [{ file: "flow.ts", line: 30 }],
      }),
    ];

    const slice = composeCausalSlice({ nodes, edges, seedIds: ["ready"] });

    expect(ids(slice)).toEqual(["ready", "bootstrap"]);
    expect(slice.arcs).toEqual([
      expect.objectContaining({ edgeId: "wait", source: "ready", target: "bootstrap" }),
    ]);
    expect(slice.truncated).toBe(false);
  });

  it("terminates on cycles without claiming truncation", () => {
    const nodes = [node("a"), node("b"), node("ready", "promise")];
    const edges = [
      edge("ab", "a", "b", "calls"),
      edge("ba", "b", "a", "calls"),
      edge("settle", "b", "ready", "resolvesPromise"),
    ];

    const slice = composeCausalSlice({ nodes, edges, seedIds: ["ready"] });

    expect(new Set(ids(slice))).toEqual(new Set(["a", "b", "ready"]));
    expect(slice.arcs).toHaveLength(3);
    expect(slice.truncated).toBe(false);
  });

  it("preserves candidate confidence and supports a minimum confidence threshold", () => {
    const nodes = [node("sender"), node("channel", "channel"), node("handler")];
    const edges = [
      edge("candidate-send", "sender", "channel", "sends", { resolution: "unresolved", confidence: 0.65 }),
      edge("candidate-handle", "channel", "handler", "handles", { resolution: "unresolved", confidence: 0.65 }),
    ];

    const included = composeCausalSlice(
      { nodes, edges, seedIds: ["channel"] },
      { minConfidence: 0.6 },
    );
    const filtered = composeCausalSlice(
      { nodes, edges, seedIds: ["channel"] },
      { minConfidence: 0.7 },
    );

    expect(ids(included)).toEqual(["sender", "channel", "handler"]);
    expect(included.confidence).toBe(0.65);
    expect(included.arcs.every((arc) => arc.confidence === 0.65)).toBe(true);
    expect(ids(filtered)).toEqual(["channel"]);
    expect(filtered.arcs).toEqual([]);
    expect(filtered.confidence).toBe(1);
  });

  it("marks slices truncated when depth or node bounds omit reachable nodes", () => {
    const nodes = [node("a"), node("b"), node("c"), node("ready", "promise")];
    const edges = [
      edge("ab", "a", "b", "calls"),
      edge("bc", "b", "c", "calls"),
      edge("settle", "c", "ready", "resolvesPromise"),
    ];

    const depthBound = composeCausalSlice(
      { nodes, edges, seedIds: ["ready"] },
      { maxDepth: 1 },
    );
    const nodeBound = composeCausalSlice(
      { nodes, edges, seedIds: ["ready"] },
      { maxNodes: 2 },
    );
    const forwardBound = composeCausalSlice(
      {
        nodes: [node("channel", "channel"), node("handler"), node("effect")],
        edges: [
          edge("deliver", "channel", "handler", "handles"),
          edge("effect", "handler", "effect", "calls"),
        ],
        seedIds: ["channel"],
      },
      { maxDepth: 1 },
    );

    expect(ids(depthBound)).toEqual(["c", "ready"]);
    expect(depthBound.truncated).toBe(true);
    expect(depthBound.truncationFrontier).toEqual({ backward: ["c"], forward: [] });
    expect(ids(nodeBound)).toEqual(["c", "ready"]);
    expect(nodeBound.truncated).toBe(true);
    expect(nodeBound.truncationFrontier).toEqual({ backward: ["c"], forward: [] });
    expect(ids(forwardBound)).toEqual(["channel", "handler"]);
    expect(forwardBound.truncationFrontier).toEqual({ backward: [], forward: ["handler"] });
  });
});
