import { describe, expect, it } from "vitest";
import type { EdgeResolution, FlowPath, FlowStep, LogicFlows } from "@meridian/core";
import type { GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { collectModuleDefinitions, definitionNodeData, deriveLogicGraph, deriveLogicGraphFromBodies, type LogicNodeData } from "./logicGraph";

/** A GraphIndex stub: deriveLogicGraph reads nodesById + ancestorsOf + changed status (entry cap). */
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
  return {
    nodesById,
    ancestorsOf,
    childrenOf,
    changedIds: new Set<string>(),
    changedStatus: new Map(),
  } as unknown as GraphIndex;
}

const call = (label: string, target: string | null, resolution: EdgeResolution): FlowStep => ({ kind: "call", label, target, resolution });
const NONE = new Set<string>();

// A spec node's `data` is now `LogicNodeData | TerminalData`; every node these assertions touch is a
// real exec node (never a terminal end-cap), so narrow to the exec shape for the property reads.
const execData = (node: { data: unknown }): LogicNodeData => node.data as LogicNodeData;

describe("deriveLogicGraph", () => {
  it("emits a call sequence as block nodes chained by seq edges in order", () => {
    const flows: LogicFlows = { r: [call("a", "ext:lib#a", "external"), call("b", "ext:lib#b", "external")] };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    expect(nodes.map((n) => n.type)).toEqual(["block", "block"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "r::0", target: "r::1", kind: "seq" });
  });

  it("marks a resolved call with its own flow expandable, and compacts an external leaf", () => {
    const flows: LogicFlows = { r: [call("fn", "ts:src/m.ts#fn", "resolved"), call("x", "ext:lib#x", "external")], "ts:src/m.ts#fn": [call("y", null, "unresolved")] };
    const index = makeIndex([{ id: "ts:src/m.ts#fn", name: "fn", kind: "function", parentId: "ts:src/m.ts" }, { id: "ts:src/m.ts", name: "m.ts", kind: "module", parentId: "pkg" }, { id: "pkg", name: "app", kind: "package", parentId: null }]);
    const { nodes } = deriveLogicGraph("r", flows, index, NONE, { hideGreyed: false });
    const fn = nodes.find((n) => n.id === "r::0")!;
    const leaf = nodes.find((n) => n.id === "r::1")!;
    expect(fn.data).toMatchObject({ navigable: true, expandable: true, compact: false, callScope: "internal", greyed: false, isContainer: false, provenance: { pkg: "app", module: "m.ts" } });
    expect(leaf.data).toMatchObject({ navigable: false, expandable: false, compact: true, callScope: "external", greyed: false });
    // Compactness — not greying/externality — gives leaves their smaller box.
    expect(leaf.width!).toBeLessThan(fn.width!);
  });

  it("keeps compactness independent from internal/external/unresolved call scope", () => {
    const flows: LogicFlows = {
      r: [
        call("service.leaf", "ts:m#leaf", "resolved"),
        call("console.log", "ext:console#log", "external"),
        call("dynamic", null, "unresolved"),
      ],
    };
    const index = makeIndex([{ id: "ts:m#leaf", name: "leaf", kind: "method", parentId: null }]);
    const { nodes } = deriveLogicGraph("r", flows, index, NONE, { hideGreyed: false });
    expect(execData(nodes[0])).toMatchObject({ navigable: true, expandable: false, compact: true, callScope: "internal", resolution: "resolved", greyed: false });
    expect(execData(nodes[1])).toMatchObject({ navigable: false, expandable: false, compact: true, callScope: "external", resolution: "external", greyed: false });
    expect(execData(nodes[2])).toMatchObject({ navigable: false, expandable: false, compact: true, callScope: "unresolved", resolution: "unresolved", greyed: true });
    // Every one of these leaves carries a provenance row, so its layout reserves both rows.
    expect(new Set(nodes.map((node) => node.height))).toEqual(new Set([42]));
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
    const branchSource = { file: "src/a.ts", line: 4, col: 2, endLine: 8, endCol: 3 };
    const thenSource = { file: "src/a.ts", line: 4, col: 12, endLine: 6, endCol: 3 };
    const elseSource = { file: "src/a.ts", line: 6, col: 8, endLine: 8, endCol: 3 };
    const branch: FlowStep = {
      kind: "branch",
      branchKind: "if",
      label: "if cond",
      source: branchSource,
      paths: [
        { label: "then", role: "then", pathId: "then", source: thenSource, body: [call("t", "ext:l#t", "external")] },
        { label: "else", role: "else", pathId: "else", source: elseSource, body: [] },
      ],
    };
    const flows: LogicFlows = { r: [branch, call("after", "ext:l#a", "external")] };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    const ifNode = nodes.find((n) => n.id === "r::0")!;
    expect(ifNode).toMatchObject({
      type: "branch",
      data: {
        logicKind: "if",
        branchKind: "if",
        branchSource,
        isContainer: false,
        branchPorts: [
          { id: "r::0::port/0", label: "then", role: "then", order: 0, pathId: "then", source: thenSource },
          { id: "r::0::port/1", label: "else", role: "else", order: 1, pathId: "else", source: elseSource },
        ],
      },
    });
    const thenNode = nodes.find((n) => n.id === "r::0/b0/0")!;
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: thenNode.id, kind: "branch", label: "then", sourcePort: "r::0::port/0" }));
    // Both live arms converge at an explicit join; only that join continues to `after`.
    const join = nodes.find((n) => n.id === "r::0::join")!;
    expect(join).toMatchObject({ type: "join", width: 42, data: { logicKind: "join", childCount: 2 } });
    const after = nodes.find((n) => n.id === "r::1")!;
    expect(edges).toContainEqual(expect.objectContaining({ source: thenNode.id, target: join.id, kind: "seq" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: join.id, kind: "branch", label: "else", sourcePort: "r::0::port/1" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: join.id, target: after.id, kind: "seq" }));
  });

  it("renders ordinary try/catch as explicit normal/error lanes with stable pins and a join", () => {
    const tryStep: FlowStep = {
      kind: "branch",
      branchKind: "try",
      label: "try/catch",
      paths: [
        { label: "try", role: "try", body: [call("t", "ext:l#t", "external")] },
        { label: "catch e", role: "catch", body: [call("c", "ext:l#c", "external")] },
      ],
    };
    const { nodes, edges } = deriveLogicGraph("r", { r: [tryStep, call("after", "ext:l#after", "external")] }, makeIndex([]), NONE, { hideGreyed: false });
    const split = nodes.find((n) => n.id === "r::0")!;
    expect(split).toMatchObject({
      type: "exception",
      data: {
        logicKind: "try",
        isContainer: false,
        expandable: false,
        branchPorts: [
          { id: "r::0::port/0", label: "try", role: "try", order: 0 },
          { id: "r::0::port/1", label: "catch e", role: "catch", order: 1 },
        ],
      },
    });
    expect(nodes.filter((n) => n.parentId === "r::0")).toHaveLength(0);
    expect(nodes.map((n) => n.id)).toEqual(["r::0", "r::0/b0/0", "r::0/b1/0", "r::0::join", "r::1"]);
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: "r::0/b0/0", label: "try", sourcePort: "r::0::port/0", branchRole: "try" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: "r::0/b1/0", label: "catch e", sourcePort: "r::0::port/1", branchRole: "catch" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0/b0/0", target: "r::0::join", kind: "seq", branchRole: "try" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0/b1/0", target: "r::0::join", kind: "seq", branchRole: "catch" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0::join", target: "r::1", kind: "seq" }));
  });

  it("charts finally as one mandatory phase after the explicit try/catch lanes merge", () => {
    const tryFinally: FlowStep = {
      kind: "branch",
      branchKind: "try",
      label: "try/catch",
      paths: [
        { label: "try", role: "try", body: [call("t", "ext:l#t", "external")] },
        { label: "catch e", role: "catch", body: [call("c", "ext:l#c", "external")] },
        { label: "finally", role: "finally", body: [call("cleanup", "ext:l#cleanup", "external")] },
      ],
    };
    const loop: FlowStep = { kind: "loop", label: "for each x", body: [call("s", "ext:l#s", "external")] };
    const { nodes, edges } = deriveLogicGraph("r", { r: [tryFinally, loop] }, makeIndex([]), NONE, { hideGreyed: false });
    const tryNode = nodes.find((n) => n.id === "r::0")!;
    const finallyNode = nodes.find((n) => n.id === "r::0::finally")!;
    const cleanup = nodes.find((n) => n.id === "r::0/finally/0")!;
    const loopNode = nodes.find((n) => n.id === "r::1")!;
    expect(tryNode).toMatchObject({ type: "exception", data: { logicKind: "try", isContainer: false } });
    expect(finallyNode).toMatchObject({ type: "finally", width: 118, height: 38, data: { logicKind: "finally", label: "finally · always" } });
    expect(cleanup).toMatchObject({ type: "block", data: { label: "cleanup" } });
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0::join", target: finallyNode.id, kind: "seq" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: finallyNode.id, target: cleanup.id, kind: "seq" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: cleanup.id, target: loopNode.id, kind: "seq" }));
    expect(edges.some((edge) => edge.source === "r::0::join" && edge.target === loopNode.id)).toBe(false);
    expect(execData(loopNode).bodies?.map((b) => b.label)).toEqual(["for each x"]);
  });

  it("retains the honest fallback when a protected return must be deferred through finally", () => {
    const tryFinally: FlowStep = {
      kind: "branch",
      branchKind: "try",
      label: "try/catch",
      paths: [
        { label: "try", role: "try", body: [call("t", "ext:l#t", "external"), { kind: "exit", variant: "return", label: "result" }] },
        { label: "catch e", role: "catch", body: [call("c", "ext:l#c", "external")] },
        { label: "finally", role: "finally", body: [call("cleanup", "ext:l#cleanup", "external")] },
      ],
    };
    const { nodes } = deriveLogicGraph("r", { r: [tryFinally] }, makeIndex([]), NONE, { hideGreyed: false });
    const fallback = nodes.find((node) => node.id === "r::0")!;
    expect(fallback).toMatchObject({ type: "control", data: { logicKind: "try", isContainer: true } });
    expect(execData(fallback).bodies?.map((body) => body.label)).toEqual(["try", "catch e", "finally"]);
    expect(nodes.some((node) => node.type === "finally")).toBe(false);
  });

  it("does not rejoin a try arm that exits; only the recovered catch route continues", () => {
    const tryStep: FlowStep = {
      kind: "branch",
      branchKind: "try",
      label: "try/catch",
      paths: [
        { label: "try", role: "try", body: [{ kind: "exit", variant: "return", label: "created" }] },
        { label: "catch error", role: "catch", body: [call("recover", "ext:l#recover", "external")] },
      ],
    };
    const { nodes, edges } = deriveLogicGraph("r", { r: [tryStep, call("after", "ext:l#after", "external")] }, makeIndex([]), NONE, { hideGreyed: false });
    expect(nodes.some((node) => node.id === "r::0::join")).toBe(false);
    expect(nodes.find((node) => node.id === "r::0/b0/0")).toMatchObject({ type: "terminal", data: { terminal: "return" } });
    expect(edges.some((edge) => edge.source === "r::0/b0/0")).toBe(false);
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0/b1/0", target: "r::1", kind: "seq", branchRole: "catch" }));
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
    expect(execData(nodes.find((n) => n.id === "r::0")!).callKind).toBe("function");
    expect(execData(nodes.find((n) => n.id === "r::1")!).callKind).toBe("method");
    expect(execData(nodes.find((n) => n.id === "r::2")!).callKind).toBe("method");
  });

  it("the legacy hideGreyed option drops compact leaves and stitches the sequence around them", () => {
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

  it("frames a callable flow with entry/exit terminals when withTerminals is set", () => {
    const flows: LogicFlows = { r: [call("a", "ext:l#a", "external"), call("b", "ext:l#b", "external")] };
    const index = makeIndex([{ id: "r", name: "handler", kind: "function", parentId: null }]);
    const { nodes, edges } = deriveLogicGraph("r", flows, index, NONE, { hideGreyed: false, withTerminals: true });
    expect(nodes.find((n) => n.id === "r::entry")).toMatchObject({ type: "terminal", data: { terminal: "entry", label: "handler", targetId: null } });
    expect(nodes.find((n) => n.id === "r::exit")).toMatchObject({ type: "terminal", data: { terminal: "exit", targetId: null } });
    // entry wires INTO the first step; the last step wires INTO exit.
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::entry", target: "r::0", kind: "seq" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::1", target: "r::exit", kind: "seq" }));
  });

  it("carries the root's exact PR status on the entry terminal", () => {
    const index = makeIndex([{ id: "r", name: "handler", kind: "function", parentId: null }]);
    index.changedIds.add("r");
    index.changedStatus.set("r", "added");

    const { nodes } = deriveLogicGraph("r", { r: [call("work", "ext:lib#work", "external")] }, index, NONE, {
      hideGreyed: false,
      withTerminals: true,
    });

    expect(nodes.find((node) => node.id === "r::entry")?.data).toMatchObject({ changedStatus: "added" });
  });

  it("carries source-site status separately from a changed callee", () => {
    const target = "ts:src/service.ts#save";
    const index = makeIndex([{ id: target, name: "save", kind: "function", parentId: null }]);
    index.changedStatus.set(target, "modified");
    const flows: LogicFlows = {
      r: [
        { ...call("save", target, "resolved"), source: { file: "src/app.ts", line: 10 } },
        { ...call("save", target, "resolved"), source: { file: "src/app.ts", line: 11 } },
        {
          kind: "branch",
          label: "if ready",
          source: { file: "src/app.ts", line: 12 },
          paths: [{ label: "then", body: [] }],
        },
      ],
    };

    const { nodes } = deriveLogicGraph("r", flows, index, NONE, {
      hideGreyed: false,
      changedStatusForSource: (source) => source?.line === 10 ? "added" : source?.line === 12 ? "deleted" : undefined,
    });

    expect(nodes.find((node) => node.id === "r::0")?.data).toMatchObject({
      changedStatus: "added",
      targetChangedStatus: "modified",
    });
    expect(nodes.find((node) => node.id === "r::1")?.data).toMatchObject({
      targetChangedStatus: "modified",
    });
    expect((nodes.find((node) => node.id === "r::1")?.data as LogicNodeData).changedStatus).toBeUndefined();
    expect(nodes.find((node) => node.id === "r::2")?.data).toMatchObject({ changedStatus: "deleted" });
  });

  it("converges a trailing branch's pins onto the exit terminal, labels intact", () => {
    const branch: FlowStep = { kind: "branch", label: "if cond", paths: [{ label: "then", body: [call("t", "ext:l#t", "external")] }, { label: "else", body: [] }] };
    const { edges } = deriveLogicGraph("r", { r: [branch] }, makeIndex([]), NONE, { hideGreyed: false, withTerminals: true });
    // The arms merge symmetrically first; the single join then runs into the flow's exit terminal.
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0/b0/0", target: "r::0::join", kind: "seq" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: "r::0::join", kind: "branch", label: "else" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0::join", target: "r::exit", kind: "seq" }));
  });

  it("emits no terminals unless withTerminals is set", () => {
    const flows: LogicFlows = { r: [call("a", "ext:l#a", "external")] };
    const { nodes } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    expect(nodes.some((n) => n.type === "terminal")).toBe(false);
  });

  it("deriveLogicGraphFromBodies never frames dived bodies with terminals", () => {
    const bodies: FlowPath[] = [{ label: "try", body: [call("a", "ext:l#a", "external")] }];
    const { nodes } = deriveLogicGraphFromBodies("r::0", bodies, {}, makeIndex([]), NONE, { hideGreyed: false });
    expect(nodes.some((n) => n.type === "terminal")).toBe(false);
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

describe("deriveLogicGraph service frames", () => {
  // An owner lookup that maps a target id to a unit id encoded in the target itself (`ext:<unit>#..`),
  // so a test can control which consecutive calls share an owner.
  const ownerOf = (targetId: string | null) => {
    if (targetId === null) return null;
    const unitId = targetId.split("#")[0];
    return { unitId, label: unitId, kind: "class", health: "#56C271", smelly: false };
  };

  it("stays flat by default (nestByService off): no servicegroup nodes, calls are plain blocks", () => {
    const flows: LogicFlows = { r: [call("a", "ext:svc#a", "external"), call("b", "ext:svc#b", "external")] };
    const { nodes } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false }, ownerOf);
    expect(nodes.filter((n) => n.type === "servicegroup")).toHaveLength(0);
    expect(nodes.map((n) => n.type)).toEqual(["block", "block"]);
    expect(nodes.every((n) => (n.data as { framed?: boolean }).framed !== true)).toBe(true);
  });

  it("wraps a run of consecutive same-owner calls in ONE servicegroup frame, blocks parented to it", () => {
    const flows: LogicFlows = { r: [call("a", "ext:svc#a", "external"), call("b", "ext:svc#b", "external")] };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false, nestByService: true }, ownerOf);
    const frames = nodes.filter((n) => n.type === "servicegroup");
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toMatchObject({ logicKind: "service", isContainer: true, childCount: 2, owner: { unitId: "ext:svc" } });
    const blocks = nodes.filter((n) => n.type === "block");
    expect(blocks.every((b) => b.parentId === frames[0].id)).toBe(true);
    expect(blocks.every((b) => (b.data as { framed?: boolean }).framed === true)).toBe(true);
    // Exec wiring is unchanged: the blocks still chain in order, across the frame boundary.
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "r::0", target: "r::1", kind: "seq" });
  });

  it("breaks the run into separate frames when the owner changes", () => {
    const flows: LogicFlows = { r: [call("a", "ext:x#a", "external"), call("b", "ext:y#b", "external"), call("c", "ext:y#c", "external")] };
    const { nodes } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false, nestByService: true }, ownerOf);
    const frames = nodes.filter((n) => n.type === "servicegroup");
    expect(frames.map((f) => (f.data as { childCount: number }).childCount)).toEqual([1, 2]);
  });

  it("does not frame calls with no owning unit (external/unresolved) even with nesting on — they stay flat", () => {
    const flows: LogicFlows = { r: [call("a", null, "unresolved"), call("b", null, "unresolved")] };
    const { nodes } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false, nestByService: true }, ownerOf);
    expect(nodes.filter((n) => n.type === "servicegroup")).toHaveLength(0);
    expect(nodes.filter((n) => n.type === "block")).toHaveLength(2);
  });
});

// The exec-pins upgrade: exit steps dead-end as return caps, terminated branch paths never rejoin
// the merge, the implicit fall-through gets a labeled synthetic pin, and async flags ride blocks.
describe("deriveLogicGraph — exits, synthesized else, async flags", () => {
  const exit = (label: string | null = null): FlowStep => ({ kind: "exit", variant: "return", label });

  it("renders an exit step as a return-cap terminal with no outgoing exec", () => {
    const flows: LogicFlows = { r: [call("a", "ext:l#a", "external"), exit("res")] };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    const cap = nodes.find((n) => n.id === "r::1")!;
    expect(cap.type).toBe("terminal");
    expect(cap.data).toMatchObject({ terminal: "return", label: "return res" });
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: "r::1", kind: "seq" }));
    expect(edges.filter((e) => e.source === "r::1")).toHaveLength(0);
  });

  it("does not merge a guard's returning then-path; the synthetic else pin carries the continuation", () => {
    const guard: FlowStep = { kind: "branch", label: "if bad", paths: [{ label: "then", body: [call("t", "ext:l#t", "external"), exit()] }] };
    const flows: LogicFlows = { r: [guard, call("after", "ext:l#a", "external")] };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    const after = nodes.find((n) => n.id === "r::1")!;
    const capId = "r::0/b0/1";
    // the then-path's cap never wires onward; only the branch's synthesized else reaches `after`.
    expect(edges.filter((e) => e.source === capId)).toHaveLength(0);
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: after.id, kind: "branch", label: "else" }));
    expect(nodes.some((node) => node.id === "r::0::join")).toBe(false);
  });

  it("adds no synthetic pin when the source wrote an explicit else, and 'no match' for a default-less switch", () => {
    const explicit: FlowStep = { kind: "branch", label: "if c", paths: [{ label: "then", body: [] }, { label: "else", body: [] }] };
    const one = deriveLogicGraph("r", { r: [explicit, call("a", "ext:l#a", "external")] }, makeIndex([]), NONE, { hideGreyed: false });
    expect(one.edges.filter((e) => e.source === "r::0" && e.target === "r::0::join")).toHaveLength(2); // then + else, nothing extra
    expect(execData(one.nodes.find((node) => node.id === "r::0")!).branchPorts?.some((port) => port.synthetic)).toBe(false);
    expect(one.edges).toContainEqual(expect.objectContaining({ source: "r::0::join", target: "r::1", kind: "seq" }));
    const sw: FlowStep = { kind: "branch", label: "switch x", paths: [{ label: "\"a\"", body: [] }] };
    const two = deriveLogicGraph("r", { r: [sw, call("a", "ext:l#a", "external")] }, makeIndex([]), NONE, { hideGreyed: false });
    expect(two.edges).toContainEqual(expect.objectContaining({ source: "r::0", target: "r::0::join", label: "no match", sourcePort: "r::0::port/1" }));
    expect(execData(two.nodes.find((node) => node.id === "r::0")!).branchPorts).toContainEqual(
      expect.objectContaining({ id: "r::0::port/1", label: "no match", role: "fallthrough", synthetic: true }),
    );
  });

  it("omits the synthetic EXIT end-cap when every path already dead-ends at a return", () => {
    const flows: LogicFlows = { r: [call("a", "ext:l#a", "external"), exit("done")] };
    const { nodes } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false, withTerminals: true });
    expect(nodes.some((n) => n.id === "r::entry")).toBe(true);
    expect(nodes.some((n) => n.id === "r::exit")).toBe(false);
    const fallthrough = deriveLogicGraph("r", { r: [call("a", "ext:l#a", "external")] }, makeIndex([]), NONE, { hideGreyed: false, withTerminals: true });
    expect(fallthrough.nodes.some((n) => n.id === "r::exit")).toBe(true);
  });

  it("carries awaited/detached flags onto call-block data", () => {
    const flows: LogicFlows = {
      r: [
        { kind: "call", label: "save", target: null, resolution: "unresolved", awaited: true },
        { kind: "call", label: "track", target: null, resolution: "unresolved", detached: true },
      ],
    };
    const { nodes } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    expect(execData(nodes[0]).awaited).toBe(true);
    expect(execData(nodes[1]).detached).toBe(true);
  });

  it("summarizes detached promises inside a callee on both collapsed and expanded parent blocks", () => {
    const target = "ts:m#worker";
    const detached = (label: string): FlowStep => ({
      kind: "call",
      label,
      target: `ts:m#${label}`,
      resolution: "resolved",
      detached: true,
      async: { kind: "launch", taskId: `task:${label}` },
    });
    const flows: LogicFlows = {
      r: [call("worker", target, "resolved")],
      [target]: [
        detached("top"),
        { kind: "branch", label: "if x", paths: [{ label: "then", body: [detached("branch")] }] },
        { kind: "loop", label: "for each x", body: [detached("loop")] },
        { kind: "callback", label: "setTimeout", body: [detached("callback")] },
        { kind: "call", label: "joinedLater", target: null, resolution: "unresolved", async: { kind: "launch", taskId: "task:joined" } },
      ],
    };
    const index = makeIndex([{ id: target, name: "worker", kind: "method", parentId: null }]);
    const collapsed = deriveLogicGraph("r", flows, index, NONE, { hideGreyed: false });
    expect(execData(collapsed.nodes.find((node) => node.id === "r::0")!)).toMatchObject({
      isContainer: false,
      nestedDetachedCount: 4,
    });

    const expanded = deriveLogicGraph("r", flows, index, new Set(["r::0"]), { hideGreyed: false });
    expect(execData(expanded.nodes.find((node) => node.id === "r::0")!)).toMatchObject({
      isContainer: true,
      nestedDetachedCount: 4,
    });
  });

  it("does not paint correlation sockets for fire-and-forget work with no possible consumer", () => {
    const flows: LogicFlows = {
      r: [{
        kind: "call",
        label: "publishTelemetry",
        target: "ts:m#publishTelemetry",
        resolution: "resolved",
        detached: true,
        async: { kind: "launch", taskId: "task:detached" },
      }],
    };
    const index = makeIndex([{ id: "ts:m#publishTelemetry", name: "publishTelemetry", kind: "method", parentId: null }]);
    const { nodes, edges } = deriveLogicGraph("r", flows, index, NONE, { hideGreyed: false });
    expect(execData(nodes[0])).toMatchObject({ navigable: true, detached: true, asyncEvent: { kind: "launch" }, asyncPorts: [] });
    expect(edges.filter((edge) => edge.kind === "async")).toHaveLength(0);
  });

  it("correlates a launched task with a later standalone await without changing the exec sequence", () => {
    const flows: LogicFlows = {
      r: [
        {
          kind: "call",
          label: "loadInvoice",
          target: "ext:api#loadInvoice",
          resolution: "external",
          async: { kind: "launch", taskId: "task:10", binding: "pending" },
        },
        call("audit", "ext:log#audit", "external"),
        { kind: "await", label: "await pending", mode: "single", inputs: [{ label: "pending", taskId: "task:10" }] },
      ],
    };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    const launch = execData(nodes.find((node) => node.id === "r::0")!);
    const wait = nodes.find((node) => node.id === "r::2")!;
    expect(launch).toMatchObject({
      asyncEvent: { kind: "launch", taskId: "task:10", binding: "pending" },
      asyncPorts: [{ id: "r::0::async/source/0", direction: "source", taskId: "task:10" }],
    });
    expect(wait).toMatchObject({
      type: "async",
      data: {
        logicKind: "await",
        asyncEvent: { kind: "await", mode: "single" },
        asyncPorts: [{ id: "r::2::async/target/0", direction: "target", taskId: "task:10" }],
      },
    });
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: "r::1", kind: "seq" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::1", target: "r::2", kind: "seq" }));
    expect(edges).toContainEqual(expect.objectContaining({
      source: "r::0",
      target: "r::2",
      kind: "async",
      label: "pending",
      taskId: "task:10",
      sourcePort: "r::0::async/source/0",
      targetPort: "r::2::async/target/0",
    }));
  });

  it("keeps async control points when compact leaf calls are hidden", () => {
    const flows: LogicFlows = {
      r: [
        { kind: "call", label: "start", target: null, resolution: "unresolved", async: { kind: "launch", taskId: "task:1" } },
        call("noise", "ext:log#noise", "external"),
        { kind: "await", label: "await task", mode: "single", inputs: [{ label: "task", taskId: "task:1" }] },
      ],
    };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: true });
    expect(nodes.map((node) => node.id)).toEqual(["r::0", "r::2"]);
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: "r::2", kind: "seq" }));
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::0", target: "r::2", kind: "async", taskId: "task:1" }));
  });

  it("fans task rails into a Promise.all barrier while keeping the barrier on the exec thread", () => {
    const flows: LogicFlows = {
      r: [
        { kind: "call", label: "loadA", target: null, resolution: "unresolved", async: { kind: "launch", taskId: "task:a", binding: "a" } },
        { kind: "call", label: "loadB", target: null, resolution: "unresolved", async: { kind: "launch", taskId: "task:b", binding: "b" } },
        {
          kind: "call",
          label: "Promise.all",
          target: "ext:Promise#all",
          resolution: "external",
          awaited: true,
          async: { kind: "barrier", mode: "all", inputs: [{ label: "a", taskId: "task:a" }, { label: "b", taskId: "task:b" }] },
        },
      ],
    };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    const barrier = execData(nodes.find((node) => node.id === "r::2")!);
    expect(barrier).toMatchObject({ compact: false, asyncEvent: { kind: "barrier", mode: "all" } });
    expect(barrier.asyncPorts?.map((port) => port.id)).toEqual([
      "r::2::async/target/0",
      "r::2::async/target/1",
    ]);
    expect(edges.filter((edge) => edge.kind === "async")).toEqual([
      expect.objectContaining({ source: "r::0", target: "r::2", taskId: "task:a", targetPort: "r::2::async/target/0" }),
      expect.objectContaining({ source: "r::1", target: "r::2", taskId: "task:b", targetPort: "r::2::async/target/1" }),
    ]);
    expect(edges).toContainEqual(expect.objectContaining({ source: "r::1", target: "r::2", kind: "seq" }));
  });

  it("keeps a direct await on one call node with local source/target ports and no correlation edge", () => {
    const flows: LogicFlows = {
      r: [{
        kind: "call",
        label: "save",
        target: "ext:api#save",
        resolution: "external",
        awaited: true,
        async: { kind: "direct-await", taskId: "task:20" },
      }],
    };
    const { nodes, edges } = deriveLogicGraph("r", flows, makeIndex([]), NONE, { hideGreyed: false });
    expect(execData(nodes[0]).asyncPorts).toEqual([
      expect.objectContaining({ id: "r::0::async/source/0", direction: "source", taskId: "task:20" }),
      expect.objectContaining({ id: "r::0::async/target/0", direction: "target", taskId: "task:20" }),
    ]);
    expect(edges.filter((edge) => edge.kind === "async")).toHaveLength(0);
  });

  it("namespaces task ids per expanded call-site instance so repeated callees never cross-wire", () => {
    const target = "ts:m#worker";
    const inner: FlowStep[] = [
      { kind: "call", label: "start", target: null, resolution: "unresolved", async: { kind: "launch", taskId: "task:1" } },
      { kind: "await", label: "await task", mode: "single", inputs: [{ label: "task", taskId: "task:1" }] },
    ];
    const flows: LogicFlows = { r: [call("worker", target, "resolved"), call("worker", target, "resolved")], [target]: inner };
    const index = makeIndex([{ id: target, name: "worker", kind: "function", parentId: null }]);
    const { edges } = deriveLogicGraph("r", flows, index, new Set(["r::0", "r::1"]), { hideGreyed: false });
    const asyncEdges = edges.filter((edge) => edge.kind === "async");
    expect(asyncEdges).toEqual([
      expect.objectContaining({ source: "r::0/0", target: "r::0/1" }),
      expect.objectContaining({ source: "r::1/0", target: "r::1/1" }),
    ]);
  });
});
