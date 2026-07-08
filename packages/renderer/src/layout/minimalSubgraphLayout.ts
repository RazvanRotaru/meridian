/**
 * Lay out a MinimalSubgraphSpec with ELK and map it to React Flow — the analog of `moduleLevelLayout`,
 * but NESTED: package/collapsed-chain frames recurse as ELK containers with title-bar padding, file
 * cards and [+n] stubs are leaves. The nesting, the root-only `hierarchyHandling` contract and the
 * parent-relative mapping live in `elkNesting`; this module only supplies the adapter, layout options
 * and edge styling. It reuses the Module-map's OWN card components (`moduleNodeTypes`): file leaves
 * render as read-only `file` cards, containment frames as read-only `package` frames; a `minimalStub`
 * is the directional [+n] expander. Ghost-tier files dim in place. Deterministic — ELK layered is
 * stable, no Math.random/Date.
 */

import type { Edge, Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import { runElkLayout } from "./elkLayout";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "./elkNesting";
import type { MinimalStubData, MinimalSubgraphEdge, MinimalSubgraphNode, MinimalSubgraphSpec } from "../derive/minimalSubgraph";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { ModulePackageData } from "../derive/packageOverview";
import type { ModuleGroupData } from "../derive/moduleTreeTypes";
import { arrowMarker } from "../theme/edgeColors";

/** The React Flow node type the overlay registers on top of `moduleNodeTypes` for the [+n] expanders. */
export const MINIMAL_STUB_NODE = "minimalStub";

const FILE_WIDTH = 210;
const FILE_HEIGHT = 54;
const STUB_WIDTH = 48;
const STUB_HEIGHT = 30;

// Quiet dark import wires; a stub tether is fainter still. Ghost files dim to this opacity.
const EDGE_COLOR = "#3A424E";
const STUB_EDGE_COLOR = "#2A313C";
const GHOST_OPACITY = 0.45;

// Layered left→right so importers sit left of what they import (and [+in] stubs sit left, [+out]
// right), with root-only INCLUDE_CHILDREN so a wire routes across frame boundaries.
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
  leafSize: (node) => (node.kind === "stub" ? { width: STUB_WIDTH, height: STUB_HEIGHT } : { width: FILE_WIDTH, height: FILE_HEIGHT }),
  containerOptions: CONTAINER_LAYOUT_OPTIONS,
};

/** Build the nested ELK graph, run it, and map the placed tree back to React Flow nodes/edges. */
export async function layoutMinimalSubgraph(spec: MinimalSubgraphSpec): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const laid = await runElkLayout(buildNestedElkGraph(spec.nodes, spec.edges, adapter, ROOT_LAYOUT_OPTIONS));
  const specById = new Map(spec.nodes.map((node) => [node.id, node]));
  const nodes = emitReactFlowNodes(laid, (elkNode, parentId) => {
    const node = specById.get(elkNode.id);
    return node ? toRfNode(elkNode, parentId, node) : null;
  });
  return { nodes, edges: spec.edges.map(toRfEdge) };
}

// A file is a Map `file` card (ghost tier dimmed in place), a group a read-only `package` frame, a
// stub the directional [+n] expander. Emphasis (the seed's selection ring) comes from the store, so
// only the ghost dim needs a style here.
function toRfNode(elkNode: ElkNode, parentId: string | undefined, node: MinimalSubgraphNode): Node {
  const placement = parentRelativePlacement(elkNode, parentId);
  if (node.kind === "group") {
    return { id: node.id, type: "package", ...placement, data: groupData(node) };
  }
  if (node.kind === "stub") {
    return { id: node.id, type: MINIMAL_STUB_NODE, ...placement, data: node.data as MinimalStubData };
  }
  return {
    id: node.id,
    type: "file",
    ...placement,
    data: node.data as ModuleCardData,
    ...(node.tier === "ghost" ? { style: { opacity: GHOST_OPACITY } } : {}),
  };
}

/** A containment frame rendered by the Map's `PackageOverviewNode`: always an expanded, read-only frame. */
function groupData(node: MinimalSubgraphNode): ModuleGroupData {
  return { ...(node.data as ModulePackageData), isContainer: false, isExpanded: true, readOnly: true };
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
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    style: { stroke: EDGE_COLOR, strokeWidth: 1.5, opacity: 0.85 },
    markerEnd: arrowMarker(EDGE_COLOR, 14),
    data: { weight: edge.weight },
  };
}
