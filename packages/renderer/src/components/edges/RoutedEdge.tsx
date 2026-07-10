/**
 * RoutedEdge — draws the gutter-bus path computed by layout/edgeRouting.ts verbatim. All styling
 * (weight-scaled width, relationship colour, emphasis opacity, cross-frame dash) arrives on the
 * edge's style exactly like a default edge; only the GEOMETRY is custom.
 */

import { BaseEdge, type EdgeProps } from "@xyflow/react";
import type { RoutedEdgeData } from "../../layout/edgeRouting";
import { WirePulse } from "./WireEdge";

export function RoutedEdge({ id, style, markerEnd, data, interactionWidth }: EdgeProps) {
  const path = (data as RoutedEdgeData).routedPath;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      <WirePulse path={path} style={style} data={data} />
    </>
  );
}
