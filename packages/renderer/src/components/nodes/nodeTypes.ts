/** The node-type registry React Flow resolves a node's `type` against. */

import type { NodeTypes } from "@xyflow/react";
import { ContainerNode } from "./ContainerNode";
import { LeafNode } from "./LeafNode";

export const nodeTypes: NodeTypes = {
  container: ContainerNode,
  leaf: LeafNode,
};
