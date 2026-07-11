import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode, LogicFlows } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "./moduleGraph";
import { buildBlockDeps } from "./blockDeps";
import { deriveServiceTree } from "./serviceClusterTree";
import { frameIdOf } from "./serviceClusterEdges";

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

// Three service-named classes — each seeds its OWN cluster (seeds are terminal in the ownership
// BFS) — coupled in a chain: Alpha → Beta → Gamma. Alpha never touches Gamma directly, which is
// exactly the shape the scoped sub-view must respect: scope {Alpha, Beta} keeps the A→B wire and
// GHOSTS the dropped B→Gamma coupling as a card for Gamma's lead (honest resolution — the wire
// must not silently vanish), while nothing of Gamma is drawn for real.
const ALPHA = "ts:app/a.ts#AlphaService";
const BETA = "ts:app/b.ts#BetaService";
const GAMMA = "ts:app/c.ts#GammaService";

const NODES: GraphNode[] = [
  node("ts:app", "package", undefined, "app"),
  node("ts:app/a.ts", "module", "ts:app", "a.ts"),
  node(ALPHA, "class", "ts:app/a.ts", "AlphaService"),
  node(`${ALPHA}.run`, "method", ALPHA, "run"),
  node("ts:app/b.ts", "module", "ts:app", "b.ts"),
  node(BETA, "class", "ts:app/b.ts", "BetaService"),
  node(`${BETA}.run`, "method", BETA, "run"),
  node("ts:app/c.ts", "module", "ts:app", "c.ts"),
  node(GAMMA, "class", "ts:app/c.ts", "GammaService"),
  node(`${GAMMA}.run`, "method", GAMMA, "run"),
];

const EDGES: GraphEdge[] = [
  { id: "e1", source: `${ALPHA}.run`, target: `${BETA}.run`, kind: "calls", resolution: "resolved" },
  { id: "e2", source: `${BETA}.run`, target: `${GAMMA}.run`, kind: "calls", resolution: "resolved" },
] as GraphEdge[];

const index = buildGraphIndex({ nodes: NODES, edges: EDGES } as GraphArtifact);
const graph = buildModuleGraph(index);
const deps = buildBlockDeps(index);
const flows = {} as LogicFlows;
const NONE = new Set<string>();

function frameIds(tree: { nodes: { id: string }[] }): string[] {
  return tree.nodes.map((n) => n.id).filter((id) => id.startsWith("svc:")).sort();
}

function ghostIds(tree: { nodes: { id: string; kind: string }[] }): string[] {
  return tree.nodes.filter((n) => n.kind === "ghost").map((n) => n.id).sort();
}

function ghostWire(tree: { edges: { source: string; target: string; ghost?: boolean }[] }, source: string, target: string) {
  return tree.edges.find((e) => e.ghost === true && e.source === source && e.target === target);
}

describe("deriveServiceTree scoping", () => {
  it("unscoped, all three clusters and both coupling wires draw, with NO ghosts (nothing is dropped)", () => {
    const tree = deriveServiceTree(index, null, NONE, graph, deps, flows);
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA), frameIdOf(BETA), frameIdOf(GAMMA)].sort());
    expect(tree.edges.some((e) => e.source === frameIdOf(ALPHA) && e.target === frameIdOf(BETA))).toBe(true);
    expect(tree.edges.some((e) => e.source === frameIdOf(BETA) && e.target === frameIdOf(GAMMA))).toBe(true);
    expect(ghostIds(tree)).toEqual([]);
    expect(tree.effectiveFocus).toBeNull();
  });

  it("scoped to {Alpha, Beta}: only their frames draw, the A→B wire stays, and the dropped B→Gamma coupling GHOSTS Gamma's lead", () => {
    const tree = deriveServiceTree(index, null, NONE, graph, deps, flows, { scopeLeadIds: new Set([ALPHA, BETA]) });
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA), frameIdOf(BETA)].sort());
    expect(tree.edges.some((e) => e.source === frameIdOf(ALPHA) && e.target === frameIdOf(BETA))).toBe(true);
    // The out-of-scope endpoint is a GHOST card for its lead, wired from the in-scope frame.
    expect(ghostIds(tree)).toEqual([GAMMA]);
    expect(ghostWire(tree, frameIdOf(BETA), GAMMA)).toBeDefined();
    // Nothing REAL of Gamma is drawn: no frame, and every non-ghost edge stays clear of it.
    const mentionsGamma = (id: string) => id.includes("GammaService");
    expect(tree.nodes.some((n) => n.kind !== "ghost" && mentionsGamma(n.id))).toBe(false);
    expect(tree.edges.some((e) => e.ghost !== true && (mentionsGamma(e.source) || mentionsGamma(e.target)))).toBe(false);
  });

  it("scoped to a single cluster ghosts its outbound coupling (Alpha → ghost Beta), nothing else", () => {
    const tree = deriveServiceTree(index, null, NONE, graph, deps, flows, { scopeLeadIds: new Set([ALPHA]) });
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA)]);
    expect(ghostIds(tree)).toEqual([BETA]);
    expect(ghostWire(tree, frameIdOf(ALPHA), BETA)).toBeDefined();
    // B→Gamma has neither end in scope — no ghost, no wire.
    expect(tree.nodes.some((n) => n.id.includes("GammaService"))).toBe(false);
  });

  it("an INBOUND dropped coupling ghosts the caller's lead, wired INTO the scoped frame", () => {
    const tree = deriveServiceTree(index, null, NONE, graph, deps, flows, { scopeLeadIds: new Set([GAMMA]) });
    expect(frameIds(tree)).toEqual([frameIdOf(GAMMA)]);
    expect(ghostIds(tree)).toEqual([BETA]);
    expect(ghostWire(tree, BETA, frameIdOf(GAMMA))).toBeDefined();
  });

  it("scope ghosts respect the Tests toggle (a hidden lead never ghosts)", () => {
    const tree = deriveServiceTree(index, null, NONE, graph, deps, flows, {
      scopeLeadIds: new Set([ALPHA, BETA]),
      hiddenIds: new Set([GAMMA]),
    });
    expect(ghostIds(tree)).toEqual([]);
    expect(tree.edges.some((e) => e.ghost === true)).toBe(false);
  });
});

describe("deriveServiceTree focus (cluster zoom)", () => {
  it("focus on a cluster draws ONLY that frame, force-expanded, and reports effectiveFocus", () => {
    const tree = deriveServiceTree(index, frameIdOf(BETA), NONE, graph, deps, flows);
    expect(frameIds(tree)).toEqual([frameIdOf(BETA)]);
    expect(tree.effectiveFocus).toBe(frameIdOf(BETA));
    const frame = tree.nodes.find((n) => n.id === frameIdOf(BETA))!;
    expect(frame.isExpanded).toBe(true);
    // Members render at their usual depth: the unit card and its method block.
    expect(tree.nodes.some((n) => n.id === BETA && n.kind === "unit")).toBe(true);
    expect(tree.nodes.some((n) => n.id === `${BETA}.run` && n.kind === "block")).toBe(true);
  });

  it("focus ghosts BOTH coupling directions as exact caller/callee methods without same-folder folding", () => {
    const tree = deriveServiceTree(index, frameIdOf(BETA), NONE, graph, deps, flows);
    // The off-screen caller wires INTO Beta's drawn method and the off-screen callee wires OUT;
    // sharing ts:app no longer erases either callable identity.
    expect(ghostIds(tree)).toEqual([`${ALPHA}.run`, `${GAMMA}.run`]);
    expect(ghostWire(tree, `${ALPHA}.run`, `${BETA}.run`)).toBeDefined();
    expect(ghostWire(tree, `${BETA}.run`, `${GAMMA}.run`)).toBeDefined();
  });

  it("a non-svc or unknown focus is ignored: full lens, effectiveFocus null", () => {
    const folderFocus = deriveServiceTree(index, "ts:app", NONE, graph, deps, flows);
    expect(frameIds(folderFocus)).toHaveLength(3);
    expect(folderFocus.effectiveFocus).toBeNull();
    const staleFocus = deriveServiceTree(index, "svc:ts:app/z.ts#NopeService", NONE, graph, deps, flows);
    expect(staleFocus.effectiveFocus).toBeNull();
    expect(frameIds(staleFocus)).toHaveLength(3);
  });

  it("focus composes with scope: the zoom draws inside the kept set; couplings leaving the zoom ghost", () => {
    const tree = deriveServiceTree(index, frameIdOf(ALPHA), NONE, graph, deps, flows, { scopeLeadIds: new Set([ALPHA, BETA]) });
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA)]);
    expect(tree.effectiveFocus).toBe(frameIdOf(ALPHA));
    // Alpha's code is drawn (forced open), so the walk tier ghosts Beta's exact called method.
    expect(ghostIds(tree)).toEqual([`${BETA}.run`]);
    expect(ghostWire(tree, `${ALPHA}.run`, `${BETA}.run`)).toBeDefined();
  });

  it("a focus OUTSIDE the scope is ignored (the zoom can only dive what the scope kept)", () => {
    const tree = deriveServiceTree(index, frameIdOf(GAMMA), NONE, graph, deps, flows, { scopeLeadIds: new Set([ALPHA, BETA]) });
    expect(tree.effectiveFocus).toBeNull();
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA), frameIdOf(BETA)].sort());
  });

  it("walk-tier ghosts respect the Tests toggle (hiddenIds)", () => {
    const tree = deriveServiceTree(index, frameIdOf(BETA), NONE, graph, deps, flows, { hiddenIds: new Set([GAMMA]) });
    expect(ghostIds(tree)).toEqual([`${ALPHA}.run`]);
  });
});
