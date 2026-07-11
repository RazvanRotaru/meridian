/**
 * A neutral disclosure spoke from a persistent ghost parent to one revealed member. It deliberately
 * uses a bare SVG path rather than BaseEdge: no arrow, label, pulse, interaction hit-path, tooltip,
 * selection, or evidence inspector can make this presentation relationship read as code coupling.
 */

import { getStraightPath, type EdgeProps } from "@xyflow/react";

export const GHOST_HIERARCHY_EDGE_TYPE = "ghostHierarchy";

export function GhostHierarchyEdge({ id, sourceX, sourceY, targetX, targetY, style }: EdgeProps) {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return (
    <path
      id={id}
      d={path}
      fill="none"
      aria-hidden="true"
      style={{
        ...style,
        stroke: "#4B535F",
        strokeWidth: 1,
        strokeDasharray: "2 4",
        opacity: 0.62,
        pointerEvents: "none",
      }}
    />
  );
}
