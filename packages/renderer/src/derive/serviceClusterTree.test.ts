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
// exactly the shape the scoped sub-view must respect: scope {Alpha, Beta} keeps the A→B wire but
// draws nothing of Gamma, not even the B→G wire (no ghosts — the lens invariant).
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

describe("deriveServiceTree scoping", () => {
  it("unscoped, all three clusters and both coupling wires draw (the fixture sanity check)", () => {
    const tree = deriveServiceTree(index, NONE, graph, deps, flows);
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA), frameIdOf(BETA), frameIdOf(GAMMA)].sort());
    expect(tree.edges.some((e) => e.source === frameIdOf(ALPHA) && e.target === frameIdOf(BETA))).toBe(true);
    expect(tree.edges.some((e) => e.source === frameIdOf(BETA) && e.target === frameIdOf(GAMMA))).toBe(true);
  });

  it("scoped to {Alpha, Beta}: only their frames draw, the A→B wire stays, nothing touches Gamma", () => {
    const tree = deriveServiceTree(index, NONE, graph, deps, flows, new Set([ALPHA, BETA]));
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA), frameIdOf(BETA)].sort());
    expect(tree.edges.some((e) => e.source === frameIdOf(ALPHA) && e.target === frameIdOf(BETA))).toBe(true);
    const mentionsGamma = (id: string) => id.includes("GammaService");
    expect(tree.nodes.some((n) => mentionsGamma(n.id))).toBe(false);
    expect(tree.edges.some((e) => mentionsGamma(e.source) || mentionsGamma(e.target))).toBe(false);
  });

  it("scoped to a single cluster draws its frame alone, with no coupling wires at all", () => {
    const tree = deriveServiceTree(index, NONE, graph, deps, flows, new Set([ALPHA]));
    expect(frameIds(tree)).toEqual([frameIdOf(ALPHA)]);
    expect(tree.edges).toEqual([]);
  });
});
