/**
 * Lay out a MinimalSubgraphSpec with ELK and map it to React Flow — the analog of `moduleLevelLayout`,
 * but NESTED: package/collapsed-chain frames recurse as ELK containers with title-bar padding, file
 * cards are leaves at a fixed size. The nesting, the root-only `hierarchyHandling` contract and the
 * parent-relative mapping live in `elkNesting`; this module only supplies the adapter, layout options
 * and edge styling. It reuses the Module-map's OWN card components (`moduleNodeTypes`): file leaves
 * render as read-only `file` cards, containment frames as read-only `package` frames. Boundary file
 * cards carry a dimming `style` and boundary-touching wires a `toBoundary` flag so the overlay reads
 * the faded 1-hop context. Deterministic — ELK layered is stable, no Math.random/Date.
 */

import type { Edge, Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import { runElkLayout } from "./elkLayout";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "./elkNesting";
import type { MinimalSubgraphEdge, MinimalSubgraphNode, MinimalSubgraphSpec } from "../derive/minimalSubgraph";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { ModulePackageData } from "../derive/packageOverview";
import type { ModuleGroupData } from "../derive/moduleTreeTypes";
import { arrowMarker } from "../theme/edgeColors";

/** An import wire's data: its multiplicity and whether it touches a boundary node (paint faded). */
export interface MinimalEdgeData {
  weight: number;
  toBoundary: boolean;
}

const FILE_WIDTH = 210;
const FILE_HEIGHT = 54;

// Quiet dark import wires; a boundary-touching one is thinner + dashed + dimmed (faded context).
const EDGE_COLOR = "#3A424E";
const BOUNDARY_OPACITY = 0.5;

// Layered left→right so importers sit left of what they import, with root-only INCLUDE_CHILDREN so a
// wire routes across frame boundaries. Mirrors the composition/logic surfaces so the lenses feel alike.
const ROOT_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "90",
  "elk.spacing.nodeNode": "40",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
};

// Top padding clears a frame's title bar (React Flow draws nothing there itself).
const CONTAINER_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.padding": "[top=42,left=16,bottom=16,right=16]",
};

const adapter: ElkNestAdapter<MinimalSubgraphNode> = {
  id: (node) => node.id,
  parentId: (node) => node.parentId,
  isContainer: (node) => node.kind === "group",
  leafSize: () => ({ width: FILE_WIDTH, height: FILE_HEIGHT }),
  containerOptions: CONTAINER_LAYOUT_OPTIONS,
};

/** Build the nested ELK graph, run it, and map the placed tree back to React Flow nodes/edges. */
export async function layoutMinimalSubgraph(spec: MinimalSubgraphSpec): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const laid = await runElkLayout(buildNestedElkGraph(spec.nodes, spec.edges, adapter, ROOT_LAYOUT_OPTIONS));
  const specById = new Map(spec.nodes.map((node) => [node.id, node]));
  const boundaryIds = new Set(spec.nodes.filter((node) => node.isBoundary).map((node) => node.id));
  const nodes = emitReactFlowNodes(laid, (elkNode, parentId) => {
    const node = specById.get(elkNode.id);
    return node ? toRfNode(elkNode, parentId, node) : null;
  });
  return { nodes, edges: spec.edges.map((edge) => toRfEdge(edge, boundaryIds)) };
}

// The overlay reuses the Module-map card components, so a group is a read-only `package` frame and a
// file a `file` card. Boundary neighbours dim in place (no bespoke variant — the "render plain" rule).
function toRfNode(elkNode: ElkNode, parentId: string | undefined, node: MinimalSubgraphNode): Node {
  if (node.kind === "group") {
    return {
      id: node.id,
      type: "package",
      ...parentRelativePlacement(elkNode, parentId),
      data: groupData(node),
    };
  }
  return {
    id: node.id,
    type: "file",
    ...parentRelativePlacement(elkNode, parentId),
    data: node.data as ModuleCardData,
    ...(node.isBoundary ? { style: { opacity: BOUNDARY_OPACITY } } : {}),
  };
}

/** A containment frame rendered by the Map's `PackageOverviewNode`: always an expanded, read-only frame. */
function groupData(node: MinimalSubgraphNode): ModuleGroupData {
  return { ...(node.data as ModulePackageData), isContainer: false, isExpanded: true, readOnly: true };
}

// A boundary-touching wire is the faded context/blast-radius link (thin, dashed, dimmed); an
// affected↔affected wire is the solid signal.
function toRfEdge(edge: MinimalSubgraphEdge, boundaryIds: ReadonlySet<string>): Edge {
  const toBoundary = boundaryIds.has(edge.source) || boundaryIds.has(edge.target);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    style: {
      stroke: EDGE_COLOR,
      strokeWidth: toBoundary ? 1 : 1.5,
      opacity: toBoundary ? 0.5 : 0.85,
      ...(toBoundary ? { strokeDasharray: "4 3" } : {}),
    },
    markerEnd: arrowMarker(EDGE_COLOR, 14),
    data: { weight: edge.weight, toBoundary } satisfies MinimalEdgeData,
  };
}
