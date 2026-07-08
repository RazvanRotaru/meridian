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

/** The React Flow node type the overlay registers on top of `moduleNodeTypes` for the [+n] expanders. */
export const MINIMAL_STUB_NODE = "minimalStub";

// A stub tether is styled here (it stays untouched by the component's emphasis pass). Import wires
// carry only map-shaped `data` — the component's `emphasize` colours them by coupling / selection.
const STUB_EDGE_COLOR = "#2A313C";

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

// A file is the Map's own `file` card at an absolute position. It carries its `tier` so the component
// can dim ghosts UNDER the shared `emphasize` selection paint (no opacity is baked here anymore).
function toFileNode(node: MinimalSubgraphNode, rect: PlacedRect): Node {
  return {
    id: node.id,
    type: "file",
    position: { x: rect.x, y: rect.y },
    style: { width: rect.width, height: rect.height },
    data: { ...(node.data as ModuleCardData), tier: node.tier },
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
  // No baked stroke/marker: the component's `emphasize` styles import wires by coupling at rest and
  // lights the selection's neighbourhood. `data` is the map's edge shape emphasize reads.
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: { weight: edge.weight, crossFrame: edge.crossPackage ?? false, category: "import", ghost: false },
  };
}
