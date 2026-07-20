/**
 * Module-map multi-selection semantics: plain click (selectModule) REPLACES the selection,
 * ctrl/cmd+click (toggleModuleSelect) flips one node's membership, zooming to a new level clears,
 * and hiding tests strands test-code ids OUT of the set without touching production picks.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { paintMinimalLevel } from "../components/paintMinimal";
import {
  createBlueprintStore,
  removableModuleSelectionCount,
  reviewExpansionForMatches,
  type BlueprintStore,
} from "./store";

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

const SAMPLE_ARTIFACT = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../public/sample-graph.json", import.meta.url)),
  "utf8",
)) as GraphArtifact;

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
const GROUPED_FILE = "ts:src/grouped.ts";
const GROUPED_UNIT = `${GROUPED_FILE}#GroupedWorkers`;
const GROUPED_METHODS = ["one", "two", "three", "four"].map((name) => `${GROUPED_UNIT}.${name}`);
const NESTED_PACKAGE = "ts:src/nested";
const NESTED_FILE = "ts:src/nested/c.ts";
const UNROLLED_PACKAGE = "ts:src/small";
const UNROLLED_FILE = "ts:src/small/only.ts";
const OUTSIDE_PACKAGE = "ts:tools";
const OUTSIDE_FILE = "ts:tools/tool.ts";

const PRIVATE_ARTIFACT: GraphArtifact = {
  ...ARTIFACT,
  nodes: ARTIFACT.nodes.map((candidate) =>
    candidate.id === ROUTES_METHOD ? { ...candidate, tags: ["private"] } : candidate),
};

// Two rollup packages can be nested when both a directory and its child directory own enough
// directly changed files. Opening the outer summary must retain one outer frame and own the nested
// rollup exactly once, while an unrelated ordinary seed remains unchanged.
const NESTED_ROLLUP_ARTIFACT: GraphArtifact = {
  ...ARTIFACT,
  nodes: [
    ...ARTIFACT.nodes,
    node(NESTED_PACKAGE, "package", "src/nested", "ts:src"),
    node(NESTED_FILE, "module", "src/nested/c.ts", NESTED_PACKAGE),
    node(UNROLLED_PACKAGE, "package", "src/small", "ts:src"),
    node(UNROLLED_FILE, "module", "src/small/only.ts", UNROLLED_PACKAGE),
    node(OUTSIDE_PACKAGE, "package", "tools"),
    node(OUTSIDE_FILE, "module", "tools/tool.ts", OUTSIDE_PACKAGE),
  ],
};

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

// Four exact sibling ghosts fold into their real class parent during paint. The parent id itself is
// deliberately absent from the raw laid ghost tier, which exercises selection retention for a
// promoted parent reconstructed only after paint.
const GROUPED_GHOST_ARTIFACT: GraphArtifact = {
  ...ARTIFACT,
  nodes: [
    ...ARTIFACT.nodes,
    node(GROUPED_FILE, "module", "src/grouped.ts", "ts:src"),
    node(GROUPED_UNIT, "class", "src/grouped.ts", GROUPED_FILE),
    ...GROUPED_METHODS.map((id) => node(id, "method", "src/grouped.ts", GROUPED_UNIT)),
  ],
  edges: [
    ...ARTIFACT.edges,
    ...GROUPED_METHODS.map((target, index) => ({
      id: `calls:buildOrdersApp->GroupedWorkers.${index}`,
      source: BUILD_ORDERS,
      target,
      kind: "calls",
      resolution: "resolved" as const,
    })),
  ],
};

// A nested view-only step id (`step:step:…`) is never present in GraphIndex. Keeping the owner and
// construct expanded lets the minimal derivation reconstruct that exact pseudo-node at every push.
const NESTED_STEP_ARTIFACT: GraphArtifact = {
  ...ARTIFACT,
  extensions: {
    logicFlow: {
      [BUILD_ORDERS]: [{
        kind: "loop",
        label: "for (order of orders)",
        body: [{ kind: "call", label: "list", target: ROUTES_METHOD, resolution: "resolved" }],
      }],
    },
  },
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

  it("toggles external ghosts without relayout and drops only selected ext: ids when hiding", () => {
    const store = freshStore();
    const moduleRelayout = vi.fn(async () => {});
    const minimalRelayout = vi.fn(async () => {});
    store.setState({
      moduleSelected: new Set(["ts:src/a.ts", "ext:rxjs#BehaviorSubject", "unresolved:dynamic-call"]),
      moduleRelayout,
      minimalRelayout,
    });

    expect(store.getState().showExternalGhosts).toBe(true);
    store.getState().toggleExternalGhosts();
    expect(store.getState().showExternalGhosts).toBe(false);
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/a.ts", "unresolved:dynamic-call"]));

    store.getState().toggleExternalGhosts();
    expect(store.getState().showExternalGhosts).toBe(true);
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/a.ts", "unresolved:dynamic-call"]));
    expect(moduleRelayout).not.toHaveBeenCalled();
    expect(minimalRelayout).not.toHaveBeenCalled();
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

describe("remove selected canvas additions", () => {
  it("is a strict no-op for a canonical-only selection", () => {
    const store = freshStore();
    const moduleRelayout = vi.fn(async () => {});
    store.setState({
      moduleSelected: new Set([BUILD_ORDERS]),
      moduleExpanded: new Set(["keep-open"]),
      moduleRelayout,
    });

    expect(removableModuleSelectionCount(store.getState())).toBe(0);
    store.getState().removeSelectionFromView();

    expect(store.getState().moduleSelected).toEqual(new Set([BUILD_ORDERS]));
    expect(store.getState().moduleExpanded).toEqual(new Set(["keep-open"]));
    expect(store.getState().mapExtra).toEqual(new Set());
    expect(moduleRelayout).not.toHaveBeenCalled();
  });

  it("does not let a selected canonical container sweep descendant additions", () => {
    const store = freshStore(ITERATIVE_GHOST_ARTIFACT);
    const moduleRelayout = vi.fn(async () => {});
    const mapExtra = new Set([ROUTES_FILE]);
    const moduleSelected = new Set(["ts:src"]);
    const moduleGhostInspection = {
      anchorIds: new Set([BUILD_ORDERS]),
      visitedIds: new Set([DOWNSTREAM_METHOD]),
    };
    store.setState({ mapExtra, moduleSelected, moduleGhostInspection, moduleRelayout });

    expect(removableModuleSelectionCount(store.getState())).toBe(0);
    store.getState().removeSelectionFromView();

    expect(store.getState().mapExtra).toBe(mapExtra);
    expect(store.getState().moduleSelected).toBe(moduleSelected);
    expect(store.getState().moduleGhostInspection).toBe(moduleGhostInspection);
    expect(moduleRelayout).not.toHaveBeenCalled();
  });

  it("reverses only the files contributed by a promoted folder ghost", () => {
    const store = freshStore(ITERATIVE_GHOST_ARTIFACT);
    const moduleRelayout = vi.fn(async () => {});
    store.setState({
      moduleSelected: new Set(["ts:src"]),
      mapExtra: new Set([ROUTES_FILE]),
      moduleRfNodes: [{
        id: "ts:src",
        type: "ghost",
        position: { x: 0, y: 0 },
        data: { members: [ROUTES_FILE, DOWNSTREAM_FILE] },
      }],
      moduleRelayout,
    });

    store.getState().promoteGhost("ts:src");

    expect(store.getState().mapExtra).toEqual(new Set([ROUTES_FILE, DOWNSTREAM_FILE]));
    expect(store.getState().mapGhostPins).toEqual(new Map([
      ["ts:src", new Set([DOWNSTREAM_FILE])],
    ]));
    expect(removableModuleSelectionCount(store.getState())).toBe(1);
    moduleRelayout.mockClear();

    store.getState().removeSelectionFromView();

    expect(store.getState().mapExtra).toEqual(new Set([ROUTES_FILE]));
    expect(store.getState().mapGhostPins).toEqual(new Map());
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src"]));
    expect(moduleRelayout).toHaveBeenCalledOnce();
  });

  it("retains a promoted grouped-parent selection which paint reconstructs after removal", async () => {
    const store = freshStore(GROUPED_GHOST_ARTIFACT);
    store.setState({ moduleFocus: "ts:src/a.ts" });
    await store.getState().moduleRelayout();
    expect(store.getState().moduleRfNodes.some((candidate) => candidate.id === GROUPED_UNIT)).toBe(false);
    expect(GROUPED_METHODS.every((id) =>
      store.getState().moduleRfNodes.some((candidate) => candidate.id === id && candidate.type === "ghost"))).toBe(true);

    store.getState().selectModule(GROUPED_UNIT);
    store.getState().promoteGhost(GROUPED_UNIT);
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));
    expect(store.getState().mapExtra).toEqual(new Set([GROUPED_FILE]));
    expect(store.getState().mapGhostPins).toEqual(new Map([[GROUPED_UNIT, new Set([GROUPED_FILE])]]));

    store.getState().removeSelectionFromView();
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));

    expect(store.getState().mapExtra).toEqual(new Set());
    expect(store.getState().moduleSelected).toEqual(new Set([GROUPED_UNIT]));
    expect(store.getState().moduleRfNodes.some((candidate) => candidate.id === GROUPED_UNIT)).toBe(false);
    expect(GROUPED_METHODS.every((id) =>
      store.getState().moduleRfNodes.some((candidate) => candidate.id === id && candidate.type === "ghost"))).toBe(true);
  });

  it("maps an exact selected method back to its owning file pin and retains it during admission", () => {
    const store = freshStore();
    const moduleRelayout = vi.fn(async () => {});
    store.setState({
      moduleSelected: new Set([ROUTES_METHOD]),
      moduleExpanded: new Set(["keep-open", ROUTES_FILE, ROUTES_UNIT]),
      mapExtra: new Set([ROUTES_FILE]),
      moduleRelayout,
    });

    expect(removableModuleSelectionCount(store.getState())).toBe(1);
    store.getState().removeSelectionFromView();

    expect(store.getState().mapExtra).toEqual(new Set());
    expect(store.getState().moduleSelected).toEqual(new Set([ROUTES_METHOD]));
    expect(store.getState().moduleExpanded).toEqual(new Set(["keep-open", ROUTES_FILE, ROUTES_UNIT]));
    expect(moduleRelayout).toHaveBeenCalledOnce();
  });

  it("removes a mixed multi-selection atomically and retains affected picks during admission", () => {
    const store = freshStore(ITERATIVE_GHOST_ARTIFACT);
    const moduleRelayout = vi.fn(async () => {});
    const inspection = {
      anchorIds: new Set([BUILD_ORDERS]),
      visitedIds: new Set([ROUTES_METHOD, DOWNSTREAM_METHOD]),
    };
    store.setState({
      moduleSelected: new Set([BUILD_ORDERS, ROUTES_METHOD, DOWNSTREAM_METHOD]),
      moduleExpanded: new Set(["keep-open"]),
      mapExtra: new Set([ROUTES_FILE, DOWNSTREAM_FILE]),
      moduleGhostInspection: inspection,
      moduleRelayout,
    });
    const published = vi.fn();
    const unsubscribe = store.subscribe(published);

    expect(removableModuleSelectionCount(store.getState())).toBe(2);
    store.getState().removeSelectionFromView();
    unsubscribe();

    const state = store.getState();
    expect(state.mapExtra).toEqual(new Set());
    expect(state.moduleGhostInspection).toBeNull();
    expect(state.moduleSelected).toEqual(new Set([BUILD_ORDERS, ROUTES_METHOD, DOWNSTREAM_METHOD]));
    expect(state.moduleExpanded).toEqual(new Set(["keep-open"]));
    expect(state.moduleLayoutStatus).toBe("laying-out");
    expect(published).toHaveBeenCalledOnce();
    expect(published.mock.calls[0][0]).toMatchObject({
      moduleGhostInspection: null,
      moduleLayoutStatus: "laying-out",
    });
    expect(moduleRelayout).toHaveBeenCalledOnce();
  });

  it("removes only inspection roots covered by the selection", () => {
    const store = freshStore(ITERATIVE_GHOST_ARTIFACT);
    const moduleRelayout = vi.fn(async () => {});
    store.setState({
      moduleSelected: new Set([ROUTES_METHOD]),
      moduleGhostInspection: {
        anchorIds: new Set([BUILD_ORDERS]),
        visitedIds: new Set([ROUTES_METHOD, DOWNSTREAM_METHOD]),
      },
      moduleRelayout,
    });

    store.getState().removeSelectionFromView();

    expect(store.getState().moduleGhostInspection).toEqual({
      anchorIds: new Set([BUILD_ORDERS]),
      visitedIds: new Set([DOWNSTREAM_METHOD]),
    });
    expect(store.getState().moduleSelected).toEqual(new Set([ROUTES_METHOD]));
    expect(moduleRelayout).toHaveBeenCalledOnce();
  });
});

describe("module ghost inspection", () => {
  async function inspectionStore(): Promise<BlueprintStore> {
    const store = freshStore(ITERATIVE_GHOST_ARTIFACT);
    store.setState({ moduleFocus: "ts:src/a.ts" });
    await store.getState().moduleRelayout();
    return store;
  }

  const nodeWithId = (store: BlueprintStore, id: string) =>
    store.getState().moduleRfNodes.find((candidate) => candidate.id === id);

  it("temporarily materializes the first ghost and reveals its next call neighbour without pinning", async () => {
    const store = await inspectionStore();
    expect(nodeWithId(store, ROUTES_METHOD)).toEqual(expect.objectContaining({ type: "ghost" }));

    store.getState().inspectModuleGhost([ROUTES_METHOD], [BUILD_ORDERS], false);
    await store.getState().moduleRelayout();

    const state = store.getState();
    expect(state.moduleGhostInspection).toEqual({
      anchorIds: new Set([BUILD_ORDERS]),
      visitedIds: new Set([ROUTES_METHOD]),
    });
    expect(state.mapExtra).toEqual(new Set());
    expect(nodeWithId(store, ROUTES_METHOD)).toEqual(expect.objectContaining({
      type: "block",
      data: expect.objectContaining({
        ghostInspectionPath: true,
        ghostInspectionVisited: true,
        ghostInspectionPreview: true,
      }),
    }));
    expect(nodeWithId(store, DOWNSTREAM_METHOD)).toEqual(expect.objectContaining({
      type: "ghost",
      data: expect.objectContaining({
        ghostInspectionPath: true,
        ghostInspectionFrontier: true,
      }),
    }));
    expect(nodeWithId(store, TERMINAL_METHOD)).toBeUndefined();
  });

  it("extends the retained path one click at a time", async () => {
    const store = await inspectionStore();
    store.getState().inspectModuleGhost([ROUTES_METHOD], [BUILD_ORDERS], false);
    await store.getState().moduleRelayout();

    store.getState().inspectModuleGhost([DOWNSTREAM_METHOD], [ROUTES_METHOD], true);
    await store.getState().moduleRelayout();

    const state = store.getState();
    expect(state.moduleGhostInspection).toEqual({
      anchorIds: new Set([BUILD_ORDERS]),
      visitedIds: new Set([ROUTES_METHOD, DOWNSTREAM_METHOD]),
    });
    expect(state.mapExtra).toEqual(new Set());
    expect(nodeWithId(store, ROUTES_METHOD)).toEqual(expect.objectContaining({ type: "block" }));
    expect(nodeWithId(store, DOWNSTREAM_METHOD)).toEqual(expect.objectContaining({
      type: "block",
      data: expect.objectContaining({
        ghostInspectionVisited: true,
        ghostInspectionPreview: true,
      }),
    }));
    expect(nodeWithId(store, TERMINAL_METHOD)).toEqual(expect.objectContaining({
      type: "ghost",
      data: expect.objectContaining({ ghostInspectionFrontier: true }),
    }));
  });

  it("clears every temporary root and restores the original ghost frontier", async () => {
    const store = await inspectionStore();
    store.getState().inspectModuleGhost([ROUTES_METHOD], [BUILD_ORDERS], false);
    await store.getState().moduleRelayout();
    store.getState().inspectModuleGhost([DOWNSTREAM_METHOD], [ROUTES_METHOD], true);
    await store.getState().moduleRelayout();

    store.getState().clearModuleGhostInspection();
    await store.getState().moduleRelayout();

    const state = store.getState();
    expect(state.moduleGhostInspection).toBeNull();
    expect(state.mapExtra).toEqual(new Set());
    expect(nodeWithId(store, ROUTES_METHOD)).toEqual(expect.objectContaining({ type: "ghost" }));
    expect(nodeWithId(store, DOWNSTREAM_METHOD)).toBeUndefined();
    expect(nodeWithId(store, TERMINAL_METHOD)).toBeUndefined();
  });

  it("commits a preview through the existing pin path without ending inspection", async () => {
    const store = await inspectionStore();
    store.getState().inspectModuleGhost([ROUTES_METHOD], [BUILD_ORDERS], false);
    await store.getState().moduleRelayout();
    expect((nodeWithId(store, ROUTES_METHOD)?.data as { ghostInspectionPreview?: boolean }).ghostInspectionPreview).toBe(true);

    store.getState().promoteGhost(ROUTES_METHOD);
    await store.getState().moduleRelayout();

    const state = store.getState();
    expect(state.moduleGhostInspection).toEqual({
      anchorIds: new Set([BUILD_ORDERS]),
      visitedIds: new Set([ROUTES_METHOD]),
    });
    expect(state.mapExtra).toEqual(new Set([ROUTES_FILE]));
    expect(nodeWithId(store, ROUTES_METHOD)).toEqual(expect.objectContaining({
      type: "block",
      data: expect.objectContaining({
        ghostInspectionPath: true,
        ghostInspectionVisited: true,
      }),
    }));
    expect((nodeWithId(store, ROUTES_METHOD)?.data as { ghostInspectionPreview?: boolean }).ghostInspectionPreview).toBeUndefined();
  });

  it("removes a committed preview back to its ghost card in one action", async () => {
    const store = await inspectionStore();
    store.getState().inspectModuleGhost([ROUTES_METHOD], [BUILD_ORDERS], false);
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));
    store.getState().promoteGhost(ROUTES_METHOD);
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));
    const expanded = new Set(store.getState().moduleExpanded);

    store.getState().selectModule(ROUTES_METHOD);
    store.getState().removeSelectionFromView();
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));

    const state = store.getState();
    expect(state.mapExtra).toEqual(new Set());
    expect(state.moduleGhostInspection).toBeNull();
    expect(state.moduleSelected).toEqual(new Set([ROUTES_METHOD]));
    expect(state.moduleExpanded).toEqual(expanded);
    expect(nodeWithId(store, ROUTES_METHOD)).toEqual(expect.objectContaining({ type: "ghost" }));
    expect(nodeWithId(store, DOWNSTREAM_METHOD)).toBeUndefined();
  });

  it("removes a directly pinned ghost while retaining its selected ghost ring", async () => {
    const store = await inspectionStore();
    store.getState().selectModule(ROUTES_METHOD);
    store.getState().promoteGhost(ROUTES_METHOD);
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));
    expect(store.getState().moduleGhostInspection).toBeNull();
    expect(store.getState().mapExtra).toEqual(new Set([ROUTES_FILE]));
    expect(nodeWithId(store, ROUTES_METHOD)).toEqual(expect.objectContaining({ type: "block" }));

    store.getState().removeSelectionFromView();
    expect(store.getState().moduleLayoutStatus).toBe("laying-out");
    expect(store.getState().moduleSelected).toEqual(new Set([ROUTES_METHOD]));
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));

    expect(store.getState().mapExtra).toEqual(new Set());
    expect(store.getState().moduleSelected).toEqual(new Set([ROUTES_METHOD]));
    expect(removableModuleSelectionCount(store.getState())).toBe(0);
    expect(nodeWithId(store, ROUTES_METHOD)).toEqual(expect.objectContaining({ type: "ghost" }));
  });

  it("prunes a removed palette-only card in the winning superseding layout", async () => {
    const store = await inspectionStore();
    store.getState().addToView(DOWNSTREAM_METHOD);
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));
    expect(store.getState().mapExtra).toEqual(new Set([DOWNSTREAM_UNIT]));
    expect(nodeWithId(store, DOWNSTREAM_UNIT)).toEqual(expect.objectContaining({ type: "unit" }));

    store.getState().selectModule(DOWNSTREAM_UNIT);
    store.getState().removeSelectionFromView();
    expect(store.getState().moduleLayoutStatus).toBe("laying-out");
    expect(store.getState().moduleSelected).toEqual(new Set([DOWNSTREAM_UNIT]));
    // Simulate an immediate second structural action superseding Remove's own in-flight layout.
    void store.getState().moduleRelayout({ label: "Superseding removal…" });
    await vi.waitFor(() => expect(store.getState().moduleLayoutStatus).toBe("ready"));

    expect(store.getState().mapExtra).toEqual(new Set());
    expect(store.getState().moduleSelected).toEqual(new Set());
    expect(nodeWithId(store, DOWNSTREAM_UNIT)).toBeUndefined();
  });

  it("clears inspection when navigating to another module level", async () => {
    const store = await inspectionStore();
    store.getState().inspectModuleGhost([ROUTES_METHOD], [BUILD_ORDERS], false);
    await store.getState().moduleRelayout();
    expect(store.getState().moduleGhostInspection).not.toBeNull();

    store.getState().setModuleFocus("ts:src");

    expect(store.getState().moduleGhostInspection).toBeNull();
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

  it.each([true, false])("keeps canvas selection paint-only with highways %s", async (showHighways) => {
    const store = freshStore();
    const minimalRelayout = vi.fn(async () => undefined);
    const nodes = [{ id: "settled", position: { x: 0, y: 0 }, data: {} }];
    const edges = [{ id: "settled-edge", source: "settled", target: "peer" }];
    store.setState({
      minimalSeedIds: ["ts:src/a.ts"],
      minimalMemberIds: ["ts:src/a.ts"],
      minimalRfNodes: nodes,
      minimalRfEdges: edges,
      minimalLayoutStatus: "ready",
      minimalLayoutActivity: null,
      recenterSeq: 7,
      showHighways,
      minimalRelayout,
    });

    store.getState().selectModule(BUILD_ORDERS);
    store.getState().selectModule(BUILD_ORDERS);
    store.getState().toggleModuleSelect(ROUTES_UNIT);
    store.getState().selectModule(null);
    store.getState().selectModule(null);
    await Promise.resolve();

    expect(minimalRelayout).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      minimalRfNodes: nodes,
      minimalRfEdges: edges,
      minimalLayoutStatus: "ready",
      minimalLayoutActivity: null,
      recenterSeq: 7,
    });
    expect(store.getState().minimalRfNodes).toBe(nodes);
    expect(store.getState().minimalRfEdges).toBe(edges);
  });

  it("prepares exact highway strands structurally, then selects without replacing either scene", async () => {
    const store = freshStore();
    store.setState({
      minimalSeedIds: ["ts:src/a.ts", ROUTES_FILE],
      minimalMemberIds: ["ts:src/a.ts", ROUTES_FILE],
      moduleExpanded: new Set(["ts:src/a.ts", ROUTES_FILE, ROUTES_UNIT]),
      moduleSelected: new Set(),
      showHighways: true,
    });
    await store.getState().minimalRelayout();

    const nodes = store.getState().minimalRfNodes;
    const edges = store.getState().minimalRfEdges;
    expect(nodes).toContainEqual(expect.objectContaining({ id: BUILD_ORDERS, type: "block" }));
    expect(nodes).toContainEqual(expect.objectContaining({ id: ROUTES_METHOD, type: "block" }));
    expect(edges).toContainEqual(expect.objectContaining({
      source: BUILD_ORDERS,
      target: ROUTES_METHOD,
    }));
    expect(store.getState().minimalLayoutStatus).toBe("ready");
    expect(store.getState().minimalLayoutActivity).toBeNull();

    const minimalRelayout = vi.fn(async () => undefined);
    store.setState({ minimalRelayout });
    store.getState().selectModule(BUILD_ORDERS);
    await Promise.resolve();

    const state = store.getState();
    expect(state.moduleSelected).toEqual(new Set([BUILD_ORDERS]));
    expect(minimalRelayout).not.toHaveBeenCalled();
    expect(state.minimalRfNodes).toBe(nodes);
    expect(state.minimalRfEdges).toBe(edges);
    expect(state.minimalLayoutStatus).toBe("ready");
    expect(state.minimalLayoutActivity).toBeNull();
  });

  it("keeps private-selection pruning paint-only", async () => {
    const store = freshStore(PRIVATE_ARTIFACT);
    const minimalRelayout = vi.fn(async () => undefined);
    const nodes = [{ id: "settled", position: { x: 0, y: 0 }, data: {} }];
    const edges = [{ id: "settled-edge", source: "settled", target: "peer" }];
    store.setState({
      minimalSeedIds: ["ts:src/a.ts"],
      minimalMemberIds: ["ts:src/a.ts"],
      minimalRfNodes: nodes,
      minimalRfEdges: edges,
      minimalLayoutStatus: "ready",
      moduleSelected: new Set([BUILD_ORDERS, ROUTES_METHOD]),
      showHighways: true,
      minimalRelayout,
    });

    store.getState().togglePrivateMembers();
    await Promise.resolve();

    expect(store.getState().showPrivate).toBe(false);
    expect(store.getState().moduleSelected).toEqual(new Set([BUILD_ORDERS]));
    expect(minimalRelayout).not.toHaveBeenCalled();
    expect(store.getState().minimalRfNodes).toBe(nodes);
    expect(store.getState().minimalRfEdges).toBe(edges);

    store.getState().togglePrivateMembers();
    store.getState().togglePrivateMembers();
    await Promise.resolve();

    expect(store.getState().showPrivate).toBe(false);
    expect(store.getState().moduleSelected).toEqual(new Set([BUILD_ORDERS]));
    expect(minimalRelayout).not.toHaveBeenCalled();
  });

  it("toggles highways over the settled exact-edge scene without relayout", async () => {
    const store = freshStore();
    const minimalRelayout = vi.fn(async () => undefined);
    const nodes = [{ id: "settled", position: { x: 0, y: 0 }, data: {} }];
    const edges = [{ id: "settled-edge", source: "settled", target: "peer" }];
    store.setState({
      minimalSeedIds: ["ts:src/a.ts"],
      minimalMemberIds: ["ts:src/a.ts"],
      minimalRfNodes: nodes,
      minimalRfEdges: edges,
      minimalLayoutStatus: "ready",
      minimalLayoutActivity: null,
      recenterSeq: 4,
      minimalRelayout,
      showHighways: true,
    });

    store.getState().toggleHighways();
    expect(store.getState().showHighways).toBe(false);
    store.getState().toggleHighways();
    await Promise.resolve();

    expect(store.getState().showHighways).toBe(true);
    expect(minimalRelayout).not.toHaveBeenCalled();
    expect(store.getState().minimalRfNodes).toBe(nodes);
    expect(store.getState().minimalRfEdges).toBe(edges);
    expect(store.getState()).toMatchObject({
      minimalLayoutStatus: "ready",
      minimalLayoutActivity: null,
      recenterSeq: 4,
    });
  });

  it("recenters panel selection without replacing the graph scene", async () => {
    const store = freshStore();
    const minimalRelayout = vi.fn(async () => undefined);
    const nodes = [{ id: BUILD_ORDERS, position: { x: 0, y: 0 }, data: {} }];
    const edges = [{ id: "settled-edge", source: "settled", target: "peer" }];
    store.setState({
      minimalSeedIds: ["ts:src/a.ts"],
      minimalMemberIds: ["ts:src/a.ts"],
      minimalRfNodes: nodes,
      minimalRfEdges: edges,
      minimalLayoutStatus: "ready",
      showHighways: true,
      minimalRelayout,
    });

    store.getState().selectReviewNode(BUILD_ORDERS);
    await Promise.resolve();
    expect(store.getState().moduleSelected).toEqual(new Set([BUILD_ORDERS]));
    expect(store.getState().recenterSeq).toBe(1);

    store.getState().selectReviewNode(null);
    await Promise.resolve();
    expect(store.getState().moduleSelected).toEqual(new Set());
    expect(store.getState().recenterSeq).toBe(1);
    expect(minimalRelayout).not.toHaveBeenCalled();
    expect(store.getState().minimalRfNodes).toBe(nodes);
    expect(store.getState().minimalRfEdges).toBe(edges);
  });

  it("keeps every pre-armed expansion inside a review rollup collapsed", () => {
    const index = buildGraphIndex(NESTED_ROLLUP_ARTIFACT);
    const expanded = reviewExpansionForMatches(
      index,
      [{ moduleId: "ts:src/a.ts" }, { moduleId: "ts:src/b.ts" }, { moduleId: OUTSIDE_FILE }],
      new Map([["ts:src", ["ts:src/a.ts", "ts:src/b.ts"]]]),
    );

    expect(expanded.has("ts:src")).toBe(false);
    expect(expanded.has("ts:src/a.ts")).toBe(false);
    expect(expanded.has("ts:src/b.ts")).toBe(false);
    expect(expanded.has(OUTSIDE_PACKAGE)).toBe(true);
    expect(expanded.has(OUTSIDE_FILE)).toBe(true);
  });

  it("clears source inspection and relays out the still-mounted source when extracting", () => {
    const store = freshStore(ITERATIVE_GHOST_ARTIFACT);
    const inspectionAtRelayout: unknown[] = [];
    const moduleRelayout = vi.fn(async () => {
      inspectionAtRelayout.push(store.getState().moduleGhostInspection);
    });
    const minimalRelayout = vi.fn(async () => {});
    store.setState({
      moduleSelected: new Set(["ts:src/a.ts"]),
      moduleGhostInspection: {
        anchorIds: new Set([BUILD_ORDERS]),
        visitedIds: new Set([ROUTES_METHOD]),
      },
      moduleRelayout,
      minimalRelayout,
    });

    store.getState().buildMinimalGraph();

    expect(store.getState().moduleGhostInspection).toBeNull();
    expect(moduleRelayout).toHaveBeenCalledOnce();
    expect(inspectionAtRelayout).toEqual([null]);
    expect(minimalRelayout).toHaveBeenCalledOnce();
  });

  it("bulk expand targets the visible minimal frontier instead of the covered module tree", () => {
    const store = freshStore();
    const minimalRelayout = vi.fn(async () => undefined);
    store.setState({
      minimalSeedIds: ["ts:src/a.ts"],
      minimalMemberIds: ["ts:src/a.ts"],
      minimalRfNodes: [{
        id: "ts:src/a.ts",
        type: "file",
        position: { x: 0, y: 0 },
        data: { isContainer: true, isExpanded: false },
      }],
      moduleExpanded: new Set(),
      moduleSelected: new Set(),
      minimalRelayout,
    });

    store.getState().expandAll();

    expect(store.getState().moduleExpanded).toEqual(new Set(["ts:src/a.ts"]));
    expect(store.getState().moduleExpanded.has("ts:src")).toBe(false);
    expect(minimalRelayout).toHaveBeenCalledOnce();
  });

  it("bulk collapse leaves covered-tree containers open when they are absent from the minimal frontier", () => {
    const store = freshStore();
    const minimalRelayout = vi.fn(async () => undefined);
    store.setState({
      minimalSeedIds: ["ts:src/a.ts"],
      minimalMemberIds: ["ts:src/a.ts"],
      minimalRfNodes: [
        {
          id: "ts:src/a.ts",
          type: "file",
          position: { x: 0, y: 0 },
          data: { isContainer: true, isExpanded: true },
        },
        {
          id: BUILD_ORDERS,
          type: "block",
          parentId: "ts:src/a.ts",
          position: { x: 10, y: 10 },
          data: { isContainer: false, isExpanded: false },
        },
      ],
      moduleExpanded: new Set(["ts:src", "ts:src/a.ts"]),
      moduleSelected: new Set(),
      minimalRelayout,
    });

    store.getState().collapseAll();

    expect(store.getState().moduleExpanded).toEqual(new Set(["ts:src"]));
    expect(minimalRelayout).toHaveBeenCalledOnce();
  });

  it("buildMinimalGraph extracts the selection verbatim as members and origin", () => {
    const store = withBuiltGraph();
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
  });

  it("keeps selected folders as seeds and restores their minimal context after selection loss", async () => {
    const selectedFolders = ["ts:src/notifications", "ts:src/pricing"];
    const services = "ts:src/services";
    const store = freshStore(SAMPLE_ARTIFACT);
    store.setState({
      moduleFocus: "ts:src",
      moduleExpanded: new Set(["ts:src"]),
      moduleSelected: new Set(selectedFolders),
    });
    await store.getState().moduleRelayout();
    store.getState().buildMinimalGraph();

    expect(store.getState().minimalSeedIds).toEqual(selectedFolders);
    expect(store.getState().minimalMemberIds).toEqual(selectedFolders);

    await store.getState().minimalRelayout();
    const state = store.getState();
    expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({
      id: selectedFolders[0],
      type: "package",
    }));
    expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({
      id: selectedFolders[1],
      type: "package",
    }));
    expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({
      id: services,
      type: "package",
      data: expect.objectContaining({ tier: "persistent" }),
    }));
    expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({
      source: services,
      target: selectedFolders[0],
    }));
    expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({
      source: services,
      target: selectedFolders[1],
    }));
    expect(state.minimalRfNodes.map((node) => node.id)).not.toContain("ts:src/notifications/emailService.ts");
    expect(state.minimalRfNodes.map((node) => node.id)).not.toContain("ts:src/pricing/pricingService.ts");

    const painted = paintMinimalLevel(
      state.minimalRfNodes,
      state.minimalRfEdges,
      new Set(),
      1,
      "node",
      new Set(),
    );
    expect(painted.nodes.map((node) => node.id)).toContain(services);
    expect(painted.edges).toContainEqual(expect.objectContaining({
      source: services,
      target: selectedFolders[0],
    }));
    expect(painted.edges).toContainEqual(expect.objectContaining({
      source: services,
      target: selectedFolders[1],
    }));
    expect(painted.nodes.filter((node) => node.type === "ghost")).toEqual([]);
    expect(painted.edges.filter((edge) => (
      edge.data as { ghost?: boolean } | undefined
    )?.ghost === true)).toEqual([]);
  });

  it("retains the same-level folder on the strongest shortest path independently of paint filters", async () => {
    const api = "ts:src/api";
    const repository = "ts:src/repository";
    const services = "ts:src/services";
    const store = freshStore(SAMPLE_ARTIFACT);
    store.setState({ moduleExpanded: new Set(["ts:src"]) });
    await store.getState().moduleRelayout();
    const sourceServices = store.getState().moduleRfNodes.find((node) => node.id === services)!;
    expect(sourceServices).toMatchObject({
      type: "package",
      data: {
        label: "services",
        fileCount: 1,
        ca: 3,
        ce: 5,
        isContainer: true,
        isExpanded: false,
      },
    });
    store.setState({
      moduleSelected: new Set([api, repository]),
      // Relationship filters are presentation-only on main. Hiding every relation involved in the
      // path must not make a later structural relayout forget that `services` connects the seeds.
      relationVisibilityOverrides: {
        modules: { calls: false, references: false, imports: false, instantiates: false },
      },
    });

    store.getState().buildMinimalGraph();
    await store.getState().minimalRelayout();

    const state = store.getState();
    const extractedServices = state.minimalRfNodes.find((node) => node.id === services)!;
    const { tier, ...extractedServicesData } = extractedServices.data;
    expect(state.minimalSeedIds).toEqual([api, repository]);
    expect(state.minimalMemberIds).toEqual([api, repository]);
    expect(extractedServices.type).toBe(sourceServices.type);
    expect(extractedServices.style).toEqual(sourceServices.style);
    expect(extractedServicesData).toEqual(sourceServices.data);
    expect(tier).toBe("persistent");
    expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: api, target: services }));
    expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: services, target: repository }));
    // Equal-hop single-relation alternatives do not displace the stronger service path.
    expect(state.minimalRfNodes).not.toContainEqual(expect.objectContaining({
      id: "ts:src/index.ts",
      data: expect.objectContaining({ tier: "persistent" }),
    }));
    expect(state.minimalRfNodes).not.toContainEqual(expect.objectContaining({
      id: "ts:src/domain",
      data: expect.objectContaining({ tier: "persistent" }),
    }));

    // The retained disclosure is the real shared action, not copied decoration: expanding the
    // connector opens its canonical Map subtree inside the extracted graph, then collapses cleanly.
    store.getState().toggleModuleExpand(services);
    await vi.waitFor(() => expect(
      store.getState().minimalRfNodes.find((node) => node.id === services)?.data.isExpanded,
    ).toBe(true));
    expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({
      id: "ts:src/services/orderService.ts",
      type: "file",
      parentId: services,
    }));

    store.getState().toggleModuleExpand(services);
    await vi.waitFor(() => expect(
      store.getState().minimalRfNodes.find((node) => node.id === services)?.data.isExpanded,
    ).toBe(false));
    expect(store.getState().minimalRfNodes.map((node) => node.id)).not.toContain(
      "ts:src/services/orderService.ts",
    );
  });

  it("lets an exact ghost or grouped ghost parent seed extraction on the Map", () => {
    const exact = freshStore();
    exact.getState().selectModule(ROUTES_METHOD);
    exact.getState().buildMinimalGraph();
    expect(exact.getState().minimalSeedIds).toEqual([ROUTES_METHOD]);

    const parent = freshStore();
    parent.getState().selectModule(ROUTES_UNIT);
    parent.getState().buildMinimalGraph();
    expect(parent.getState().minimalSeedIds).toEqual([ROUTES_UNIT]);
  });

  it("lets the same exact ghost seed extraction on UI through its home file", () => {
    const store = freshStore();
    store.setState({ viewMode: "ui" });
    store.getState().selectModule(ROUTES_METHOD);
    store.getState().buildMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([ROUTES_FILE]);
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

  it.each([
    { viewMode: "modules", lens: "Map" },
    { viewMode: "call", lens: "Service" },
    { viewMode: "ui", lens: "UI" },
  ] as const)("routes the command-palette + to a minimal graph opened from $lens", ({ viewMode }) => {
    const store = freshStore();
    store.setState({ viewMode });
    store.getState().toggleModuleSelect("ts:src/a.ts");
    store.getState().toggleModuleSelect("ts:src/b.ts");
    store.getState().buildMinimalGraph();

    store.getState().addToView(ROUTES_METHOD);

    expect(store.getState().minimalMemberIds).toContain(ROUTES_FILE);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(store.getState().mapExtra).toEqual(new Set());
    expect(store.getState().moduleExpanded).toEqual(new Set([ROUTES_FILE, ROUTES_UNIT]));
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

  it("removes selected promoted members from the minimal graph in one relayout", () => {
    const store = withBuiltGraph();
    const minimalRelayout = vi.fn(async () => {});
    store.setState({
      minimalMemberIds: ["ts:src/a.ts", "ts:src/b.ts", "ts:src/a.test.ts", ROUTES_FILE],
      moduleSelected: new Set(["ts:src/a.test.ts", ROUTES_METHOD]),
      minimalRelayout,
    });

    expect(removableModuleSelectionCount(store.getState())).toBe(2);
    store.getState().removeSelectionFromView();

    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/a.test.ts", ROUTES_METHOD]));
    expect(minimalRelayout).toHaveBeenCalledOnce();
  });

  it("keeps source members, ancestor-contained additions, and the final member protected", () => {
    const store = withBuiltGraph();
    const minimalRelayout = vi.fn(async () => {});
    store.setState({
      minimalMemberIds: ["ts:src/a.ts", "ts:src/b.ts", ROUTES_FILE],
      moduleSelected: new Set(["ts:src"]),
      minimalRelayout,
    });

    expect(removableModuleSelectionCount(store.getState())).toBe(0);
    store.getState().removeSelectionFromView();
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts", ROUTES_FILE]);

    store.setState({ minimalMemberIds: [ROUTES_FILE], moduleSelected: new Set([ROUTES_METHOD]) });
    expect(removableModuleSelectionCount(store.getState())).toBe(0);
    store.getState().removeSelectionFromView();
    expect(store.getState().minimalMemberIds).toEqual([ROUTES_FILE]);
    expect(minimalRelayout).not.toHaveBeenCalled();
  });

  it("resetMinimalGraph restores the working set to the origin", () => {
    const store = withBuiltGraph();
    store.getState().promoteGhost("ts:src/a.test.ts");
    store.getState().resetMinimalGraph();
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(store.getState().minimalArrange).toBe(false);
  });

  it("opens and closes a rolled package without changing membership or selection", () => {
    const store = freshStore(NESTED_ROLLUP_ARTIFACT);
    const relayout = vi.fn().mockResolvedValue(undefined);
    const changedFiles = ["ts:src/a.ts", "ts:src/b.ts"];
    const original = ["ts:src", NESTED_PACKAGE, UNROLLED_FILE, OUTSIDE_FILE].sort();
    const selection = new Set(["ts:src", NESTED_PACKAGE, UNROLLED_FILE, OUTSIDE_FILE]);
    store.setState({
      minimalSeedIds: original,
      minimalMemberIds: [...original],
      moduleSelected: selection,
      minimalRollups: {
        "ts:src": changedFiles,
        [NESTED_PACKAGE]: [NESTED_FILE],
      },
      minimalRelayout: relayout,
    });

    store.getState().toggleModuleExpand("ts:src");

    expect(store.getState().minimalSeedIds).toEqual(original);
    expect(store.getState().minimalMemberIds).toEqual(original);
    expect(store.getState().moduleSelected).toEqual(selection);
    expect(store.getState().moduleExpanded).toContain("ts:src");

    store.getState().toggleModuleExpand("ts:src");

    expect(store.getState().minimalSeedIds).toEqual(original);
    expect(store.getState().minimalMemberIds).toEqual(original);
    expect(store.getState().moduleSelected).toEqual(selection);
    expect(store.getState().moduleExpanded).not.toContain("ts:src");
    expect(relayout).toHaveBeenCalledTimes(2);
  });

  it("lays an opened rolled package as one retained frame with canonical nested Map nodes", async () => {
    const store = freshStore(NESTED_ROLLUP_ARTIFACT);
    store.setState({
      minimalSeedIds: ["ts:src"],
      minimalMemberIds: ["ts:src"],
      minimalRollups: { "ts:src": ["ts:src/a.ts", "ts:src/b.ts"] },
      moduleExpanded: new Set(["ts:src"]),
    });

    await store.getState().minimalRelayout();

    const state = store.getState();
    const group = state.minimalRfNodes.find((candidate) => candidate.id === "ts:src");
    expect(group).toMatchObject({
      id: "ts:src",
      type: "package",
      data: { isExpanded: true, tier: "seed" },
    });
    expect(state.minimalRfNodes.filter((candidate) => candidate.id === "ts:src")).toHaveLength(1);
    expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({
      id: "ts:src/a.ts",
      type: "file",
      parentId: "ts:src",
      extent: "parent",
    }));
    expect(state.minimalSeedIds).toEqual(["ts:src"]);
    expect(state.minimalMemberIds).toEqual(["ts:src"]);
  });

  it("routes canvas-wide expand and collapse through the shared rollup expansion set", () => {
    const store = freshStore(NESTED_ROLLUP_ARTIFACT);
    const relayout = vi.fn().mockResolvedValue(undefined);
    const changedFiles = ["ts:src/a.ts", "ts:src/b.ts"];
    store.setState({
      viewMode: "modules",
      minimalSeedIds: ["ts:src"],
      minimalMemberIds: ["ts:src"],
      minimalRollups: { "ts:src": changedFiles },
      minimalRfNodes: [{
        id: "ts:src",
        type: "package",
        position: { x: 0, y: 0 },
        data: { isContainer: true, isExpanded: false },
      }],
      minimalRelayout: relayout,
    });

    store.getState().expandAll();

    expect(store.getState().minimalSeedIds).toEqual(["ts:src"]);
    expect(store.getState().minimalMemberIds).toEqual(["ts:src"]);
    expect(store.getState().moduleExpanded).toContain("ts:src");

    store.setState({
      minimalRfNodes: [{
        id: "ts:src",
        type: "package",
        position: { x: 0, y: 0 },
        data: { isContainer: true, isExpanded: true },
      }],
    });
    store.getState().collapseAll();

    expect(store.getState().moduleExpanded).not.toContain("ts:src");
    expect(store.getState().minimalSeedIds).toEqual(["ts:src"]);
    expect(store.getState().minimalMemberIds).toEqual(["ts:src"]);
    expect(relayout).toHaveBeenCalledTimes(2);
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

  it("pushes and restores exact extracted graphs at arbitrary depth", async () => {
    const store = withBuiltIterativeGhostGraph();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    const rootSeeds = [...store.getState().minimalSeedIds];
    const nestedSeeds = [ROUTES_METHOD, DOWNSTREAM_METHOD, TERMINAL_METHOD, BUILD_ORDERS];

    for (const [index, id] of nestedSeeds.entries()) {
      store.getState().selectModule(id);
      await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
      store.getState().buildMinimalGraph();
      await vi.waitFor(() => {
        expect(store.getState().minimalLayoutStatus).toBe("ready");
        expect(store.getState().minimalSeedIds).toEqual([id]);
      });
      expect(store.getState().minimalGraphHistory).toHaveLength(index + 1);
    }

    for (let index = nestedSeeds.length - 2; index >= 0; index -= 1) {
      store.getState().backMinimalGraph();
      expect(store.getState().minimalSeedIds).toEqual([nestedSeeds[index]]);
      expect(store.getState().minimalGraphHistory).toHaveLength(index + 1);
    }
    store.getState().backMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual(rootSeeds);
    expect(store.getState().minimalGraphHistory).toHaveLength(0);

    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);
  });

  it("restores the parent presentation and Codebase disclosure after nested extraction", async () => {
    const store = withBuiltGraph();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    store.getState().setMinimalView("codebase");
    store.getState().setMinimalCodebaseExpansionOverride("ts:src", false);
    store.getState().setMinimalShowGhostNodes(false);
    store.getState().selectModule(BUILD_ORDERS);
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));

    store.getState().buildMinimalGraph();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().minimalView).toBe("graph");
    expect(store.getState().minimalShowGhostNodes).toBe(true);
    expect(store.getState().minimalCodebaseExpansionOverrides).toEqual(new Map());

    store.getState().backMinimalGraph();
    expect(store.getState().minimalView).toBe("codebase");
    expect(store.getState().minimalShowGhostNodes).toBe(false);
    expect(store.getState().minimalCodebaseExpansionOverrides).toEqual(new Map([["ts:src", false]]));
  });

  it("keeps a deeply nested synthetic step non-empty and typed through repeated extraction", async () => {
    const store = freshStore(NESTED_STEP_ARTIFACT);
    const loopStep = `step:${BUILD_ORDERS}:0`;
    const nestedCallStep = `step:${loopStep}:0`;
    store.setState({ moduleExpanded: new Set([BUILD_ORDERS, loopStep]) });
    store.getState().selectModule(BUILD_ORDERS);
    store.getState().buildMinimalGraph();
    await vi.waitFor(() => {
      expect(store.getState().minimalLayoutStatus).toBe("ready");
      expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: BUILD_ORDERS, type: "block" }));
      expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: nestedCallStep, type: "step" }));
    });

    store.getState().selectModule(nestedCallStep);
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    store.getState().buildMinimalGraph();
    await vi.waitFor(() => {
      expect(store.getState().minimalSeedIds).toEqual([nestedCallStep]);
      expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: nestedCallStep, type: "step" }));
    });
    expect(store.getState().minimalRfNodes.length).toBeGreaterThan(0);

    // The child remains in the same identity space, so another push does not depend on its vanished
    // artifact ancestors or collapse into an empty graph.
    store.getState().buildMinimalGraph();
    await vi.waitFor(() => {
      expect(store.getState().minimalGraphHistory).toHaveLength(2);
      expect(store.getState().minimalSeedIds).toEqual([nestedCallStep]);
      expect(store.getState().minimalRfNodes).toContainEqual(expect.objectContaining({ id: nestedCallStep, type: "step" }));
    });
    expect(store.getState().minimalRfNodes.length).toBeGreaterThan(0);
  });

  it("restores a curated parent scene without re-laying it", async () => {
    const store = withBuiltGraph();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    store.getState().promoteGhost("ts:src/a.test.ts");
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    store.getState().rearrangeMinimalGraph();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    store.getState().selectModule(ROUTES_METHOD);
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    const parent = store.getState();
    const parentNodes = parent.minimalRfNodes;
    const parentEdges = parent.minimalRfEdges;
    const parentMembers = [...parent.minimalMemberIds];
    const parentExpanded = new Set(parent.moduleExpanded);
    const parentBasePositions = { ...parent.minimalBasePositions };

    store.getState().buildMinimalGraph();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().minimalSeedIds).toEqual([ROUTES_METHOD]);

    store.getState().backMinimalGraph();
    const restored = store.getState();
    expect(restored.minimalMemberIds).toEqual(parentMembers);
    expect(restored.moduleExpanded).toEqual(parentExpanded);
    expect(restored.minimalBasePositions).toEqual(parentBasePositions);
    expect(restored.minimalArrange).toBe(true);
    expect(restored.minimalRfNodes).toBe(parentNodes);
    expect(restored.minimalRfEdges).toBe(parentEdges);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.getState().minimalLayoutStatus).toBe("ready");
    expect(store.getState().minimalRfNodes).toBe(parentNodes);
    expect(store.getState().minimalRfEdges).toBe(parentEdges);
  });

  it("closeMinimalGraph clears the overlay but keeps the selection for a rebuild", () => {
    const store = withBuiltGraph();
    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
    expect(store.getState().minimalArrange).toBe(false);
    expect(store.getState().moduleSelected.size).toBe(2);
  });

  it("uses Back at the root to return to the source graph without losing the selection", () => {
    const store = withBuiltGraph();
    const selection = new Set(store.getState().moduleSelected);

    store.getState().backMinimalGraph();

    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
    expect(store.getState().minimalGraphHistory).toEqual([]);
    expect(store.getState().moduleSelected).toEqual(selection);
  });

  it("leaving the Map lens closes the overlay (it never lingers behind another tab)", () => {
    const store = withBuiltGraph();
    store.getState().promoteGhost("ts:src/a.test.ts");
    store.getState().setViewMode("logic");
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
  });
});
