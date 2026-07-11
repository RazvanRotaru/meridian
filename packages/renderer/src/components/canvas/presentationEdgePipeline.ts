/** The semantic edge pipeline with presentation-only hierarchy spokes kept on a separate rail. */

import type { Edge, Node } from "@xyflow/react";
import { bundleEdges } from "../../layout/edgeBundling";
import { fuseCycles } from "../../layout/cycleFusion";
import { routeFrameEdges } from "../../layout/edgeRouting";
import { spoolFanEdges } from "../../layout/edgeSpooling";
import { foldPairRibbons } from "../../layout/parallelWires";
import { fadeFaintWires } from "../../layout/wireSalience";
import type { HighwayFlags } from "./surfaceSpec";
import { partitionPresentationEdges, type PartitionedPresentationEdges } from "./presentationEdges";

/**
 * Prepare only semantic relationships for rendering. Hierarchy spokes are returned by identity and
 * appended by GraphSurface after wire interaction, so none can affect salience counts, fuse into a
 * cycle/ribbon, join a bundle/trunk/bus, or enter hover/evidence state.
 */
export function prepareCanvasEdges(
  edges: Edge[],
  nodes: Node[],
  selected: ReadonlySet<string>,
  showHighways: boolean,
  flags: HighwayFlags,
): PartitionedPresentationEdges {
  const { semanticEdges, hierarchyEdges } = partitionPresentationEdges(edges);
  let prepared = fuseCycles(fadeFaintWires(semanticEdges));
  if (showHighways) {
    if (flags.bundling) prepared = bundleEdges(prepared, nodes, selected);
    prepared = foldPairRibbons(prepared);
    if (flags.routing) prepared = routeFrameEdges(prepared, nodes);
    if (flags.spooling) prepared = spoolFanEdges(prepared);
  } else {
    prepared = foldPairRibbons(prepared);
  }
  return { semanticEdges: prepared, hierarchyEdges };
}
