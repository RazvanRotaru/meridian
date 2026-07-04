import { describe, expect, it } from "vitest";
import type { EdgeResolution, FlowPath, FlowStep, LogicFlows } from "@meridian/core";
import type { GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { collectModuleDefinitions, definitionNodeData, deriveLogicGraph, deriveLogicGraphFromBodies } from "./logicGraph";

/** A GraphIndex stub: deriveLogicGraph only reads nodesById + ancestorsOf. */
function makeIndex(entries: Array<{ id: string; name: string; kind: string; parentId: string | null }>): GraphIndex {
  const nodesById = new Map<string, GraphNode>(
    entries.map((e) => [
      e.id,
      { id: e.id, kind: e.kind, displayName: e.name, qualifiedName: e.name, parentId: e.parentId, location: { file: "", startLine: 1 } } as GraphNode,
    ]),
  );
  const parentOf = new Map(entries.map((e) => [e.id, e.parentId]));
  const childrenByParent = new Map<string, GraphNode[]>();
  for (const e of entries) {
    if (e.parentId === null) continue;
    const node = nodesById.get(e.id)!;
    childrenByParent.set(e.parentId, [...(childrenByParent.get(e.parentId) ?? []), node]);
  }
  const ancestorsOf = (id: string): GraphNode[] => {
    const path: GraphNode[] = [];
    const seen = new Set<string>();
    let cur: string | null | undefined = id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const node = nodesById.get(cur);
      if (node) path.push(node);
      cur = parentOf.get(cur) ?? null;
    }
    return path.reverse();
  };
  const childrenOf = (id: string): GraphNode[] => childrenByParent.get(id) ?? [];
  return { nodesById, ancestorsOf, childrenOf } as unknown as GraphIndex;
}

const call = (label: string, target: string | null, resolution: EdgeResolution): FlowStep => ({ kind: "call", label, target, resolution });
const NONE = new Set<string>();

describe("deriveLogicGraph", () => {
  it("emits a call sequence as block nodes chained by seq edges in order", () => {
    const flows: LogicFlows = { r: [call("a", "ext:lib#a", "external"), call("b", "ext:lib#b", "external")] };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    expect(nodes.map((n) => n.type)).toEqual(["block", "block"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "r::0", target: "r::1", kind: "seq" });
  });

  it("marks a resolved call with its own flow expandable, and greys a leaf", () => {
    const flows: LogicFlows = { r: [call("fn", "ts:src/m.ts#fn", "resolved"), call("x", "ext:lib#x", "external")], "ts:src/m.ts#fn": [call("y", null, "unresolved")] };
    const index = makeIndex([{ id: "ts:src/m.ts#fn", name: "fn", kind: "function", parentId: "ts:src/m.ts" }, { id: "ts:src/m.ts", name: "m.ts", kind: "module", parentId: "pkg" }, { id: "pkg", name: "app", kind: "package", parentId: null }]);
    const { nodes } = deriveLogicGraph("r", flows, index, NONE, { hideGreyed: false });
    const fn = nodes.find((n) => n.id === "r::0")!;
    const leaf = nodes.find((n) => n.id === "r::1")!;
    expect(fn.data).toMatchObject({ expandable: true, greyed: false, isContainer: false, provenance: { pkg: "app", module: "m.ts" } });
    expect(leaf.data).toMatchObject({ expandable: false, greyed: true });
    // collapsed leaves get a smaller box than normal blocks
    expect(leaf.width!).toBeLessThan(fn.width!);
  });

  it("nests an expandable call's flow as children only when expanded", () => {
    const flows: LogicFlows = { r: [call("fn", "ts:m#fn", "resolved")], "ts:m#fn": [call("y", "ext:l#y", "external")] };
    const index = makeIndex([{ id: "ts:m#fn", name: "fn", kind: "function", parentId: null }]);
    const collapsed = deriveLogicGraph("r", flows, index, NONE, { hideGreyed: false });
    expect(collapsed.nodes).toHaveLength(1);
    const expanded = deriveLogicGraph("r", flows, index, new Set(["r::0"]), { hideGreyed: false });
    expect(expanded.nodes).toHaveLength(2);
    const child = expanded.nodes.find((n) => n.id !== "r::0")!;
    expect(child.parentId).toBe("r::0");
    expect(expanded.nodes.find((n) => n.id === "r::0")!.data.isContainer).toBe(true);
  });

  it("renders a loop as a default-expanded container with nested children", () => {
    const loop: FlowStep = { kind: "loop", label: "for each x", body: [call("step", "ext:l#s", "external")] };
    const { nodes } = deriveLogicGraph("r", { r: [loop] }, makeIndex([]), NONE, { hideGreyed: false });
    const container = nodes.find((n) => n.id === "r::0")!;
    expect(container).toMatchObject({ type: "control", data: { logicKind: "loop", isContainer: true, expandable: true } });
    expect(nodes.find((n) => n.parentId === "r::0")).toBeTruthy();
  });

  it("renders an if as a branch node with then/else edges that merge into the following step", () => {
    const branch: FlowStep = { kind: "branch", label: "if cond", paths: [{ label: "then", body: [call("t", "ext:l#t", "external")] }, { label: "else", body: [] }] };
    const flows: LogicFlows = { r: [branch, call("after", "ext:l#a", "external")] };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    const ifNode = nodes.find((n) => n.id === "r::0")!;
    expect(ifNode).toMatchObject({ type: "branch", data: { logicKind: "if", isContainer: false } });
    const thenNode = nodes.find((n) => n.id === "r::0/b0/0")!;
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: thenNode.id, kind: "branch", label: "then" }));
    // then-path last node merges into `after`; the empty else wires the branch straight to `after`.
    const after = nodes.find((n) => n.id === "r::1")!;
    expect(edges).toContainEqual(expect.objectContaining({ source: thenNode.id, target: after.id, kind: "seq" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: after.id, kind: "branch", label: "else" }));
  });

  it("renders try/catch as a container, not a branch node", () => {
    const tryStep: FlowStep = { kind: "branch", label: "try/catch", paths: [{ label: "try", body: [call("t", "ext:l#t", "external")] }, { label: "catch e", body: [call("c", "ext:l#c", "external")] }] };
    const { nodes } = deriveLogicGraph("r", { r: [tryStep] }, makeIndex([]), NONE, { hideGreyed: false });
    const container = nodes.find((n) => n.id === "r::0")!;
    expect(container).toMatchObject({ type: "control", data: { logicKind: "try", isContainer: true } });
    expect(nodes.filter((n) => n.parentId === "r::0")).toHaveLength(2);
  });

  it("carries a container's bodies on its node so a dive can re-chart them", () => {
    const tryStep: FlowStep = {
      kind: "branch",
      label: "try/catch",
      paths: [{ label: "try", body: [call("t", "ext:l#t", "external")] }, { label: "catch e", body: [call("c", "ext:l#c", "external")] }],
    };
    const loop: FlowStep = { kind: "loop", label: "for each x", body: [call("s", "ext:l#s", "external")] };
    const { nodes } = deriveLogicGraph("r", { r: [tryStep, loop] }, makeIndex([]), NONE, { hideGreyed: false });
    const tryNode = nodes.find((n) => n.id === "r::0")!;
    const loopNode = nodes.find((n) => n.id === "r::1")!;
    // try node carries all its arms; loop node carries its single body labeled with the loop label.
    expect(tryNode.data.bodies?.map((b) => b.label)).toEqual(["try", "catch e"]);
    expect(loopNode.data.bodies?.map((b) => b.label)).toEqual(["for each x"]);
    // a plain call carries none — only control containers do.
    expect(nodes.find((n) => n.type === "block")?.data.bodies).toBeUndefined();
  });

  it("deriveLogicGraphFromBodies renders each body as an independent, prefixed top-level chain", () => {
    // A try's arms dived into: the try body has two steps (chained), the catch has one.
    const bodies: FlowPath[] = [
      { label: "try", body: [call("a", "ext:l#a", "external"), call("b", "ext:l#b", "external")] },
      { label: "catch e", body: [call("c", "ext:l#c", "external")] },
    ];
    const { nodes, edges } = deriveLogicGraphFromBodies("r::0", bodies, {}, makeIndex([]), NONE, { hideGreyed: false });
    // ids are namespaced by the prefix and per-body (p0/p1); every node stays top-level.
    expect(nodes.map((n) => n.id)).toEqual(["r::0::p0/0", "r::0::p0/1", "r::0::p1/0"]);
    expect(nodes.every((n) => n.type === "block" && n.parentId === null)).toBe(true);
    // The two bodies are independent: one seq edge chains WITHIN the try body, none crosses to catch.
    expect(edges).toEqual([expect.objectContaining({ source: "r::0::p0/0", target: "r::0::p0/1", kind: "seq" })]);
  });

  it("tags call steps function vs method (resolved target kind, else a receiver in the label)", () => {
    const flows: LogicFlows = {
      r: [
        call("fn", "ext:l#fn", "external"), //           free function: no receiver, no method target
        call("store.select", "ext:l#s", "external"), //  receiver in the label ⇒ method
        call("run", "ts:m#C.run", "resolved"), //        resolved target IS a method ⇒ method (label has no dot)
      ],
    };
    const index = makeIndex([{ id: "ts:m#C.run", name: "run", kind: "method", parentId: null }]);
    const { nodes } = deriveLogicGraph("r", flows, index, NONE, { hideGreyed: false });
    expect(nodes.find((n) => n.id === "r::0")!.data.callKind).toBe("function");
    expect(nodes.find((n) => n.id === "r::1")!.data.callKind).toBe("method");
    expect(nodes.find((n) => n.id === "r::2")!.data.callKind).toBe("method");
  });

  it("hideGreyed drops greyed leaves and stitches the sequence around them", () => {
    const flows: LogicFlows = {
      r: [call("fn", "ts:m#fn", "resolved"), call("grey", "ext:l#g", "external"), call("fn2", "ts:m#fn2", "resolved")],
      "ts:m#fn": [call("y", null, "unresolved")],
      "ts:m#fn2": [call("z", null, "unresolved")],
    };
    const index = makeIndex([{ id: "ts:m#fn", name: "fn", kind: "function", parentId: null }, { id: "ts:m#fn2", name: "fn2", kind: "function", parentId: null }]);
    const { nodes, edges } = deriveLogicGraph("r", flows, index, NONE, { hideGreyed: true });
    expect(nodes.map((n) => n.id)).toEqual(["r::0", "r::2"]);
    expect(edges).toEqual([expect.objectContaining({ source: "r::0", target: "r::2", kind: "seq" })]);
  });
});

describe("collectModuleDefinitions", () => {
  it("collects callables nested under object/class methods recursively, sorted by name", () => {
    // A module owning a top-level function and an object literal whose methods are nested one level
    // deeper — collection must recurse to reach `mw.startExecution`, not just scan direct children.
    const index = makeIndex([
      { id: "ts:m.ts", name: "m.ts", kind: "module", parentId: null },
      { id: "ts:m.ts#run", name: "run", kind: "function", parentId: "ts:m.ts" },
      { id: "ts:m.ts#mw", name: "mw", kind: "variable", parentId: "ts:m.ts" },
      { id: "ts:m.ts#mw.startExecution", name: "startExecution", kind: "method", parentId: "ts:m.ts#mw" },
      { id: "ts:m.ts#mw.endExecution", name: "endExecution", kind: "method", parentId: "ts:m.ts#mw" },
    ]);
    // Sorted by display name (endExecution < run < startExecution). The `mw` variable is not a
    // callable so it's excluded, and the module itself is never included.
    expect(collectModuleDefinitions(index, "ts:m.ts")).toEqual([
      "ts:m.ts#mw.endExecution",
      "ts:m.ts#run",
      "ts:m.ts#mw.startExecution",
    ]);
  });

  it("returns an empty list for a module with no defined callables", () => {
    const index = makeIndex([{ id: "ts:empty.ts", name: "empty.ts", kind: "module", parentId: null }]);
    expect(collectModuleDefinitions(index, "ts:empty.ts")).toEqual([]);
  });
});

describe("definitionNodeData", () => {
  const index = makeIndex([
    { id: "ts:m.ts", name: "m.ts", kind: "module", parentId: null },
    { id: "ts:m.ts#mw", name: "mw", kind: "variable", parentId: "ts:m.ts" },
    { id: "ts:m.ts#mw.startExecution", name: "startExecution", kind: "method", parentId: "ts:m.ts#mw" },
    { id: "ts:m.ts#leaf", name: "leaf", kind: "function", parentId: "ts:m.ts" },
  ]);

  it("targets the callable, is expandable when it has a flow, and reads as owner › name", () => {
    const flows: LogicFlows = { "ts:m.ts#mw.startExecution": [call("x", "ext:l#x", "external")] };
    const data = definitionNodeData("ts:m.ts#mw.startExecution", flows, index);
    expect(data).toMatchObject({
      logicKind: "call",
      definition: true,
      targetId: "ts:m.ts#mw.startExecution",
      resolution: "resolved",
      greyed: false,
      isContainer: false,
      expandable: true,
      childCount: 1,
      label: "startExecution",
      provenance: { pkg: "mw", module: "startExecution" }, // owning object › method name
    });
  });

  it("is not expandable when the callable ships no flow", () => {
    const data = definitionNodeData("ts:m.ts#leaf", {}, index);
    expect(data).toMatchObject({ definition: true, expandable: false, childCount: 0, greyed: false });
  });
});
