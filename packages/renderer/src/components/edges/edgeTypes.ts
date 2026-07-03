/** The edge-type registry React Flow resolves an edge's `type` against. */

import type { EdgeTypes } from "@xyflow/react";
import { BlueprintEdge } from "./BlueprintEdge";

export const edgeTypes: EdgeTypes = {
  blueprint: BlueprintEdge,
};
