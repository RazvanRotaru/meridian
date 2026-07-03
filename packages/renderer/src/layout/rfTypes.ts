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

/**
 * Highlight state stamped onto every edge when a path trace is active: "rest" = no trace
 * anywhere, "off" = a trace is active but this wire is not on it, "down"/"up" = on the path,
 * flowing away from / into the selected node.
 */
export type EdgeHighlight = "rest" | "off" | "down" | "up";

export type BlueprintEdgeData = {
  kind: string;
  weight: number;
  underlyingEdgeIds: string[];
  lifted: boolean;
  resolved: boolean;
  highlight: EdgeHighlight;
  /**
   * The ELK-routed polyline (root-absolute coords: start, bends, end). Nodes are not
   * draggable, so the route stays valid for the lifetime of one layout; the edge component
   * renders it with rounded corners instead of a naive handle-to-handle bezier.
   */
  points?: Array<{ x: number; y: number }>;
};

export type BlueprintEdge = Edge<BlueprintEdgeData, "blueprint">;
