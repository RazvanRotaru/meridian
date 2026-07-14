import { describe, expect, it } from "vitest";
import type { FlowStep, GraphArtifact, GraphNode, LogicFlows } from "@meridian/core";
import type { FlowSelectionRef } from "../derive/flowBlocks";
import type { LogicNodeData } from "../derive/logicGraph";
import { buildGraphIndex } from "../graph/graphIndex";
import { deriveFlowPaneLayout } from "./deriveFlowPaneLayout";

const ROOT = "ts:src/root.ts#run";
const CALLEE = "ts:src/callee.ts#work";

const call = (target: string, line = 11): FlowStep => ({
  kind: "call",
  label: target,
  target,
  resolution: "resolved",
  source: { file: "src/root.ts", line },
});

const node = (id: string, kind: string, parentId: string | null): GraphNode => ({
  id,
  kind,
  qualifiedName: id,
  displayName: id.split("#").at(-1) ?? id,
  parentId,
  location: { file: id.split("#")[0], startLine: 1 },
}) as GraphNode;

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-14T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node("ts:src/root.ts", "module", null),
    node(ROOT, "function", "ts:src/root.ts"),
    node("ts:src/callee.ts", "module", null),
    node(CALLEE, "function", "ts:src/callee.ts"),
  ],
  edges: [],
};

const FLOWS: LogicFlows = {
  [ROOT]: [{ kind: "loop", label: "for each item", source: { file: "src/root.ts", line: 10 }, body: [call(CALLEE)] }],
  [CALLEE]: [{ kind: "call", label: "console.log", target: null, resolution: "unresolved" }],
};

const index = buildGraphIndex(ARTIFACT);

const logicData = (value: unknown): LogicNodeData => value as LogicNodeData;

describe("deriveFlowPaneLayout expansion overrides", () => {
  it.each<{
    label: string;
    selection: FlowSelectionRef;
  }>([
    { label: "root flow", selection: { rootId: ROOT, blockPath: [] } },
    { label: "selected control body", selection: { rootId: ROOT, blockPath: [{ step: 0 }] } },
  ])("applies pane-owned occurrence overrides in a $label", async ({ selection }) => {
    const collapsed = await deriveFlowPaneLayout(selection, FLOWS, index, new Set());
    const occurrence = collapsed.nodes.find((candidate) => logicData(candidate.data).targetId === CALLEE);
    expect(occurrence).toBeDefined();
    expect(logicData(occurrence!.data)).toMatchObject({
      expandable: true,
      isExpanded: false,
      isContainer: false,
    });
    expect(collapsed.nodes.some((candidate) => candidate.parentId === occurrence!.id)).toBe(false);

    const expanded = await deriveFlowPaneLayout(selection, FLOWS, index, new Set([occurrence!.id]));
    expect(logicData(expanded.nodes.find((candidate) => candidate.id === occurrence!.id)!.data)).toMatchObject({
      isExpanded: true,
      isContainer: true,
    });
    expect(expanded.nodes.some((candidate) => candidate.parentId === occurrence!.id)).toBe(true);
  });
});

describe("deriveFlowPaneLayout PR source status", () => {
  it.each<{
    label: string;
    selection: FlowSelectionRef;
  }>([
    { label: "root flow", selection: { rootId: ROOT, blockPath: [] } },
    { label: "selected control body", selection: { rootId: ROOT, blockPath: [{ step: 0 }] } },
  ])("carries the call site's exact status through a $label", async ({ selection }) => {
    const layout = await deriveFlowPaneLayout(selection, FLOWS, index, new Set(), {
      changedStatusForSource: (source) => source?.line === 11 ? "modified" : undefined,
    });
    const occurrence = layout.nodes.find((candidate) => logicData(candidate.data).targetId === CALLEE);

    expect(occurrence).toBeDefined();
    expect(logicData(occurrence!.data).changedStatus).toBe("modified");
  });

  it("carries structural source status through the root-flow layout", async () => {
    const layout = await deriveFlowPaneLayout({ rootId: ROOT, blockPath: [] }, FLOWS, index, new Set(), {
      changedStatusForSource: (source) => source?.line === 10 ? "added" : undefined,
    });
    const loop = layout.nodes.find((candidate) => logicData(candidate.data).logicKind === "loop");

    expect(loop).toBeDefined();
    expect(logicData(loop!.data).changedStatus).toBe("added");
  });
});
