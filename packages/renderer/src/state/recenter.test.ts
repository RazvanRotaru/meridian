/**
 * The recenter signal: `recenter()` bumps a monotonic counter the active graph surface subscribes to
 * (via useRecenter) to re-fit its viewport. It's a pure signal — it never touches navigation state,
 * selection, or the layout — so this pins down that contract: the counter climbs and nothing else moves.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, type BlueprintStore } from "./store";

function node(id: string, kind: string, file: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } };
}

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-07T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [node("ts:src", "package", "src"), node("ts:src/a.ts", "module", "src/a.ts", "ts:src")],
  edges: [],
};

function freshStore(): BlueprintStore {
  const index = buildGraphIndex(ARTIFACT);
  return createBlueprintStore({
    artifact: ARTIFACT,
    index,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "/api/prs",
    prFilesUrl: "/api/prs/files",
  });
}

describe("recenter signal", () => {
  it("starts at zero", () => {
    expect(freshStore().getState().recenterSeq).toBe(0);
  });

  it("each recenter() bumps the counter monotonically", () => {
    const store = freshStore();
    store.getState().recenter();
    expect(store.getState().recenterSeq).toBe(1);
    store.getState().recenter();
    expect(store.getState().recenterSeq).toBe(2);
  });

  it("does not touch selection or module focus (a pure repaint signal)", () => {
    const store = freshStore();
    store.getState().selectModule("ts:src/a.ts");
    const focusBefore = store.getState().moduleFocus;
    store.getState().recenter();
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/a.ts"]));
    expect(store.getState().moduleFocus).toBe(focusBefore);
  });
});
