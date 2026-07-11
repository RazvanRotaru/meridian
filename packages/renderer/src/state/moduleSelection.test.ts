/**
 * Module-map multi-selection semantics: plain click (selectModule) REPLACES the selection,
 * ctrl/cmd+click (toggleModuleSelect) flips one node's membership, zooming to a new level clears,
 * and hiding tests strands test-code ids OUT of the set without touching production picks.
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
    node("ts:src/a.ts#buildOrdersApp", "function", "src/a.ts", "ts:src/a.ts"),
    node("ts:src/b.ts", "module", "src/b.ts", "ts:src"),
    node("ts:src/a.test.ts", "module", "src/a.test.ts", "ts:src"),
    node("ts:src/routes.ts", "module", "src/routes.ts", "ts:src"),
    node("ts:src/routes.ts#OrderRoutes", "class", "src/routes.ts", "ts:src/routes.ts"),
    node("ts:src/routes.ts#OrderRoutes.list", "method", "src/routes.ts", "ts:src/routes.ts#OrderRoutes"),
  ],
  edges: [
    {
      id: "calls:buildOrdersApp->OrderRoutes",
      source: "ts:src/a.ts#buildOrdersApp",
      target: "ts:src/routes.ts#OrderRoutes",
      kind: "calls",
      resolution: "resolved",
    },
  ],
};

const BUILD_ORDERS = "ts:src/a.ts#buildOrdersApp";
const ROUTES_FILE = "ts:src/routes.ts";
const ROUTES_UNIT = `${ROUTES_FILE}#OrderRoutes`;
const ROUTES_METHOD = `${ROUTES_UNIT}.list`;

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
    prReviewUrl: "/api/prs/review",
  });
}

describe("module-map selection set", () => {
  it("starts empty", () => {
    expect(freshStore().getState().moduleSelected.size).toBe(0);
  });

  it("selectModule replaces the whole selection; null clears it", () => {
    const store = freshStore();
    store.getState().selectModule("ts:src/a.ts");
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/a.ts"]));
    store.getState().selectModule("ts:src/b.ts");
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/b.ts"]));
    store.getState().selectModule(null);
    expect(store.getState().moduleSelected.size).toBe(0);
  });

  it("toggleModuleSelect adds and removes single nodes without touching the rest", () => {
    const store = freshStore();
    store.getState().toggleModuleSelect("ts:src/a.ts");
    store.getState().toggleModuleSelect("ts:src/b.ts");
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/a.ts", "ts:src/b.ts"]));
    store.getState().toggleModuleSelect("ts:src/a.ts");
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/b.ts"]));
  });

  it("zooming to another level clears the selection", () => {
    const store = freshStore();
    store.getState().toggleModuleSelect("ts:src/a.ts");
    store.getState().setModuleFocus("ts:src");
    expect(store.getState().moduleSelected.size).toBe(0);
  });

  it("hiding tests strands test ids out of the selection but keeps production picks", () => {
    const store = freshStore();
    store.getState().toggleShowTests(); // tests are hidden by default — reveal them so a test id is pickable
    store.getState().toggleModuleSelect("ts:src/a.ts");
    store.getState().toggleModuleSelect("ts:src/a.test.ts");
    store.getState().toggleShowTests(); // hide again — the test id is stranded out of the selection
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/a.ts"]));
  });

  it("pinning a class ghost adds and opens its home file without navigating the current canvas", async () => {
    const store = freshStore();
    store.setState({
      moduleFocus: "ts:src/a.ts",
      moduleSelected: new Set([BUILD_ORDERS]),
      moduleExpanded: new Set(["keep-open"]),
    });
    await store.getState().moduleRelayout();
    expect(store.getState().moduleRfNodes).toContainEqual(expect.objectContaining({ id: ROUTES_UNIT, type: "ghost" }));

    store.getState().pinGhostToCanvas(ROUTES_UNIT);
    await store.getState().moduleRelayout();

    const state = store.getState();
    expect(state.mapExtra).toEqual(new Set([ROUTES_FILE]));
    expect(state.moduleExpanded).toEqual(new Set(["keep-open", ROUTES_FILE]));
    expect(state.moduleFocus).toBe("ts:src/a.ts");
    expect(state.moduleSelected).toEqual(new Set([BUILD_ORDERS]));
    expect(state.moduleRfNodes).toContainEqual(expect.objectContaining({ id: ROUTES_UNIT, type: "unit" }));
    expect(state.moduleRfNodes.some((node) => node.id === ROUTES_UNIT && node.type === "ghost")).toBe(false);
  });
});

describe("minimal-graph overlay (extract selection)", () => {
  function withBuiltGraph(): BlueprintStore {
    const store = freshStore();
    store.getState().toggleModuleSelect("ts:src/a.ts");
    store.getState().toggleModuleSelect("ts:src/b.ts");
    store.getState().buildMinimalGraph();
    return store;
  }

  it("buildMinimalGraph extracts the selection verbatim as members and origin", () => {
    const store = withBuiltGraph();
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
  });

  it("promoteMinimalGhost adds a member without touching the origin", () => {
    const store = withBuiltGraph();
    store.getState().promoteMinimalGhost("ts:src/a.test.ts");
    expect(store.getState().minimalMemberIds).toContain("ts:src/a.test.ts");
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    // Promoting an existing member is a no-op.
    store.getState().promoteMinimalGhost("ts:src/a.ts");
    expect(store.getState().minimalMemberIds.filter((id) => id === "ts:src/a.ts")).toHaveLength(1);
  });

  it("promotes a class's home file expanded so the class replaces its ghost in the laid overlay", async () => {
    const store = withBuiltGraph();
    await store.getState().minimalRelayout();
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROUTES_UNIT, type: "ghost" }));

    store.getState().promoteMinimalGhost(ROUTES_UNIT);
    await store.getState().minimalRelayout();

    const state = store.getState();
    expect(state.minimalMemberIds).toContain(ROUTES_FILE);
    expect(state.minimalSeedIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(state.moduleSelected).toEqual(new Set(["ts:src/a.ts", "ts:src/b.ts"]));
    expect(state.moduleExpanded.has(ROUTES_FILE)).toBe(true);
    expect(state.moduleExpanded.has(ROUTES_UNIT)).toBe(false); // reveal the target; do not open it
    expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROUTES_UNIT, type: "unit" }));
    expect(state.minimalRfNodes.some((node) => node.id === ROUTES_UNIT && node.type === "ghost")).toBe(false);
    expect(state.minimalRfNodes.some((node) => node.id === ROUTES_METHOD)).toBe(false);
  });

  it("unions a method's file→unit parent path without dropping prior expansion or expanding the method", async () => {
    const store = withBuiltGraph();
    store.setState({ moduleExpanded: new Set(["keep-open"]) });
    store.getState().promoteMinimalGhost(ROUTES_METHOD);
    await store.getState().minimalRelayout();

    const state = store.getState();
    expect(state.moduleExpanded).toEqual(new Set(["keep-open", ROUTES_FILE, ROUTES_UNIT]));
    expect(state.moduleExpanded.has(ROUTES_METHOD)).toBe(false);
    expect(state.minimalRfNodes.some((node) => node.id === ROUTES_METHOD)).toBe(true);
  });

  it("demoteMinimalMember removes a member but never empties the set", () => {
    const store = withBuiltGraph();
    store.getState().demoteMinimalMember("ts:src/b.ts");
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts"]);
    // The last member can't be removed.
    store.getState().demoteMinimalMember("ts:src/a.ts");
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts"]);
  });

  it("resetMinimalGraph restores the working set to the origin", () => {
    const store = withBuiltGraph();
    store.getState().promoteMinimalGhost("ts:src/a.test.ts");
    store.getState().demoteMinimalMember("ts:src/b.ts");
    store.getState().resetMinimalGraph();
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
  });

  it("a fresh build resets any prior curation", () => {
    const store = withBuiltGraph();
    store.getState().promoteMinimalGhost("ts:src/a.test.ts");
    store.getState().buildMinimalGraph();
    expect(store.getState().minimalMemberIds).toEqual(store.getState().minimalSeedIds);
  });

  it("closeMinimalGraph clears the overlay but keeps the selection for a rebuild", () => {
    const store = withBuiltGraph();
    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
    expect(store.getState().moduleSelected.size).toBe(2);
  });

  it("leaving the Map lens closes the overlay (it never lingers behind another tab)", () => {
    const store = withBuiltGraph();
    store.getState().promoteMinimalGhost("ts:src/a.test.ts");
    store.getState().setViewMode("logic");
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
  });
});
