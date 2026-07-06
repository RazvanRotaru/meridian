/**
 * The Module-map derive pipeline behind one call: resolve the effective root, walk the FULL import
 * blast radius to learn its true diameter, then lay out the (optionally depth-capped) spec. Kept
 * pure of store concerns so the store can wrap it in a stale-layout guard, exactly like
 * `deriveCompositionLayout`.
 *
 * Depth is a relayout parameter (fewer rings ⇒ fewer nodes), but the SLIDER'S ceiling must stay the
 * unbounded diameter — otherwise capping depth would shrink the max and strand the reader at a low
 * depth. So we always derive the full radius once for `maxDepth`, and only re-derive capped when the
 * chosen depth is actually below it.
 */

import type { Edge, Node } from "@xyflow/react";
import type { GraphArtifact } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { deriveModuleMap, type ModuleMapSpec } from "../derive/moduleMap";
import { resolveModuleRoot } from "../derive/moduleGraph";
import { layoutModuleMap } from "../layout/moduleRingLayout";

export interface ModuleMapLayout {
  nodes: Node[];
  edges: Edge[];
  /** The module actually walked from (may differ from the request when it self-healed); null == none. */
  effectiveRoot: string | null;
  /** The unbounded max hop-depth from the root — the depth slider's stable ceiling. */
  maxDepth: number;
}

/** The CLI-declared app entry module ids, read defensively from the loose extensions record. */
export function readEntryModules(artifact: GraphArtifact): string[] {
  const declared = artifact.extensions?.entryModules as unknown as string[] | undefined;
  return Array.isArray(declared) ? declared : [];
}

export function deriveModuleMapLayout(
  index: GraphIndex,
  moduleRoot: string | null,
  // The requested depth cap, or `null` for the whole radius (the "All" position). Passing the store's
  // GHOST_DEPTH_ALL sentinel as a plain number would silently cap a >sentinel-deep chain, so the
  // store maps "All" to null before calling — keeping the walk truly unbounded.
  moduleDepth: number | null,
  entryModules: string[],
): ModuleMapLayout {
  const requestedRoot = moduleRoot ?? resolveModuleRoot(index, entryModules);
  if (requestedRoot === null) {
    return emptyLayout();
  }
  const full = deriveModuleMap(index, { rootId: requestedRoot, maxDepth: null, entryModules });
  if (full.rootId === null) {
    return emptyLayout();
  }
  const spec = specForDepth(index, full, moduleDepth, entryModules);
  const { nodes, edges } = layoutModuleMap(spec);
  return { nodes, edges, effectiveRoot: full.rootId, maxDepth: full.maxObservedDepth };
}

/** The full radius when the depth is unbounded or already reaches it, else a fresh capped derivation. */
function specForDepth(
  index: GraphIndex,
  full: ModuleMapSpec,
  moduleDepth: number | null,
  entryModules: string[],
): ModuleMapSpec {
  if (moduleDepth === null || moduleDepth >= full.maxObservedDepth) {
    return full;
  }
  return deriveModuleMap(index, { rootId: full.rootId as string, maxDepth: moduleDepth, entryModules });
}

function emptyLayout(): ModuleMapLayout {
  return { nodes: [], edges: [], effectiveRoot: null, maxDepth: 0 };
}
