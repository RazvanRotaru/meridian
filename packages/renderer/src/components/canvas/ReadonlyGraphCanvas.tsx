/**
 * The deliberately small canvas shared by every graph family. It owns only the interaction-neutral
 * React Flow shell and its chrome; callers still own their node/edge vocabulary, paint pipeline,
 * navigation model and selection semantics.
 *
 * This seam is intentionally lower-level than `GraphSurface`: the module map wraps it with
 * relationship paint, highways, ghost inspection and semantic-parent zoom, while Logic Flow wraps
 * it with execution-order paint, caller shortcuts and an explicit drill breadcrumb. A flow has no
 * canonical parent graph, so none of the module semantic-navigation machinery belongs here.
 */

import type { ReactNode } from "react";
import {
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowProps,
} from "@xyflow/react";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./flowCanvasProps";

export type ReadonlyGraphCanvasProps<
  NodeType extends Node = Node,
  EdgeType extends Edge = Edge,
> = Omit<ReactFlowProps<NodeType, EdgeType>, keyof typeof READONLY_CANVAS_PROPS> &
  Partial<Pick<ReactFlowProps<NodeType, EdgeType>, keyof typeof READONLY_CANVAS_PROPS>> & {
    miniMapColor: (node: Node) => string;
    minimap?: boolean;
    children?: ReactNode;
  };

export function ReadonlyGraphCanvas<
  NodeType extends Node = Node,
  EdgeType extends Edge = Edge,
>({ miniMapColor, minimap = true, children, ...flowProps }: ReadonlyGraphCanvasProps<NodeType, EdgeType>) {
  return (
    <ReactFlow<NodeType, EdgeType>
      {...READONLY_CANVAS_PROPS}
      {...flowProps}
    >
      <CanvasChrome nodeColor={miniMapColor} minimap={minimap} />
      {children}
    </ReactFlow>
  );
}
