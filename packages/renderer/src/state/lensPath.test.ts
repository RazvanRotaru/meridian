import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { anchorNodeIds, mapRevealStateForMany, resolveServiceAnchors, serviceRevealStateForMany, uiRevealStateForMany } from "./lensPath";
import { clusteringFor } from "../derive/serviceClusteringCache";
import { frameIdOf } from "../derive/serviceClusterEdges";

function node(id: string, kind: string, parentId?: string, displayName?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: displayName ?? id,
    parentId: parentId ?? null,
    location: { file: "f.ts", startLine: 1 },
  } as GraphNode;
}

// A service + a repository it depends on (each a class with one method) under src/, a sibling lib/
// dir with a bare helper function, and a second ROOT package that shares no ancestor with ts:app.
const NODES: GraphNode[] = [
  node("ts:app", "package", undefined, "app"),
  node("ts:app/src", "package", "ts:app", "src"),
  node("ts:app/src/orders.ts", "module", "ts:app/src", "orders.ts"),
  node("ts:app/src/orders.ts#OrderService", "class", "ts:app/src/orders.ts", "OrderService"),
  node("ts:app/src/orders.ts#OrderService.place", "method", "ts:app/src/orders.ts#OrderService", "place"),
  node("ts:app/src/repo.ts", "module", "ts:app/src", "repo.ts"),
  node("ts:app/src/repo.ts#OrderRepository", "class", "ts:app/src/repo.ts", "OrderRepository"),
  node("ts:app/src/repo.ts#OrderRepository.save", "method", "ts:app/src/repo.ts#OrderRepository", "save"),
  node("ts:app/lib", "package", "ts:app", "lib"),
  node("ts:app/lib/util.ts", "module", "ts:app/lib", "util.ts"),
  node("ts:app/lib/util.ts#format", "function", "ts:app/lib/util.ts", "format"),
  node("ts:other", "package", undefined, "other"),
  node("ts:other/x.ts", "module", "ts:other", "x.ts"),
  node("ts:other/x.ts#run", "function", "ts:other/x.ts", "run"),
];

// OrderService instantiates + calls OrderRepository — the coupling that seeds a service cluster.
const EDGES: GraphEdge[] = [
  { id: "e1", source: "ts:app/src/orders.ts#OrderService", target: "ts:app/src/repo.ts#OrderRepository", kind: "instantiates", resolution: "resolved" },
  { id: "e2", source: "ts:app/src/orders.ts#OrderService.place", target: "ts:app/src/repo.ts#OrderRepository.save", kind: "calls", resolution: "resolved" },
] as GraphEdge[];

const index = buildGraphIndex({ nodes: NODES, edges: EDGES } as GraphArtifact);
const LEAD = "ts:app/src/orders.ts#OrderService";
const METHOD = "ts:app/src/orders.ts#OrderService.place";
const SAVE = "ts:app/src/repo.ts#OrderRepository.save";
const FORMAT = "ts:app/lib/util.ts#format";
const OTHER_FN = "ts:other/x.ts#run";

describe("anchorNodeIds", () => {
  const base = { moduleSelected: new Set<string>(), moduleEffectiveFocus: null, moduleFocus: null, logicRoot: null };

  it("returns ALL of the module selection on Map/Service, else the focus as a singleton", () => {
    expect(anchorNodeIds({ ...base, viewMode: "modules", moduleSelected: new Set([METHOD, SAVE]) })).toEqual([METHOD, SAVE]);
    expect(anchorNodeIds({ ...base, viewMode: "call", moduleFocus: "ts:app/src" })).toEqual(["ts:app/src"]);
    expect(anchorNodeIds({ ...base, viewMode: "modules", moduleEffectiveFocus: "ts:app", moduleFocus: "ts:app/src" })).toEqual(["ts:app"]);
  });

  it("reads the shared module selection then focus on UI, the root on Logic, nothing on PRs or when unanchored", () => {
    expect(anchorNodeIds({ ...base, viewMode: "ui", moduleSelected: new Set([METHOD]) })).toEqual([METHOD]);
    expect(anchorNodeIds({ ...base, viewMode: "ui", moduleFocus: "ts:app/src/orders.ts" })).toEqual(["ts:app/src/orders.ts"]);
    expect(anchorNodeIds({ ...base, viewMode: "logic", logicRoot: METHOD })).toEqual([METHOD]);
    expect(anchorNodeIds({ ...base, viewMode: "prs" })).toEqual([]);
    expect(anchorNodeIds({ ...base, viewMode: "modules" })).toEqual([]);
  });

  it("normalizes a selected svc: cluster frame to its LEAD unit — a real node every lens can place", () => {
    const anchors = anchorNodeIds({ ...base, viewMode: "call", moduleSelected: new Set([frameIdOf(LEAD)]) });
    expect(anchors).toEqual([LEAD]);
    expect(mapRevealStateForMany(anchors, index)!.moduleSelected).toEqual(new Set([LEAD]));
    const serviceReveal = serviceRevealStateForMany(anchors, index)!;
    expect(serviceReveal.moduleExpanded.has(frameIdOf(LEAD))).toBe(true);
    expect(serviceReveal.moduleExpanded.has(LEAD)).toBe(false);
    expect(uiRevealStateForMany(anchors, index)!.moduleSelected).toEqual(new Set([LEAD]));
  });
});

describe("mapRevealStateForMany", () => {
  it("a single anchor focuses its directory, expands the path, and selects the exact node", () => {
    const reveal = mapRevealStateForMany([METHOD], index);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleFocus).toBe("ts:app/src");
    expect(reveal!.moduleSelected).toEqual(new Set([METHOD]));
    // File + class on the path are opened (within the src/ focus); the anchor itself is not.
    expect(reveal!.moduleExpanded).toEqual(new Set(["ts:app/src/orders.ts", "ts:app/src/orders.ts#OrderService"]));
  });

  it("anchors in sibling dirs focus their deepest COMMON package and union both paths", () => {
    const reveal = mapRevealStateForMany([METHOD, FORMAT], index);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleFocus).toBe("ts:app");
    expect(reveal!.moduleSelected).toEqual(new Set([METHOD, FORMAT]));
    expect(reveal!.moduleExpanded).toEqual(new Set([
      "ts:app/src", "ts:app/src/orders.ts", "ts:app/src/orders.ts#OrderService",
      "ts:app/lib", "ts:app/lib/util.ts",
    ]));
  });

  it("anchors sharing NO package fall to the repo root (null focus)", () => {
    const reveal = mapRevealStateForMany([METHOD, OTHER_FN], index);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleFocus).toBeNull();
    expect(reveal!.moduleSelected).toEqual(new Set([METHOD, OTHER_FN]));
    expect(reveal!.moduleExpanded.has("ts:app")).toBe(true);
    expect(reveal!.moduleExpanded.has("ts:other")).toBe(true);
  });

  it("drops unplaceable anchors (a bare package) but keeps the placeable ones", () => {
    const reveal = mapRevealStateForMany(["ts:app/src", METHOD], index);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleSelected).toEqual(new Set([METHOD]));
    expect(reveal!.moduleFocus).toBe("ts:app/src");
  });

  it("returns null only when NO anchor sits in a file", () => {
    expect(mapRevealStateForMany(["ts:app/src", "ts:other"], index)).toBeNull();
    expect(mapRevealStateForMany([], index)).toBeNull();
  });
});

describe("serviceRevealStateForMany", () => {
  it("opens the owning service frame(s), keeps moduleFocus null, and selects every anchor", () => {
    const reveal = serviceRevealStateForMany([METHOD, SAVE], index);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleFocus).toBeNull();
    expect(reveal!.moduleSelected).toEqual(new Set([METHOD, SAVE]));
    // The frame and both owning units are opened so the exact selected methods are drawn.
    expect(reveal!.moduleExpanded.has(frameIdOf(LEAD))).toBe(true);
    expect(reveal!.moduleExpanded.has(LEAD)).toBe(true);
    expect(reveal!.moduleExpanded.has("ts:app/src/repo.ts#OrderRepository")).toBe(true);
  });

  it("drops anchors in no clustered unit but keeps the placeable ones", () => {
    const reveal = serviceRevealStateForMany([FORMAT, METHOD], index);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleSelected).toEqual(new Set([METHOD]));
  });

  it("returns null only when NO anchor lives in a clustered unit (a folder decomposes to the units beneath it)", () => {
    // lib/ holds only the bare helper function — no clustered unit anywhere beneath.
    expect(serviceRevealStateForMany(["ts:app/lib", FORMAT], index)).toBeNull();
    expect(serviceRevealStateForMany([], index)).toBeNull();
    // src/ DOES decompose: the clusters of the units beneath it open (the folder group-ghost reveal).
    expect(serviceRevealStateForMany(["ts:app/src"], index)!.moduleExpanded.has(frameIdOf(LEAD))).toBe(true);
  });

  it("answers an empty selection without requiring Service facts in a bounded Map projection", () => {
    const boundedMapIndex = buildGraphIndex(
      { nodes: NODES, edges: EDGES } as GraphArtifact,
      {
        structure: index.structure,
        graphSummary: index.graphSummary,
        serviceTopology: null,
        artifactComplete: false,
      },
    );

    expect(resolveServiceAnchors([], boundedMapIndex)).toBeNull();
    expect(serviceRevealStateForMany([], boundedMapIndex)).toBeNull();
  });

  it("memoizes clustering per graph index", () => {
    expect(clusteringFor(index)).toBe(clusteringFor(index));
  });
});

describe("file anchors resolve through their contained clustered units", () => {
  it("a file whose class is clustered opens the owning frame and keeps the FILE selected", () => {
    const resolution = resolveServiceAnchors(["ts:app/src/orders.ts"], index);
    expect(resolution).not.toBeNull();
    expect(resolution!.owningLeads).toEqual([LEAD]);
    expect(resolution!.reveal.moduleExpanded.has(frameIdOf(LEAD))).toBe(true);
    expect(resolution!.reveal.moduleExpanded.has(LEAD)).toBe(false);
    expect(resolution!.reveal.moduleSelected).toEqual(new Set(["ts:app/src/orders.ts"]));
  });

  it("a file with no clustered units stays unplaceable", () => {
    expect(resolveServiceAnchors(["ts:app/lib/util.ts"], index)).toBeNull();
  });

  it("a file spanning TWO clusters opens both frames and seeds both leads", () => {
    // One file holding two service-named classes: each is a seed, so each leads its OWN cluster.
    const ALPHA = "ts:two/pair.ts#AlphaService";
    const BETA = "ts:two/pair.ts#BetaService";
    const pairIndex = buildGraphIndex({
      nodes: [
        node("ts:two", "package", undefined, "two"),
        node("ts:two/pair.ts", "module", "ts:two", "pair.ts"),
        node(ALPHA, "class", "ts:two/pair.ts", "AlphaService"),
        node(`${ALPHA}.run`, "method", ALPHA, "run"),
        node(BETA, "class", "ts:two/pair.ts", "BetaService"),
        node(`${BETA}.run`, "method", BETA, "run"),
      ],
      edges: [{ id: "p1", source: `${ALPHA}.run`, target: `${BETA}.run`, kind: "calls", resolution: "resolved" }] as GraphEdge[],
    } as GraphArtifact);
    const resolution = resolveServiceAnchors(["ts:two/pair.ts"], pairIndex);
    expect(resolution).not.toBeNull();
    expect(new Set(resolution!.owningLeads)).toEqual(new Set([ALPHA, BETA]));
    expect(resolution!.reveal.moduleExpanded.has(frameIdOf(ALPHA))).toBe(true);
    expect(resolution!.reveal.moduleExpanded.has(frameIdOf(BETA))).toBe(true);
    expect(resolution!.reveal.moduleExpanded.has(ALPHA)).toBe(false);
    expect(resolution!.reveal.moduleExpanded.has(BETA)).toBe(false);
    expect(resolution!.reveal.moduleSelected).toEqual(new Set(["ts:two/pair.ts"]));
  });
});

describe("uiRevealStateForMany", () => {
  it("expands the union of container chains in the SHARED module spaces and selects every anchor", () => {
    // No renders edges in this fixture, so the lens has no render root: the reveal dives to the
    // anchors' deepest common package, exactly like the Map's reveal.
    const reveal = uiRevealStateForMany([METHOD, SAVE], index);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleFocus).toBe("ts:app/src");
    expect(reveal!.moduleSelected).toEqual(new Set([METHOD, SAVE]));
    expect(reveal!.moduleExpanded.has("ts:app/src/orders.ts#OrderService")).toBe(true);
    expect(reveal!.moduleExpanded.has("ts:app/src/repo.ts#OrderRepository")).toBe(true);
  });

  it("drops ids that are not in the graph but keeps the placeable ones", () => {
    const reveal = uiRevealStateForMany(["ts:nope#ghost", METHOD], index);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleSelected).toEqual(new Set([METHOD]));
  });

  it("returns null only when NO anchor is in the graph", () => {
    expect(uiRevealStateForMany(["ts:nope#ghost"], index)).toBeNull();
    expect(uiRevealStateForMany([], index)).toBeNull();
  });
});

describe("uiRevealStateForMany render-subtree dive", () => {
  // A web app whose renders edges all live under ui/, plus a bootstrap main.ts outside it.
  const UI_NODES: GraphNode[] = [
    node("ts:web", "package", undefined, "web"),
    node("ts:web/ui", "package", "ts:web", "ui"),
    node("ts:web/ui/App.tsx", "module", "ts:web/ui", "App.tsx"),
    node("ts:web/ui/App.tsx#App", "function", "ts:web/ui/App.tsx", "App"),
    node("ts:web/ui/Button.tsx", "module", "ts:web/ui", "Button.tsx"),
    node("ts:web/ui/Button.tsx#Button", "function", "ts:web/ui/Button.tsx", "Button"),
    node("ts:web/main.ts", "module", "ts:web", "main.ts"),
    node("ts:web/main.ts#main", "function", "ts:web/main.ts", "main"),
  ];
  const UI_EDGES: GraphEdge[] = [
    { id: "r1", source: "ts:web/ui/App.tsx#App", target: "ts:web/ui/Button.tsx#Button", kind: "renders", resolution: "resolved" },
  ] as GraphEdge[];
  const uiIndex = buildGraphIndex({ nodes: UI_NODES, edges: UI_EDGES } as GraphArtifact);

  it("keeps the implicit render-subtree root (null focus) when EVERY anchor lives inside it", () => {
    const reveal = uiRevealStateForMany(["ts:web/ui/App.tsx#App", "ts:web/ui/Button.tsx#Button"], uiIndex);
    expect(reveal).not.toBeNull();
    // moduleFocus null == the lens's own render root; the container chains open beneath it.
    expect(reveal!.moduleFocus).toBeNull();
    expect(reveal!.moduleExpanded.has("ts:web/ui/App.tsx")).toBe(true);
    expect(reveal!.moduleExpanded.has("ts:web/ui/Button.tsx")).toBe(true);
    expect(reveal!.moduleSelected).toEqual(new Set(["ts:web/ui/App.tsx#App", "ts:web/ui/Button.tsx#Button"]));
  });

  it("dives to the anchors' common package when ANY anchor sits outside the render root", () => {
    const reveal = uiRevealStateForMany(["ts:web/ui/App.tsx#App", "ts:web/main.ts#main"], uiIndex);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleFocus).toBe("ts:web");
    expect(reveal!.moduleSelected).toEqual(new Set(["ts:web/ui/App.tsx#App", "ts:web/main.ts#main"]));
    expect(reveal!.moduleExpanded.has("ts:web/main.ts")).toBe(true);
  });
});
