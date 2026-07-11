/**
 * The module surfaces' PAINT pipeline — extracted pure (originally from `MinimalGraphView`, hence
 * the name) so colour parity across the Map, Service, and overlay surfaces is unit-testable, and
 * now the ONE chain the shared `GraphSurface` runs for every one of them. Every drawn card — file
 * frames, group (package) member cards, ghost satellites, AND an expanded file's nested
 * unit/block/step declarations — goes through the Map's OWN chain (`suppressRedundantImports` →
 * `filterRelKinds` → `emphasize`), so relationship colours (calls / instantiates / extends /
 * implements / references, and the import golds), the dim-at-rest read, and the selection walk are
 * the Map's by construction. Ghost satellites even reposition selection-relative inside
 * `emphasize` (`repositionLitGhosts`) — the Map's own beside-the-selection banding. The minimal
 * overlay preserves the same ghost-edge marker, so changing selection swaps the visible exploration
 * frontier instead of leaving the initial member ring permanently on screen.
 */

import type { Edge, Node } from "@xyflow/react";
import {
  emphasize,
  filterRelationsForLens,
  filterRelKinds,
  suppressRedundantImports,
  type EmphasizedLevel,
  type GhostPresentationOptions,
  type SurfaceEmphasisMode,
} from "./moduleMapPaint";
import type { LensRelationPolicy } from "../graph/lensRelationPolicy";
import type { RelationVisibilityOverrides } from "../graph/relationVisibility";

const NO_HIDDEN_KINDS: ReadonlySet<string> = new Set();

export interface RelationPaintOptions {
  policy: LensRelationPolicy;
  overrides: RelationVisibilityOverrides;
}

/**
 * Paint a laid-out level with the Map's own edge chain: suppress a pair's import wire when a typed
 * dep wire already joins it, drop the relationship kinds the Map's toggles hide (the pills stay
 * live over the overlay too), then `emphasize` colours every wire by relationship kind and lights
 * the selection's neighbourhood. ALL drawn cards go through `emphasize` in their laid-out
 * parents-before-children order, so clicking a nested declaration lights its wires, selecting an
 * expanded frame seeds its drawn descendants, and a selection re-bands the ghost satellites around
 * its lit subgraph — the same on every surface. Returns the full `EmphasizedLevel` (including the
 * selected-step `beacons` the Map's BeaconArrows ring).
 */
export function paintMinimalLevel(
  nodes: Node[],
  edges: Edge[],
  selected: ReadonlySet<string>,
  radius: number,
  mode: SurfaceEmphasisMode,
  relations: ReadonlySet<string> | RelationPaintOptions = NO_HIDDEN_KINDS,
  ghostPresentation?: GhostPresentationOptions,
): EmphasizedLevel {
  // The Map's exact order (GraphSurface): suppress redundant imports → filter toggled-off kinds → emphasize.
  const semantic = suppressRedundantImports(edges);
  const visible = isRelationPaintOptions(relations)
    ? filterRelationsForLens(semantic, relations.policy, relations.overrides)
    : filterRelKinds(semantic, relations);
  return emphasize(nodes, visible, selected, radius, mode, ghostPresentation);
}

function isRelationPaintOptions(
  value: ReadonlySet<string> | RelationPaintOptions,
): value is RelationPaintOptions {
  return "policy" in value;
}
