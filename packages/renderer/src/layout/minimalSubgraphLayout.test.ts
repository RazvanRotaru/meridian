/**
 * The minimal-graph overlay's TWO layout regimes:
 *   - no expanded frame  → the captured-position mirror is returned byte-for-byte (hard regression
 *     constraint: expanding nothing must never move a card);
 *   - one expanded frame → an interactive-layered ELK reflow opens spacing so no two top-level file
 *     rects overlap, even when the captured seeds were overlapping to begin with.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import type { Node } from "@xyflow/react";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "../derive/moduleGraph";
import { buildMinimalSubgraph } from "../derive/minimalSubgraph";
import { layoutMinimalSubgraph } from "./minimalSubgraphLayout";
import type { PlacedRect } from "./minimalPlacement";

function pkg(id: string, name: string, parentId: string | null): GraphNode {
  return { id, kind: "package", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}
function npmPkg(id: string, name: string, parentId: string | null): GraphNode {
  return { ...pkg(id, name, parentId), tags: ["npm-package"] } as GraphNode;
}
function mod(id: string, file: string, parentId: string | null): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } } as GraphNode;
}
function fn(id: string, name: string, parentId: string): GraphNode {
  return { id, kind: "function", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}
function importEdge(source: string, target: string): GraphEdge {
  return { id: `imports:${source}->${target}`, source, target, kind: "imports", resolution: "resolved" } as GraphEdge;
}

// a.ts declares foo()/bar() (so its card is an expandable, class-heavy frame) and imports b.ts.
const NODES = [
  npmPkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  mod("m:a", "src/a.ts", "p:src"),
  mod("m:b", "src/b.ts", "p:src"),
  fn("fn:foo", "foo", "m:a"),
  fn("fn:bar", "bar", "m:a"),
];
const EDGES = [importEdge("m:a", "m:b")];

// A rolled PR directory has no captured map rectangle: review setup intentionally starts its
// minimal overlay from an empty base-position map. Its changed file lets the emitted summary data
// exercise the same changedInside channel that renders the amber Δ chip.
const ROLLED_GROUP_NODES: GraphNode[] = [
  pkg("p:root", "root", null),
  pkg("p:src", "src", "p:root"),
  { ...mod("m:a", "src/a.ts", "p:src"), tags: ["changed"] },
  mod("m:b", "src/b.ts", "p:src"),
];

function rolledGroupSpec() {
  const index = buildGraphIndex({ nodes: ROLLED_GROUP_NODES, edges: [] } as unknown as GraphArtifact);
  const graph = buildModuleGraph(index);
  return buildMinimalSubgraph(index, graph, new Set(["p:src"]), new Set(["p:src"]), {
    expanded: new Set(),
    blockDeps: { edges: [] },
    flows: {},
  });
}

function specFor(expanded: string[]) {
  const index = buildGraphIndex({ nodes: NODES, edges: EDGES } as unknown as GraphArtifact);
  const graph = buildModuleGraph(index);
  return buildMinimalSubgraph(index, graph, new Set(["m:a", "m:b"]), new Set(["m:a"]), {
    expanded: new Set(expanded),
    blockDeps: { edges: [] },
    flows: {},
  });
}

// foo() in a.ts calls baz() in b.ts — the overlay spec carries a per-kind dep wire a→b.
function couplingSpec() {
  const nodes = [...NODES, fn("fn:baz", "baz", "m:b")];
  const calls = { id: "calls:fn:foo->fn:baz", source: "fn:foo", target: "fn:baz", kind: "calls", resolution: "resolved" } as GraphEdge;
  const index = buildGraphIndex({ nodes, edges: [...EDGES, calls] } as unknown as GraphArtifact);
  const graph = buildModuleGraph(index);
  return buildMinimalSubgraph(index, graph, new Set(["m:a", "m:b"]), new Set(["m:a"]), {
    expanded: new Set(),
    blockDeps: { edges: [calls] },
    flows: {},
  });
}

// A dependency-only artifact: b.ts calls a.ts, but there is deliberately NO imports edge. The
// arranged graph must still use that visible coupling as its rightward layout substrate.
function depOnlyCouplingSpec() {
  const nodes = [...NODES, fn("fn:baz", "baz", "m:b")];
  const calls = { id: "calls:fn:baz->fn:foo", source: "fn:baz", target: "fn:foo", kind: "calls", resolution: "resolved" } as GraphEdge;
  const index = buildGraphIndex({ nodes, edges: [calls] } as unknown as GraphArtifact);
  return buildMinimalSubgraph(index, buildModuleGraph(index), new Set(["m:a", "m:b"]), new Set(["m:a", "m:b"]), {
    expanded: new Set(),
    blockDeps: { edges: [calls] },
    flows: {},
  });
}

function highDegreeSpec() {
  const targets = Array.from({ length: 23 }, (_, index) => {
    const fileId = `m:peer-${index}`;
    const functionId = `fn:peer-${index}`;
    return {
      nodes: [mod(fileId, `src/peer-${index}.ts`, "p:src"), fn(functionId, `peer${index}`, fileId)],
      edge: {
        id: `calls:fn:foo->${functionId}`,
        source: "fn:foo",
        target: functionId,
        kind: "calls",
        resolution: "resolved",
      } as GraphEdge,
    };
  });
  const calls = targets.map(({ edge }) => edge);
  const index = buildGraphIndex({
    nodes: [...NODES, ...targets.flatMap(({ nodes }) => nodes)],
    edges: [...EDGES, ...calls],
  } as unknown as GraphArtifact);
  return buildMinimalSubgraph(index, buildModuleGraph(index), new Set(["m:a"]), new Set(["m:a"]), {
    expanded: new Set(),
    blockDeps: { edges: calls },
    flows: {},
  });
}

// Two package.json-backed member files. With both members present the import is an on-view package
// crossing; with only the source present, its call charts the target as an always-visible satellite.
const CROSS_PACKAGE_NODES = [
  pkg("p:workspace", "workspace", null),
  npmPkg("p:left", "left", "p:workspace"),
  mod("m:left", "left/a.ts", "p:left"),
  fn("fn:left", "left", "m:left"),
  npmPkg("p:right", "right", "p:workspace"),
  mod("m:right", "right/b.ts", "p:right"),
  fn("fn:right", "right", "m:right"),
];
const CROSS_PACKAGE_IMPORT = importEdge("m:left", "m:right");
const CROSS_PACKAGE_CALL = {
  id: "calls:fn:left->fn:right",
  source: "fn:left",
  target: "fn:right",
  kind: "calls",
  resolution: "resolved",
} as GraphEdge;

function crossPackageSpec(includeTarget: boolean) {
  const index = buildGraphIndex({
    nodes: CROSS_PACKAGE_NODES,
    edges: [CROSS_PACKAGE_IMPORT, CROSS_PACKAGE_CALL],
  } as unknown as GraphArtifact);
  const members = new Set(includeTarget ? ["m:left", "m:right"] : ["m:left"]);
  return buildMinimalSubgraph(index, buildModuleGraph(index), members, members, {
    expanded: new Set(),
    blockDeps: { edges: [CROSS_PACKAGE_CALL] },
    flows: {},
  });
}

const rectOf = (node: Node): PlacedRect => {
  const style = (node.style ?? {}) as { width?: number; height?: number };
  return { x: node.position.x, y: node.position.y, width: style.width ?? 0, height: style.height ?? 0 };
};
const overlaps = (a: PlacedRect, b: PlacedRect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const topLevelFiles = (nodes: Node[]): Node[] => nodes.filter((node) => node.type === "file" && node.parentId === undefined);

describe("layoutMinimalSubgraph", () => {
  it("mirrors the captured positions byte-for-byte when nothing is expanded", async () => {
    const base: Record<string, PlacedRect> = {
      "m:a": { x: 10, y: 20, width: 200, height: 50 },
      "m:b": { x: 400, y: 80, width: 180, height: 60 },
    };
    const { nodes } = await layoutMinimalSubgraph(specFor([]), base);
    expect(rectOf(nodes.find((node) => node.id === "m:a")!)).toEqual(base["m:a"]);
    expect(rectOf(nodes.find((node) => node.id === "m:b")!)).toEqual(base["m:b"]);
  });

  it("renders an uncaptured rolled directory as the full read-only package summary card", async () => {
    const { nodes } = await layoutMinimalSubgraph(rolledGroupSpec(), {});
    const group = nodes.find((node) => node.id === "p:src");

    expect(group).toMatchObject({
      id: "p:src",
      type: "package",
      style: { width: 300, height: 60 },
      data: {
        label: "src",
        fileCount: 2,
        changedInside: 1,
        ca: 0,
        ce: 0,
        isContainer: false,
        isExpanded: false,
        readOnly: true,
        tier: "seed",
      },
    });
  });

  it("opens spacing so no two top-level file frames overlap once a file is expanded", async () => {
    // Captured seeds deliberately OVERLAP (a's 210-wide card straddles b at x=50): the flat mirror
    // would keep them overlapping, but expanding a must trigger the reflow that separates them.
    const base: Record<string, PlacedRect> = {
      "m:a": { x: 0, y: 0, width: 210, height: 54 },
      "m:b": { x: 50, y: 0, width: 210, height: 54 },
    };
    const { nodes } = await layoutMinimalSubgraph(specFor(["m:a"]), base);
    const files = topLevelFiles(nodes);
    expect(files).toHaveLength(2);
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        expect(overlaps(rectOf(files[i]), rectOf(files[j]))).toBe(false);
      }
    }
  });

  it("uses visible dependency edges for arranged artifacts that have no import edges", async () => {
    const { nodes } = await layoutMinimalSubgraph(depOnlyCouplingSpec(), {}, true);
    const a = nodes.find((node) => node.id === "m:a")!;
    const b = nodes.find((node) => node.id === "m:b")!;

    expect(b.position.x).toBeLessThan(a.position.x);
  });

  it("emits a dep wire data-only (category/depKind for the paint chain), with no baked style", async () => {
    const base: Record<string, PlacedRect> = {
      "m:a": { x: 0, y: 0, width: 210, height: 54 },
      "m:b": { x: 400, y: 0, width: 210, height: 54 },
    };
    const { edges } = await layoutMinimalSubgraph(couplingSpec(), base);
    const dep = edges.find((edge) => edge.id === "dep:calls:m:a->m:b");
    expect(dep?.data).toEqual({
      weight: 1,
      crossFrame: false,
      crossPackage: false,
      outsideView: false,
      category: "dep",
      relationKind: "calls",
      depKind: "calls",
      ghost: false,
      underlyingEdgeIds: ["calls:fn:foo->fn:baz"],
    });
    expect(dep?.style).toBeUndefined();
  });

  it("propagates true package ownership independently from the drawn-frame colour cue", async () => {
    const base: Record<string, PlacedRect> = {
      "m:left": { x: 0, y: 0, width: 210, height: 54 },
      "m:right": { x: 400, y: 0, width: 210, height: 54 },
    };
    const { edges } = await layoutMinimalSubgraph(crossPackageSpec(true), base);
    const importWire = edges.find((edge) => edge.id === "min:m:left->m:right");
    expect(importWire?.data).toMatchObject({
      crossFrame: true,
      crossPackage: true,
      outsideView: false,
      ghost: false,
      underlyingEdgeIds: [CROSS_PACKAGE_IMPORT.id],
    });
    const depWire = edges.find((edge) => edge.id === "dep:calls:m:left->m:right");
    expect(depWire?.data).toMatchObject({
      crossFrame: false,
      crossPackage: true,
      outsideView: false,
      ghost: false,
      underlyingEdgeIds: [CROSS_PACKAGE_CALL.id],
    });
  });

  it("keeps satellite outsideView semantics and marks it for selection-driven visibility", async () => {
    const base: Record<string, PlacedRect> = {
      "m:left": { x: 0, y: 0, width: 210, height: 54 },
    };
    const { nodes, edges } = await layoutMinimalSubgraph(crossPackageSpec(false), base);
    expect(nodes.some((node) => node.id === "fn:right" && node.type === "ghost")).toBe(true);
    const ghostWire = edges.find((edge) => edge.id === "gdep:calls:m:left->fn:right");
    expect(ghostWire?.data).toMatchObject({
      crossFrame: false,
      crossPackage: true,
      outsideView: true,
      ghost: true,
      underlyingEdgeIds: [CROSS_PACKAGE_CALL.id],
    });
  });

  it("lays out every minimal ghost beyond the former twenty-item evidence window", async () => {
    const base: Record<string, PlacedRect> = {
      "m:a": { x: 0, y: 0, width: 210, height: 54 },
    };
    const { nodes, edges } = await layoutMinimalSubgraph(highDegreeSpec(), base);
    const ghostNodes = nodes.filter((node) => node.type === "ghost");
    const ghostWires = edges.filter((edge) => edge.id.startsWith("gdep:calls:"));

    expect(ghostNodes).toHaveLength(23);
    expect(ghostWires).toHaveLength(23);
    expect(ghostWires.every((edge) => (edge.data as { underlyingEdgeIds?: string[] }).underlyingEdgeIds?.length === 1)).toBe(true);
  });
});
