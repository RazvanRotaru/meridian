/**
 * Module-map multi-selection semantics: plain click (selectModule) REPLACES the selection,
 * ctrl/cmd+click (toggleModuleSelect) flips one node's membership, zooming to a new level clears,
 * and hiding tests strands test-code ids OUT of the set without touching production picks.
 */

import { describe, expect, it, vi } from "vitest";
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
    {
      id: "calls:buildOrdersApp->OrderRoutes.list",
      source: "ts:src/a.ts#buildOrdersApp",
      target: "ts:src/routes.ts#OrderRoutes.list",
      kind: "calls",
      resolution: "resolved",
    },
  ],
};

const BUILD_ORDERS = "ts:src/a.ts#buildOrdersApp";
const ROUTES_FILE = "ts:src/routes.ts";
const ROUTES_UNIT = `${ROUTES_FILE}#OrderRoutes`;
const ROUTES_METHOD = `${ROUTES_UNIT}.list`;
const DOWNSTREAM_FILE = "ts:src/downstream.ts";
const DOWNSTREAM_UNIT = `${DOWNSTREAM_FILE}#Downstream`;
const DOWNSTREAM_METHOD = `${DOWNSTREAM_UNIT}.run`;
const TERMINAL_FILE = "ts:src/terminal.ts";
const TERMINAL_UNIT = `${TERMINAL_FILE}#Terminal`;
const TERMINAL_METHOD = `${TERMINAL_UNIT}.run`;

// A three-hop call chain whose first hop leaves the initial member set. It catches the overlay's
// incremental contract: only the current members' one-hop ghosts are shown; promoting one ghost
// makes its home file a member, which must expose the next hop so the graph can keep growing.
const ITERATIVE_GHOST_ARTIFACT: GraphArtifact = {
  ...ARTIFACT,
  nodes: [
    ...ARTIFACT.nodes,
    node(DOWNSTREAM_FILE, "module", "src/downstream.ts", "ts:src"),
    node(DOWNSTREAM_UNIT, "class", "src/downstream.ts", DOWNSTREAM_FILE),
    node(DOWNSTREAM_METHOD, "method", "src/downstream.ts", DOWNSTREAM_UNIT),
    node(TERMINAL_FILE, "module", "src/terminal.ts", "ts:src"),
    node(TERMINAL_UNIT, "class", "src/terminal.ts", TERMINAL_FILE),
    node(TERMINAL_METHOD, "method", "src/terminal.ts", TERMINAL_UNIT),
  ],
  edges: [
    ...ARTIFACT.edges,
    {
      id: "calls:OrderRoutes.list->Downstream.run",
      source: ROUTES_METHOD,
      target: DOWNSTREAM_METHOD,
      kind: "calls",
      resolution: "resolved",
    },
    {
      id: "calls:Downstream.run->Terminal.run",
      source: DOWNSTREAM_METHOD,
      target: TERMINAL_METHOD,
      kind: "calls",
      resolution: "resolved",
    },
  ],
};

function freshStore(artifact: GraphArtifact = ARTIFACT): BlueprintStore {
  const index = buildGraphIndex(artifact);
  return createBlueprintStore({
    artifact,
    index,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "/api/prs",
    prOneUrl: "/api/prs/one",
    prFilesUrl: "/api/prs/files",
    prRelatedUrl: "/api/prs/related",
    prCommentsUrl: "/api/prs/comments",
    prChecksUrl: "/api/prs/checks",
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

    store.getState().promoteGhost(ROUTES_UNIT);
    await store.getState().moduleRelayout();

    const state = store.getState();
    expect(state.mapExtra).toEqual(new Set([ROUTES_FILE]));
    expect(state.minimalMemberIds).toEqual([]);
    expect(state.moduleExpanded).toEqual(new Set(["keep-open", ROUTES_FILE]));
    expect(state.moduleFocus).toBe("ts:src/a.ts");
    expect(state.moduleSelected).toEqual(new Set([BUILD_ORDERS]));
    expect(state.moduleRfNodes).toContainEqual(expect.objectContaining({ id: ROUTES_UNIT, type: "unit" }));
    expect(state.moduleRfNodes.some((node) => node.id === ROUTES_UNIT && node.type === "ghost")).toBe(false);
  });

  it("promotes an exact method through main's file→unit reveal path while preserving focus and selection", async () => {
    const store = freshStore();
    store.setState({
      moduleFocus: "ts:src/a.ts",
      moduleSelected: new Set([BUILD_ORDERS]),
      moduleExpanded: new Set(["keep-open"]),
    });
    await store.getState().moduleRelayout();
    expect(store.getState().moduleRfNodes).toContainEqual(expect.objectContaining({ id: ROUTES_METHOD, type: "ghost" }));

    store.getState().promoteGhost(ROUTES_METHOD);
    await store.getState().moduleRelayout();

    const state = store.getState();
    expect(state.mapExtra).toEqual(new Set([ROUTES_FILE]));
    expect(state.moduleExpanded).toEqual(new Set(["keep-open", ROUTES_FILE, ROUTES_UNIT]));
    expect(state.moduleFocus).toBe("ts:src/a.ts");
    expect(state.moduleSelected).toEqual(new Set([BUILD_ORDERS]));
    expect(state.moduleRfNodes).toContainEqual(expect.objectContaining({ id: ROUTES_METHOD, type: "block" }));
    expect(state.moduleRfNodes.some((node) => node.id === ROUTES_METHOD && node.type === "ghost")).toBe(false);
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

  function withBuiltIterativeGhostGraph(): BlueprintStore {
    const store = freshStore(ITERATIVE_GHOST_ARTIFACT);
    store.getState().toggleModuleSelect("ts:src/a.ts");
    store.getState().toggleModuleSelect("ts:src/b.ts");
    store.getState().buildMinimalGraph();
    return store;
  }

  const ghostIds = (store: BlueprintStore): string[] =>
    store
      .getState()
      .minimalRfNodes.filter((candidate) => candidate.type === "ghost")
      .map((candidate) => candidate.id)
      .sort();

  it("buildMinimalGraph extracts the selection verbatim as members and origin", () => {
    const store = withBuiltGraph();
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
  });

  it("promoteGhost adds a member without touching the origin", () => {
    const store = withBuiltGraph();
    store.getState().promoteGhost("ts:src/a.test.ts");
    expect(store.getState().minimalMemberIds).toContain("ts:src/a.test.ts");
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(store.getState().mapExtra.size).toBe(0);
    // Promoting an existing member is a no-op.
    store.getState().promoteGhost("ts:src/a.ts");
    expect(store.getState().minimalMemberIds.filter((id) => id === "ts:src/a.ts")).toHaveLength(1);
  });

  it("uses the open overlay as the authoritative destination and captures the clicked position", () => {
    const store = withBuiltGraph();
    // Model a transient lens switch directly: while the overlay is open, its state wins over the
    // underlying view mode when the one shared "+" action chooses a destination.
    store.setState({ viewMode: "logic" });
    store.getState().promoteGhost("ts:src/a.test.ts", { x: 321, y: 123 });

    expect(store.getState().minimalMemberIds).toContain("ts:src/a.test.ts");
    expect(store.getState().minimalBasePositions["ts:src/a.test.ts"]).toEqual(expect.objectContaining({ x: 321, y: 123 }));
    expect(store.getState().mapExtra.size).toBe(0);
  });

  it("promotes a class's home file expanded so the class replaces its ghost in the laid overlay", async () => {
    const store = withBuiltGraph();
    await store.getState().minimalRelayout();
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROUTES_UNIT, type: "ghost" }));

    store.getState().promoteGhost(ROUTES_UNIT);
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
    store.getState().promoteGhost(ROUTES_METHOD);
    await store.getState().minimalRelayout();

    const state = store.getState();
    expect(state.moduleExpanded).toEqual(new Set(["keep-open", ROUTES_FILE, ROUTES_UNIT]));
    expect(state.moduleExpanded.has(ROUTES_METHOD)).toBe(false);
    expect(state.minimalRfNodes.some((node) => node.id === ROUTES_METHOD)).toBe(true);
  });

  it("derives the initial ghost ring from the current members without leaking later hops", async () => {
    const store = withBuiltIterativeGhostGraph();
    await store.getState().minimalRelayout();

    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(ghostIds(store)).toEqual([ROUTES_UNIT, ROUTES_METHOD]);
    expect(store.getState().minimalRfNodes.some((candidate) => candidate.id === DOWNSTREAM_METHOD)).toBe(false);
    expect(store.getState().minimalRfNodes.some((candidate) => candidate.id === TERMINAL_METHOD)).toBe(false);
  });

  it("reveals a selected ghost's own ghost after promotion", async () => {
    const store = withBuiltIterativeGhostGraph();
    await store.getState().minimalRelayout();

    store.getState().selectModule(ROUTES_UNIT);
    expect(store.getState().moduleSelected).toEqual(new Set([ROUTES_UNIT]));
    expect(ghostIds(store)).toEqual([ROUTES_UNIT, ROUTES_METHOD]); // selection alone does not change membership

    store.getState().promoteGhost(ROUTES_UNIT);
    await store.getState().minimalRelayout();

    expect(store.getState().moduleSelected).toEqual(new Set([ROUTES_UNIT]));
    expect(store.getState().minimalMemberIds).toContain(ROUTES_FILE);
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROUTES_UNIT, type: "unit" }));
    expect(ghostIds(store)).toEqual([DOWNSTREAM_METHOD]);
    expect(store.getState().minimalRfNodes.some((candidate) => candidate.id === TERMINAL_METHOD)).toBe(false);
  });

  it("supports repeated ghost promotion so the minimal graph can expand hop by hop", async () => {
    const store = withBuiltIterativeGhostGraph();
    await store.getState().minimalRelayout();

    store.getState().promoteGhost(ROUTES_UNIT);
    await store.getState().minimalRelayout();
    expect(ghostIds(store)).toEqual([DOWNSTREAM_METHOD]);

    store.getState().selectModule(DOWNSTREAM_METHOD);
    store.getState().promoteGhost(DOWNSTREAM_METHOD);
    await store.getState().minimalRelayout();

    expect(store.getState().moduleSelected).toEqual(new Set([DOWNSTREAM_METHOD]));
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts", ROUTES_FILE, DOWNSTREAM_FILE]);
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: DOWNSTREAM_METHOD, type: "block" }));
    expect(ghostIds(store)).toEqual([TERMINAL_METHOD]);

    store.getState().promoteGhost(TERMINAL_METHOD);
    await store.getState().minimalRelayout();
    expect(store.getState().minimalMemberIds).toContain(TERMINAL_FILE);
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: TERMINAL_METHOD, type: "block" }));
    expect(ghostIds(store)).toEqual([]);
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
    store.getState().promoteGhost("ts:src/a.test.ts");
    store.getState().demoteMinimalMember("ts:src/b.ts");
    store.getState().resetMinimalGraph();
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(store.getState().minimalArrange).toBe(false);
  });

  it("re-runs Re-arrange and Reset restores the map mirror", () => {
    const store = withBuiltGraph();
    const relayout = vi.fn().mockResolvedValue(undefined);
    store.setState({ minimalRelayout: relayout });

    expect(store.getState().minimalArrange).toBe(false);
    store.getState().rearrangeMinimalGraph();
    expect(store.getState().minimalArrange).toBe(true);
    store.getState().rearrangeMinimalGraph();
    expect(relayout).toHaveBeenCalledTimes(2);

    store.getState().resetMinimalGraph();
    expect(store.getState().minimalArrange).toBe(false);
  });

  it("resetMinimalGraph restores map positions after an arrange-only change", () => {
    const store = withBuiltGraph();
    expect(store.getState().minimalMemberIds).toEqual(store.getState().minimalSeedIds);

    store.getState().rearrangeMinimalGraph();
    expect(store.getState().minimalArrange).toBe(true);
    store.getState().resetMinimalGraph();

    expect(store.getState().minimalMemberIds).toEqual(store.getState().minimalSeedIds);
    expect(store.getState().minimalArrange).toBe(false);
  });

  it("a fresh build resets any prior curation", () => {
    const store = withBuiltGraph();
    store.getState().promoteGhost("ts:src/a.test.ts");
    store.getState().rearrangeMinimalGraph();
    store.getState().buildMinimalGraph();
    expect(store.getState().minimalMemberIds).toEqual(store.getState().minimalSeedIds);
    expect(store.getState().minimalArrange).toBe(false);
  });

  it("closeMinimalGraph clears the overlay but keeps the selection for a rebuild", () => {
    const store = withBuiltGraph();
    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
    expect(store.getState().minimalArrange).toBe(false);
    expect(store.getState().moduleSelected.size).toBe(2);
  });

  it("leaving the Map lens closes the overlay (it never lingers behind another tab)", () => {
    const store = withBuiltGraph();
    store.getState().promoteGhost("ts:src/a.test.ts");
    store.getState().setViewMode("logic");
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
  });
});
