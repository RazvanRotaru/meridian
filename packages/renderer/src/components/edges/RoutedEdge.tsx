/**
 * RoutedEdge — draws the gutter-bus path computed by layout/edgeRouting.ts verbatim. All styling
 * (weight-scaled width, relationship colour, emphasis opacity, cross-frame dash) arrives on the
 * edge's style exactly like a default edge; only the GEOMETRY is custom.
 */

import { BaseEdge, type EdgeProps } from "@xyflow/react";
import type { RoutedEdgeData } from "../../layout/edgeRouting";

export function RoutedEdge({ id, style, markerEnd, data }: EdgeProps) {
  return <BaseEdge id={id} path={(data as RoutedEdgeData).routedPath} style={style} markerEnd={markerEnd} />;
}
