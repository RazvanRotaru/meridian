/**
 * The Module-map's PAINT pipeline, extracted so every surface that reuses the Map's cards (the folder
 * Map, the minimal-graph overlay) repaints IDENTICALLY over its own laid-out graph — three pure
 * passes, never a relayout, so positions hold still:
 *   1. `filterVisible` drops file cards a category / Tests / Private toggle hides (frames always stay);
 *   2. `filterRelKinds` drops wires whose relationship kind is toggled off;
 *   3. `emphasize` dims every wire until a node is selected, then lights its N-hop reach (and beacons).
 * All toggle/selection inputs are read live from the store; the caller passes only the placed graph.
 */

import { useMemo } from "react";
import type { Edge, Node } from "@xyflow/react";
import { useBlueprint } from "../../state/StoreContext";
import { filterVisible, filterRelKinds, emphasize } from "../moduleMapPaint";

export function useModuleSurfacePaint(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[]; beacons: ReadonlySet<string> } {
  const selected = useBlueprint((state) => state.moduleSelected);
  const radius = useBlueprint((state) => state.moduleRadius);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const index = useBlueprint((state) => state.index);
  const hiddenCategories = useBlueprint((state) => state.hiddenCategories);
  const hiddenRelKinds = useBlueprint((state) => state.hiddenRelKinds);
  const showTests = useBlueprint((state) => state.showTests);
  const showPrivate = useBlueprint((state) => state.showPrivate);

  const { nodes: shownNodes, edges: visibleEdges } = useMemo(
    () => filterVisible(nodes, edges, { hiddenCategories, showTests, testIds: index.testIds, showPrivate, privateIds: index.privateIds }),
    [nodes, edges, hiddenCategories, showTests, showPrivate, index.testIds, index.privateIds],
  );
  const shownEdges = useMemo(() => filterRelKinds(visibleEdges, hiddenRelKinds), [visibleEdges, hiddenRelKinds]);
  return useMemo(
    () => emphasize(shownNodes, shownEdges, selected, radius, highlightMode),
    [shownNodes, shownEdges, selected, radius, highlightMode],
  );
}
