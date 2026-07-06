/**
 * Regression: the Module-map lens must OPEN at depth 1 (entry + direct imports), not the full radius.
 * Entering the lens fresh must leave moduleDepth at 1, keep `mdepth` out of the URL, and derive only
 * the depth-1 subset — so the first paint is clean, never the wire-salad whole graph.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, GHOST_DEPTH_ALL } from "./store";
import { encodeNav, navFrom } from "./urlState";

function node(id: string, kind: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId: parentId ?? null, location: { file: "f.ts", startLine: 1 } } as GraphNode;
}

function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

// entry → a (depth 1) → b (depth 2): a two-hop chain, so the full radius (3 files) is strictly larger
// than the depth-1 view (entry + a), which is what makes "opens at 1, not All" observable.
function chainStore() {
  const nodes = [
    node("ts:src", "package"),
    node("ts:src/main.ts", "module", "ts:src"),
    node("ts:src/a.ts", "module", "ts:src"),
    node("ts:src/b.ts", "module", "ts:src"),
  ];
  const edges = [importEdge("ts:src/main.ts", "ts:src/a.ts"), importEdge("ts:src/a.ts", "ts:src/b.ts")];
  const artifact = { nodes, edges, extensions: { entryModules: ["ts:src/main.ts"] } } as unknown as GraphArtifact;
  return createBlueprintStore({ artifact, index: buildGraphIndex(artifact), provider: null, hasOverlay: false, sourceUrl: null });
}

describe("Module-map depth default", () => {
  it("opens at depth 1 — moduleDepth stays 1 and mdepth stays out of the URL", async () => {
    const store = chainStore();
    store.getState().setViewMode("modules");
    await store.getState().moduleRelayout();

    const state = store.getState();
    expect(state.moduleDepth).toBe(1);
    expect(state.moduleMaxDepth).toBe(2); // the unbounded diameter — the slider's ceiling, not the default
    expect(encodeNav(navFrom(state)).has("mdepth")).toBe(false);
  });

  it("derives only the depth-1 subset on open — the far (depth-2) file is not drawn", async () => {
    const store = chainStore();
    store.getState().setViewMode("modules");
    await store.getState().moduleRelayout();

    const ids = new Set(store.getState().moduleRfNodes.map((n) => n.id));
    expect(ids.has("ts:src/main.ts")).toBe(true); // entry
    expect(ids.has("ts:src/a.ts")).toBe(true); // direct import (depth 1)
    expect(ids.has("ts:src/b.ts")).toBe(false); // depth 2 — must be hidden until the reader raises depth
  });

  it("re-clicking into the lens resets a wide depth left from a prior visit", async () => {
    const store = chainStore();
    // Visit the lens and drag out to the whole radius, then tab away to another lens.
    store.getState().setViewMode("modules");
    store.getState().setModuleDepth(GHOST_DEPTH_ALL);
    await store.getState().moduleRelayout();
    expect(store.getState().moduleDepth).toBe(GHOST_DEPTH_ALL);
    store.getState().setViewMode("call");
    // Clicking back into the Module map must open clean at depth 1, not inherit the "All" from before.
    store.getState().setViewMode("modules");
    await store.getState().moduleRelayout();
    expect(store.getState().moduleDepth).toBe(1);
    expect(encodeNav(navFrom(store.getState())).has("mdepth")).toBe(false);
  });
});
