import { describe, expect, it } from "vitest";
import type { FlowStep, GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore } from "./store";

function node(id: string, kind: string, parentId: string | null, displayName = id): GraphNode {
  return { id, kind, qualifiedName: id, displayName, parentId, location: { file: id, startLine: 1 } } as GraphNode;
}

const call = (target: string): FlowStep => ({ kind: "call", label: target, target, resolution: "resolved" });

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-08T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node("ts:pkg", "package", null, "pkg"),
    node("ts:pkg/src", "package", "ts:pkg", "src"),
    node("ts:pkg/src/a.ts", "module", "ts:pkg/src", "a.ts"),
    node("ts:pkg/src/a.ts#run", "function", "ts:pkg/src/a.ts", "run"),
    node("ts:pkg/src/b.ts", "module", "ts:pkg/src", "b.ts"),
    node("ts:pkg/src/b.ts#leaf", "function", "ts:pkg/src/b.ts", "leaf"),
  ],
  edges: [],
  extensions: {
    logicFlow: {
      "ts:pkg/src/a.ts#run": [call("ts:pkg/src/b.ts#leaf")],
      "ts:pkg/src/b.ts#leaf": [],
    },
  } as unknown as GraphArtifact["extensions"],
};

function freshStore() {
  const index = buildGraphIndex(ARTIFACT);
  return createBlueprintStore({
    artifact: ARTIFACT,
    index,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "/api/prs",
    prFilesUrl: "/api/prs/files",
    prReviewUrl: "/api/prs/review",
  });
}

describe("flow explorer store slice", () => {
  it("selectFlowEntry records the selection and bulk-reveals related modules in the module map", () => {
    const store = freshStore();
    store.getState().selectFlowEntry({ rootId: "ts:pkg/src/a.ts#run", blockPath: [] });
    expect(store.getState().flowSelection).toEqual({ rootId: "ts:pkg/src/a.ts#run", blockPath: [] });
    expect(store.getState().moduleFocus).toBe("ts:pkg/src");
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:pkg/src/a.ts", "ts:pkg/src/b.ts"]));
    expect(store.getState().moduleExpanded).toEqual(new Set(["ts:pkg/src/a.ts", "ts:pkg/src/b.ts"]));
  });
});
