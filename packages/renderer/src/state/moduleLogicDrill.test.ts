/**
 * Module-map ↔ logic round trips: double-clicking a FILE card opens the logic view rooted at that
 * module (openLogicFlow), and returning to the Modules lens keeps the level (and in-place
 * expansions) you drilled from — the map's place rides REACTIVE state (moduleFocus/moduleExpanded,
 * which a logic visit never touches), so re-opens inside the logic view, the Logic-tab round trip,
 * and URL restores all agree. Entering the lens from call/ui still resets to the repo overview.
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
  nodes: [
    node("ts:src", "package", "src"),
    node("ts:src/a.ts", "module", "src/a.ts", "ts:src"),
    node("ts:src/a.ts#foo", "function", "src/a.ts", "ts:src/a.ts"),
    node("ts:src/b.ts", "module", "src/b.ts", "ts:src"),
  ],
  edges: [],
};

function freshStore(): BlueprintStore {
  const index = buildGraphIndex(ARTIFACT);
  return createBlueprintStore({ artifact: ARTIFACT, index, provider: null, hasOverlay: false, sourceUrl: null });
}

describe("module-map file drill into logic", () => {
  it("openLogicFlow on a file's module id switches to the logic view rooted there", () => {
    const store = freshStore();
    store.getState().setModuleFocus("ts:src");
    store.getState().openLogicFlow("ts:src/a.ts");
    expect(store.getState().viewMode).toBe("logic");
    expect(store.getState().logicRoot).toBe("ts:src/a.ts");
    expect(store.getState().logicStack).toEqual(["ts:src/a.ts"]);
  });

  it("toggling back to Modules returns to the level the flow was opened from", () => {
    const store = freshStore();
    store.getState().setModuleFocus("ts:src");
    store.getState().openLogicFlow("ts:src/a.ts");
    store.getState().setViewMode("modules");
    expect(store.getState().moduleFocus).toBe("ts:src");
  });

  it("re-opening flows INSIDE the logic view (caller ghosts, Cmd+P) never loses the level", () => {
    const store = freshStore();
    store.getState().setModuleFocus("ts:src");
    store.getState().openLogicFlow("ts:src/a.ts");
    store.getState().openLogicFlow("ts:src/a.ts#foo");
    store.getState().setViewMode("modules");
    expect(store.getState().moduleFocus).toBe("ts:src");
  });

  it("in-place card expansions survive the logic round trip", () => {
    const store = freshStore();
    store.getState().setModuleFocus("ts:src");
    store.getState().toggleModuleExpand("ts:src/a.ts");
    store.getState().openLogicFlow("ts:src/b.ts");
    store.getState().setViewMode("modules");
    expect(store.getState().moduleExpanded.has("ts:src/a.ts")).toBe(true);
  });

  it("a Logic-tab peek and return keeps the level too — every logic→modules return behaves the same", () => {
    const store = freshStore();
    store.getState().setModuleFocus("ts:src");
    store.getState().setViewMode("logic");
    store.getState().setViewMode("modules");
    expect(store.getState().moduleFocus).toBe("ts:src");
  });

  it("entering Modules from the call lens still resets to the whole-repo overview", () => {
    const store = freshStore();
    store.getState().setModuleFocus("ts:src");
    store.getState().setViewMode("call");
    store.getState().setViewMode("modules");
    expect(store.getState().moduleFocus).toBeNull();
  });
});
