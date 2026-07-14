import { describe, expect, it } from "vitest";
import type { GraphNode, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { LogicNodeData } from "../derive/logicGraph";
import type { DefGroupData, LogicReactFlowGraph, LogicRfNode } from "../layout/logicElk";
import { deriveLogicLayout, groupDefinitions } from "./deriveLogicLayout";

/** A GraphIndex stub covering what groupDefinitions/collectModuleDefinitions touch:
 * nodesById, parentOf, and childrenOf (walked recursively to collect callables). */
function makeIndex(entries: Array<{ id: string; name: string; kind: string; parentId: string | null }>): GraphIndex {
  const nodesById = new Map<string, GraphNode>(
    entries.map((e) => [
      e.id,
      { id: e.id, kind: e.kind, displayName: e.name, qualifiedName: e.name, parentId: e.parentId, location: { file: "", startLine: 1 } } as GraphNode,
    ]),
  );
  const parentOf = new Map<string, string | null>(entries.map((e) => [e.id, e.parentId]));
  const childrenByParent = new Map<string, GraphNode[]>();
  for (const e of entries) {
    if (e.parentId === null) continue;
    childrenByParent.set(e.parentId, [...(childrenByParent.get(e.parentId) ?? []), nodesById.get(e.id)!]);
  }
  const ancestorsOf = (id: string): GraphNode[] => {
    const path: GraphNode[] = [];
    const seen = new Set<string>();
    let current: string | null | undefined = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = nodesById.get(current);
      if (node) path.push(node);
      current = parentOf.get(current) ?? null;
    }
    return path.reverse();
  };
  const childrenOf = (id: string): GraphNode[] => childrenByParent.get(id) ?? [];
  return {
    nodesById,
    parentOf,
    childrenOf,
    ancestorsOf,
    edges: [],
    changedIds: new Set<string>(),
    changedStatus: new Map(),
  } as unknown as GraphIndex;
}

const MODULE = "ts:m.ts";

describe("groupDefinitions", () => {
  it("groups callables by owner: object/class frames (label-sorted) first, functions last", () => {
    const index = makeIndex([
      { id: MODULE, name: "m.ts", kind: "module", parentId: null },
      { id: "ts:m.ts#aObj", name: "aObj", kind: "object", parentId: MODULE },
      { id: "ts:m.ts#aObj.foo", name: "foo", kind: "method", parentId: "ts:m.ts#aObj" },
      { id: "ts:m.ts#bClass", name: "bClass", kind: "class", parentId: MODULE },
      { id: "ts:m.ts#bClass.bar", name: "bar", kind: "method", parentId: "ts:m.ts#bClass" },
      { id: "ts:m.ts#cInterface", name: "cInterface", kind: "interface", parentId: MODULE },
      { id: "ts:m.ts#cInterface.read", name: "read", kind: "method", parentId: "ts:m.ts#cInterface" },
      { id: "ts:m.ts#run", name: "run", kind: "function", parentId: MODULE },
      { id: "ts:m.ts#boot", name: "boot", kind: "function", parentId: MODULE },
    ]);
    const groups = groupDefinitions(index, MODULE);
    // Owner groups first (aObj < bClass by label), the top-level functions bucket last.
    expect(groups.map((g) => g.label)).toEqual(["aObj", "bClass", "cInterface", "functions"]);
    expect(groups.map((g) => g.kind)).toEqual(["object", "class", "interface", "module"]);
    expect(groups[3].parentId).toBe(MODULE);
    expect(groups[0].defIds).toEqual(["ts:m.ts#aObj.foo"]);
    // Within a group, collectModuleDefinitions' display-name order is preserved (boot < run).
    expect(groups[3].defIds).toEqual(["ts:m.ts#boot", "ts:m.ts#run"]);
  });

  it("returns a single functions group for a module of only top-level functions", () => {
    const index = makeIndex([
      { id: MODULE, name: "m.ts", kind: "module", parentId: null },
      { id: "ts:m.ts#run", name: "run", kind: "function", parentId: MODULE },
    ]);
    expect(groupDefinitions(index, MODULE)).toEqual([
      { parentId: MODULE, label: "functions", kind: "module", defIds: ["ts:m.ts#run"] },
    ]);
  });

  it("is empty for a module with no defined callables", () => {
    const index = makeIndex([{ id: MODULE, name: "m.ts", kind: "module", parentId: null }]);
    expect(groupDefinitions(index, MODULE)).toEqual([]);
  });
});

const OBJECT = "ts:m.ts#worker";
const METHOD = "ts:m.ts#worker.execute";
const FUNCTION = "ts:m.ts#run";
const LEAF_FUNCTION = "ts:m.ts#zLeaf";

const definitionIndex = makeIndex([
  { id: MODULE, name: "m.ts", kind: "module", parentId: null },
  { id: OBJECT, name: "worker", kind: "object", parentId: MODULE },
  { id: METHOD, name: "execute", kind: "method", parentId: OBJECT },
  { id: FUNCTION, name: "run", kind: "function", parentId: MODULE },
  { id: LEAF_FUNCTION, name: "zLeaf", kind: "function", parentId: MODULE },
]);

const definitionFlows: LogicFlows = {
  [METHOD]: [{ kind: "call", label: "method work", target: null, resolution: "unresolved" }],
  [FUNCTION]: [{
    kind: "loop",
    label: "for each item",
    body: [{ kind: "call", label: "function work", target: null, resolution: "unresolved" }],
  }],
};

const layoutDefinitions = (expandedLogic: ReadonlySet<string>): Promise<LogicReactFlowGraph> => deriveLogicLayout(
  MODULE,
  definitionFlows,
  definitionIndex,
  expandedLogic,
  { hideGreyed: false, nestByService: false },
);

function requiredNode(graph: LogicReactFlowGraph, id: string): LogicRfNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`missing node ${id}`);
  return node;
}

const logicData = (node: LogicRfNode): LogicNodeData => node.data as LogicNodeData;
const defGroupData = (node: LogicRfNode): DefGroupData => node.data as DefGroupData;

describe("deriveLogicLayout definition-owner frames", () => {
  const classId = "ts:m.ts#ClassOwner";
  const interfaceId = "ts:m.ts#InterfaceOwner";
  const objectId = "ts:m.ts#objectOwner";
  const ownerKindsIndex = makeIndex([
    { id: MODULE, name: "m.ts", kind: "module", parentId: null },
    { id: classId, name: "ClassOwner", kind: "class", parentId: MODULE },
    { id: `${classId}.method`, name: "method", kind: "method", parentId: classId },
    { id: interfaceId, name: "InterfaceOwner", kind: "interface", parentId: MODULE },
    { id: `${interfaceId}.method`, name: "method", kind: "method", parentId: interfaceId },
    { id: objectId, name: "objectOwner", kind: "object", parentId: MODULE },
    { id: `${objectId}.method`, name: "method", kind: "method", parentId: objectId },
    { id: "ts:m.ts#function", name: "function", kind: "function", parentId: MODULE },
  ]);
  const layoutOwnerKinds = (overrides: ReadonlySet<string>): Promise<LogicReactFlowGraph> => deriveLogicLayout(
    MODULE,
    {},
    ownerKindsIndex,
    overrides,
    { hideGreyed: false, nestByService: false },
  );

  it("uses one default-open expansion contract for class, interface, object, and functions frames", async () => {
    const opened = await layoutOwnerKinds(new Set());
    const frames = opened.nodes.filter((node) => node.type === "defgroup");
    expect(frames.map((node) => defGroupData(node).kind)).toEqual(["class", "interface", "object", "module"]);
    expect(frames.map((node) => defGroupData(node))).toEqual(frames.map(() => expect.objectContaining({
      expandable: true,
      isExpanded: true,
      isContainer: true,
      childCount: 1,
    })));
    expect(opened.nodes.filter((node) => node.parentId && frames.some((frame) => frame.id === node.parentId))).toHaveLength(4);

    const collapsed = await layoutOwnerKinds(new Set(frames.map((node) => node.id)));
    expect(collapsed.nodes).toHaveLength(4);
    for (const frame of collapsed.nodes) {
      expect(frame).toMatchObject({ type: "defgroup", width: 200, height: 32 });
      expect(defGroupData(frame)).toMatchObject({ expandable: true, isExpanded: false, isContainer: false });
    }

    // Removing the occurrence overrides restores the exact compact grid, including child order and
    // parent-relative positions; no state is stored on the omitted child nodes themselves.
    expect(await layoutOwnerKinds(new Set())).toEqual(opened);
  });

  it("omits a folded owner's expanded callable flow and restores it with its child override intact", async () => {
    const frameId = `${MODULE}::defgroup/${OBJECT}`;
    const occurrenceId = `${MODULE}::def/${METHOD}`;
    const childExpanded = new Set([occurrenceId]);
    const opened = await layoutDefinitions(childExpanded);
    expect(requiredNode(opened, occurrenceId)).toMatchObject({ parentId: frameId });
    expect(opened.nodes.some((node) => node.id === `${METHOD}::entry`)).toBe(true);
    expect(opened.edges.some((edge) => edge.id.startsWith(`${occurrenceId}::`))).toBe(true);

    const folded = await layoutDefinitions(new Set([frameId, occurrenceId]));
    const frame = requiredNode(folded, frameId);
    expect(frame).toMatchObject({ width: 200, height: 32 });
    expect(defGroupData(frame)).toMatchObject({ isExpanded: false, isContainer: false });
    expect(folded.nodes.some((node) => node.id === occurrenceId || node.id.startsWith(`${METHOD}::`))).toBe(false);
    expect(folded.edges.some((edge) => edge.id.startsWith(`${occurrenceId}::`))).toBe(false);

    expect(await layoutDefinitions(childExpanded)).toEqual(opened);
  });
});

describe("deriveLogicLayout module definition expansion", () => {
  it.each([
    { label: "top-level function", defId: FUNCTION },
    { label: "owned method", defId: METHOD },
  ])("expands and collapses a $label by its unique definition occurrence id", async ({ defId }) => {
    const occurrenceId = `${MODULE}::def/${defId}`;
    const collapsed = await layoutDefinitions(new Set());
    const collapsedDefinition = requiredNode(collapsed, occurrenceId);
    expect(logicData(collapsedDefinition)).toMatchObject({
      definition: true,
      targetId: defId,
      expandable: true,
      isExpanded: false,
      isContainer: false,
    });
    expect(collapsedDefinition).toMatchObject({ width: 200, height: 52 });
    expect(collapsed.nodes.some((node) => node.id === `${defId}::entry`)).toBe(false);
    expect(collapsed.edges).toHaveLength(0);

    const expanded = await layoutDefinitions(new Set([occurrenceId]));
    const expandedDefinition = requiredNode(expanded, occurrenceId);
    expect(logicData(expandedDefinition)).toMatchObject({
      definition: true,
      targetId: defId,
      isExpanded: true,
      isContainer: true,
    });
    expect(expandedDefinition.width).toBeGreaterThan(200);
    expect(expandedDefinition.height).toBeGreaterThan(52);

    const entry = requiredNode(expanded, `${defId}::entry`);
    const firstStep = requiredNode(expanded, `${defId}::0`);
    const exit = requiredNode(expanded, `${defId}::exit`);
    expect([entry.parentId, firstStep.parentId, exit.parentId]).toEqual([occurrenceId, occurrenceId, occurrenceId]);
    for (const child of [entry, firstStep, exit]) {
      expect(child.position.x + (child.width ?? 0)).toBeLessThanOrEqual(expandedDefinition.width ?? 0);
      expect(child.position.y + (child.height ?? 0)).toBeLessThanOrEqual(expandedDefinition.height ?? 0);
    }
    expect(expanded.edges).toHaveLength(2);
    expect(expanded.edges.every((edge) => edge.id.startsWith(`${occurrenceId}::`))).toBe(true);
    expect(new Set(expanded.edges.map((edge) => edge.id)).size).toBe(expanded.edges.length);
    expect(expanded.edges.every((edge) => expanded.nodes.some((node) => node.id === edge.source))).toBe(true);
    expect(expanded.edges.every((edge) => expanded.nodes.some((node) => node.id === edge.target))).toBe(true);

    const recollapsed = await layoutDefinitions(new Set());
    expect(requiredNode(recollapsed, occurrenceId)).toEqual(collapsedDefinition);
    expect(recollapsed.nodes.some((node) => node.id === `${defId}::entry`)).toBe(false);
    expect(recollapsed.edges).toHaveLength(0);
  });

  it("preserves parents inside an expanded definition flow and grows its grid frame around it", async () => {
    const occurrenceId = `${MODULE}::def/${FUNCTION}`;
    const methodOccurrenceId = `${MODULE}::def/${METHOD}`;
    const graph = await layoutDefinitions(new Set([occurrenceId, methodOccurrenceId]));
    const definition = requiredNode(graph, occurrenceId);
    const collapsedNeighbour = requiredNode(graph, `${MODULE}::def/${LEAF_FUNCTION}`);
    const loop = requiredNode(graph, `${FUNCTION}::0`);
    const loopChild = requiredNode(graph, `${FUNCTION}::0/p0/0`);
    const frame = requiredNode(graph, definition.parentId!);

    expect(loop.parentId).toBe(occurrenceId);
    expect(loopChild.parentId).toBe(loop.id);
    expect(collapsedNeighbour.position.x).toBeGreaterThanOrEqual(definition.position.x + (definition.width ?? 0) + 16);
    expect(frame.width).toBeGreaterThan((definition.position.x ?? 0) + (definition.width ?? 0));
    expect(frame.height).toBeGreaterThan((definition.position.y ?? 0) + (definition.height ?? 0));
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length);
    expect(graph.edges.some((edge) => edge.id.startsWith(`${occurrenceId}::`))).toBe(true);
    expect(graph.edges.some((edge) => edge.id.startsWith(`${methodOccurrenceId}::`))).toBe(true);
  });
});
