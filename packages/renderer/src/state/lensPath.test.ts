import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { anchorNodeId, mapRevealStateFor, serviceRevealStateFor, uiRevealStateFor } from "./lensPath";

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

// A service + a repository it depends on, each a class with one method, under a src/ package.
const NODES: GraphNode[] = [
  node("ts:app", "package", undefined, "app"),
  node("ts:app/src", "package", "ts:app", "src"),
  node("ts:app/src/orders.ts", "module", "ts:app/src", "orders.ts"),
  node("ts:app/src/orders.ts#OrderService", "class", "ts:app/src/orders.ts", "OrderService"),
  node("ts:app/src/orders.ts#OrderService.place", "method", "ts:app/src/orders.ts#OrderService", "place"),
  node("ts:app/src/repo.ts", "module", "ts:app/src", "repo.ts"),
  node("ts:app/src/repo.ts#OrderRepository", "class", "ts:app/src/repo.ts", "OrderRepository"),
  node("ts:app/src/repo.ts#OrderRepository.save", "method", "ts:app/src/repo.ts#OrderRepository", "save"),
];

// OrderService instantiates + calls OrderRepository — the coupling that seeds a service cluster.
const EDGES: GraphEdge[] = [
  { id: "e1", source: "ts:app/src/orders.ts#OrderService", target: "ts:app/src/repo.ts#OrderRepository", kind: "instantiates", resolution: "resolved" },
  { id: "e2", source: "ts:app/src/orders.ts#OrderService.place", target: "ts:app/src/repo.ts#OrderRepository.save", kind: "calls", resolution: "resolved" },
] as GraphEdge[];

const index = buildGraphIndex({ nodes: NODES, edges: EDGES } as GraphArtifact);
const METHOD = "ts:app/src/orders.ts#OrderService.place";

describe("anchorNodeId", () => {
  const base = { moduleSelected: new Set<string>(), moduleEffectiveFocus: null, moduleFocus: null, selectedId: null, focusId: null, logicRoot: null };

  it("reads the module selection first on Map/Service", () => {
    expect(anchorNodeId({ ...base, viewMode: "modules", moduleSelected: new Set([METHOD]) })).toBe(METHOD);
    expect(anchorNodeId({ ...base, viewMode: "call", moduleFocus: "ts:app/src" })).toBe("ts:app/src");
  });

  it("reads selection then focus on UI, the root on Logic, nothing on PRs", () => {
    expect(anchorNodeId({ ...base, viewMode: "ui", selectedId: METHOD })).toBe(METHOD);
    expect(anchorNodeId({ ...base, viewMode: "ui", focusId: "ts:app/src/orders.ts" })).toBe("ts:app/src/orders.ts");
    expect(anchorNodeId({ ...base, viewMode: "logic", logicRoot: METHOD })).toBe(METHOD);
    expect(anchorNodeId({ ...base, viewMode: "prs" })).toBeNull();
  });
});

describe("mapRevealStateFor", () => {
  it("focuses the directory, expands the file, and selects the exact node", () => {
    const reveal = mapRevealStateFor(METHOD, index);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleFocus).toBe("ts:app/src");
    expect(reveal!.moduleSelected).toEqual(new Set([METHOD]));
    // File + class on the path are opened (within the src/ focus); the anchor itself is not.
    expect(reveal!.moduleExpanded).toEqual(new Set(["ts:app/src/orders.ts", "ts:app/src/orders.ts#OrderService"]));
  });

  it("returns null for a node in no file (a bare package)", () => {
    expect(mapRevealStateFor("ts:app/src", index)).toBeNull();
  });
});

describe("serviceRevealStateFor", () => {
  it("opens the owning service frame, keeps moduleFocus null, and selects the anchor", () => {
    const reveal = serviceRevealStateFor(METHOD, index, EDGES);
    expect(reveal).not.toBeNull();
    expect(reveal!.moduleFocus).toBeNull();
    expect(reveal!.moduleSelected).toEqual(new Set([METHOD]));
    // The frame owning OrderService's cluster is opened (a `svc:` id), so the class is drawn.
    expect([...reveal!.moduleExpanded].some((id) => id.startsWith("svc:"))).toBe(true);
  });

  it("returns null when the anchor sits in no clustered unit", () => {
    expect(serviceRevealStateFor("ts:app/src", index, EDGES)).toBeNull();
  });
});

describe("uiRevealStateFor", () => {
  it("expands the container chain and selects the anchor when it is a real node", () => {
    const reveal = uiRevealStateFor(METHOD, index);
    expect(reveal).not.toBeNull();
    expect(reveal!.selectedId).toBe(METHOD);
    expect(reveal!.expanded.has("ts:app/src/orders.ts")).toBe(true);
    expect(reveal!.expanded.has("ts:app/src/orders.ts#OrderService")).toBe(true);
  });

  it("returns null for an id that is not in the graph", () => {
    expect(uiRevealStateFor("ts:nope#ghost", index)).toBeNull();
  });
});
