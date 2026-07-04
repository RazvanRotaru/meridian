/**
 * Build the visible set as a NESTED ELK graph that mirrors React Flow's parentId nesting.
 *
 * Containers recurse as ELK children with padding for the title bar; leaf/collapsed nodes carry a
 * fixed size. The root-only `hierarchyHandling: INCLUDE_CHILDREN` contract and the parentId nesting
 * itself live in `elkNesting`; this module only supplies the call-flow adapter and layout options.
 */

import type { ElkNode } from "elkjs/lib/elk-api";
import type { LiftedEdge, VisibleNode } from "../derive/types";
import { buildNestedElkGraph, type ElkNestAdapter } from "./elkNesting";
import { boxSize } from "./nodeSize";

export { ELK_ROOT_ID } from "./elkNesting";

const ROOT_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.nodeNode": "34",
  "elk.padding": "[top=28,left=28,bottom=28,right=28]",
};

// Top padding leaves room for the container's title bar; React Flow draws nothing there itself.
const CONTAINER_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.padding": "[top=46,left=18,bottom=18,right=18]",
};

const adapter: ElkNestAdapter<VisibleNode> = {
  id: (node) => node.id,
  parentId: (node) => node.node.parentId,
  isContainer: (node) => node.isExpanded,
  leafSize: (node) => boxSize(node),
  containerOptions: CONTAINER_LAYOUT_OPTIONS,
};

export function buildElkGraph(visible: VisibleNode[], edges: LiftedEdge[]): ElkNode {
  return buildNestedElkGraph(visible, edges, adapter, ROOT_LAYOUT_OPTIONS);
}
