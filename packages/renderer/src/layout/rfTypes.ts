/**
 * React Flow node/edge shapes. The artifact `node.id` IS the React Flow node id and the
 * telemetry join key, so these carry the original `GraphNode` straight through — never a
 * remapped identifier. Data types are `type` aliases (not interfaces) so they satisfy React
 * Flow's `Record<string, unknown>` data constraint via an implicit index signature.
 */

import type { Edge, Node } from "@xyflow/react";
import type { GraphNode } from "@meridian/core";

export type BlueprintNodeKind = "container" | "leaf";

export type BlueprintNodeData = {
  node: GraphNode;
  isContainer: boolean;
  isExpanded: boolean;
  childCount: number;
};

export type BlueprintNode = Node<BlueprintNodeData, BlueprintNodeKind>;

export type BlueprintEdgeData = {
  kind: string;
  weight: number;
  underlyingEdgeIds: string[];
  lifted: boolean;
  resolved: boolean;
};

export type BlueprintEdge = Edge<BlueprintEdgeData, "blueprint">;
