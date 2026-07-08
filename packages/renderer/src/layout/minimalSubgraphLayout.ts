/**
 * Lay out a MinimalSubgraphSpec by MIRRORING the Module map: instead of a fresh ELK pass, every file
 * the map had on screen keeps its exact captured map position (`basePositions`), and the rest — off-map
 * neighbours, later expansions, and the [+n] stubs — is placed relative to a connected placed node
 * (see `minimalPlacement`). The result is FLAT: no package/group frames, no `parentId`. Group spec
 * nodes are simply ignored. File cards reuse the Map's OWN `file` card (ghost-tier dims in place), a
 * `minimalStub` is the directional [+n] expander. Deterministic — the placement is id-sorted and pure.
 */

import type { Edge, Node } from "@xyflow/react";
import { placeMinimalNodes, type PlacedRect } from "./minimalPlacement";
import type { MinimalStubData, MinimalSubgraphEdge, MinimalSubgraphNode, MinimalSubgraphSpec } from "../derive/minimalSubgraph";
import type { ModuleCardData } from "../derive/moduleLevel";
import { arrowMarker } from "../theme/edgeColors";

/** The React Flow node type the overlay registers on top of `moduleNodeTypes` for the [+n] expanders. */
export const MINIMAL_STUB_NODE = "minimalStub";

// Import wires mirror the Module map's at-rest coupling colours (gold cross-package, grey same-
// package); a stub tether is fainter still. Ghost files dim to this opacity — legible, still distinct.
const CROSS_PACKAGE_COLOR = "#C9A24B";
const SAME_PACKAGE_COLOR = "#5B6675";
const STUB_EDGE_COLOR = "#2A313C";
const GHOST_OPACITY = 0.62;

/** Mirror the map: place each visible file at its captured spot (others relative), flat, then wire. */
export function layoutMinimalSubgraph(
  spec: MinimalSubgraphSpec,
  basePositions: Record<string, PlacedRect>,
): { nodes: Node[]; edges: Edge[] } {
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const files = spec.nodes.filter((node) => node.kind === "file");
  const stubs = spec.nodes.filter((node) => node.kind === "stub");
  const placement = placeMinimalNodes({
    fileIds: files.map((node) => node.id),
    stubs: stubs.map((node) => stubDescriptor(node)),
    importEdges: spec.edges.filter((edge) => edge.kind === "import").map((edge) => ({ source: edge.source, target: edge.target })),
    basePositions,
  });
  const nodes: Node[] = [];
  for (const file of files) {
    const rect = placement[file.id];
    if (rect) {
      nodes.push(toFileNode(file, rect));
    }
  }
  for (const stub of stubs) {
    const rect = placement[stub.id];
    if (rect) {
      nodes.push(toStubNode(stub, rect));
    }
  }
  const placedIds = new Set(nodes.map((node) => node.id));
  const edges = spec.edges.filter((edge) => placedIds.has(edge.source) && placedIds.has(edge.target)).map(toRfEdge);
  return { nodes, edges };
}

function stubDescriptor(node: MinimalSubgraphNode): { id: string; sourceId: string; direction: "in" | "out" } {
  const data = node.data as MinimalStubData;
  return { id: node.id, sourceId: data.sourceId, direction: data.direction };
}

// A file is the Map's own `file` card at an absolute position; ghost tier dims in place. Emphasis (the
// seed's selection ring) comes from the store, so only the ghost dim needs a style here.
function toFileNode(node: MinimalSubgraphNode, rect: PlacedRect): Node {
  return {
    id: node.id,
    type: "file",
    position: { x: rect.x, y: rect.y },
    style: { width: rect.width, height: rect.height, ...(node.tier === "ghost" ? { opacity: GHOST_OPACITY } : {}) },
    data: node.data as ModuleCardData,
  };
}

function toStubNode(node: MinimalSubgraphNode, rect: PlacedRect): Node {
  return {
    id: node.id,
    type: MINIMAL_STUB_NODE,
    position: { x: rect.x, y: rect.y },
    style: { width: rect.width, height: rect.height },
    data: node.data as MinimalStubData,
  };
}

function toRfEdge(edge: MinimalSubgraphEdge): Edge {
  if (edge.kind === "stub") {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      style: { stroke: STUB_EDGE_COLOR, strokeWidth: 1, strokeDasharray: "2 3", opacity: 0.6 },
      selectable: false,
    };
  }
  const stroke = edge.crossPackage ? CROSS_PACKAGE_COLOR : SAME_PACKAGE_COLOR;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    style: { stroke, strokeWidth: 1.5, opacity: 0.5 },
    markerEnd: arrowMarker(stroke, 14),
    data: { weight: edge.weight },
  };
}
