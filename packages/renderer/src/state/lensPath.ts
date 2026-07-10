/**
 * Cross-lens path carry. Flipping lenses used to reset the incoming lens to its own top level;
 * instead we read "where you are" — one code node id — from the OUTGOING lens and translate it into
 * the INCOMING lens's own reveal state, so Map ↔ Service ↔ UI keeps the same file/symbol opened and
 * selected. Pick a class on the Map, flip to the Service lens, and its owning service cluster is
 * already open on that same class — navigation and code inspection stay on one path.
 *
 * This works because every lens shares ONE node.id space (ADR-0001); a lens differs only in WHICH
 * container ids it must expand to reach the anchor. Best-effort: a node the target lens can't place
 * (a bare folder with no service cluster) yields null, and the caller opens the lens at its top.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ViewMode } from "../derive/edgeSelection";
import { UNIT_CARD_KINDS } from "../derive/blockDeps";
import { deriveServiceClusters } from "../derive/serviceComposition";
import { frameIdOf } from "../derive/serviceClusterEdges";
import { uiFocusTarget } from "../derive/uiFocus";
import { withAncestorsOf, type ModuleRevealState } from "./flowExplorer";

/** The store slice naming "where you are" in each lens — its selection, or failing that its focus. */
export interface AnchorSource {
  viewMode: ViewMode;
  moduleSelected: ReadonlySet<string>;
  moduleEffectiveFocus: string | null;
  moduleFocus: string | null;
  selectedId: string | null;
  focusId: string | null;
  logicRoot: string | null;
}

/** The code node the reader is currently on, read from the ACTIVE lens; null when nothing is picked. */
export function anchorNodeId(state: AnchorSource): string | null {
  switch (state.viewMode) {
    case "modules":
    case "call":
      return firstOf(state.moduleSelected) ?? state.moduleEffectiveFocus ?? state.moduleFocus;
    case "ui":
      return state.selectedId ?? state.focusId;
    case "logic":
      return state.logicRoot;
    default:
      return null;
  }
}

export interface UiRevealState {
  focusId: string | null;
  expanded: Set<string>;
  selectedId: string;
}

/** Reveal `anchorId` on the folder Map: focus its directory, expand the container chain down to it,
 * and select the exact node. Null when the anchor sits in no file — a bare package overview target. */
export function mapRevealStateFor(anchorId: string, index: GraphIndex): ModuleRevealState | null {
  if (nearestOfKind(anchorId, index, (node) => node.kind === "module") === null) {
    return null;
  }
  const directory = nearestOfKind(anchorId, index, (node) => node.kind === "package");
  return {
    moduleFocus: directory?.id ?? null,
    moduleExpanded: containersOnPath(anchorId, index, directory?.id ?? null),
    moduleSelected: new Set([anchorId]),
  };
}

/** Reveal `anchorId` in the Service-cluster lens: open the service frame that owns the anchor's unit
 * (plus any block containers on the path) and select the anchor. Null when the anchor lives in no
 * clustered unit — a bare folder or an unclustered helper — so the caller opens the lens at its top.
 * The Service lens keeps `moduleFocus` null (it has no folder zoom), so this never sets one. */
export function serviceRevealStateFor(anchorId: string, index: GraphIndex, edges: GraphEdge[]): ModuleRevealState | null {
  const unit = nearestOfKind(anchorId, index, (node) => UNIT_CARD_KINDS.has(node.kind));
  if (unit === null) {
    return null;
  }
  const { leadOf } = deriveServiceClusters([...index.nodesById.values()], edges);
  const lead = leadOf.get(unit.id);
  if (lead === undefined) {
    return null;
  }
  // Open the owning frame plus every container BELOW the unit on the path to the anchor (a method's
  // flow frame, say); the unit itself is always-open in the service walk, so it needs no id here.
  const moduleExpanded = new Set<string>([frameIdOf(lead)]);
  for (const node of containersOnPath(anchorId, index, unit.id)) {
    moduleExpanded.add(node);
  }
  return { moduleFocus: null, moduleExpanded, moduleSelected: new Set([anchorId]) };
}

/** Reveal `anchorId` in the UI (React composition) lens: expand its container chain and select it,
 * keeping UI's focused render-subtree dive only while the anchor lives inside it — else show the whole
 * (renders-filtered) graph so the anchor is reachable rather than hidden beneath the dive. */
export function uiRevealStateFor(anchorId: string, index: GraphIndex): UiRevealState | null {
  if (!index.nodesById.has(anchorId)) {
    return null;
  }
  const target = uiFocusTarget(index);
  const focusId = target !== null && index.isWithinFocus(target, anchorId) ? target : null;
  return { focusId, expanded: withAncestorsOf(anchorId, index, new Set<string>()), selectedId: anchorId };
}

/** The container ids strictly BETWEEN `scope` and the anchor on the root..anchor path (excluding both
 * the scope root and the anchor itself) — expanding exactly these draws the anchor as its own card on
 * a containment surface, without re-listing the focus root the surface is already inside. */
function containersOnPath(anchorId: string, index: GraphIndex, scope: string | null): Set<string> {
  const expanded = new Set<string>();
  for (const node of index.ancestorsOf(anchorId)) {
    if (node.id !== anchorId && node.id !== scope && index.isContainer(node.id) && index.isWithinFocus(scope, node.id)) {
      expanded.add(node.id);
    }
  }
  return expanded;
}

/** The DEEPEST ancestor (self included) matching `predicate`, or null — the node's nearest file/unit/dir. */
function nearestOfKind(anchorId: string, index: GraphIndex, predicate: (node: GraphNode) => boolean): GraphNode | null {
  const ancestors = index.ancestorsOf(anchorId);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (predicate(ancestors[i])) {
      return ancestors[i];
    }
  }
  return null;
}

function firstOf(set: ReadonlySet<string>): string | null {
  for (const value of set) {
    return value;
  }
  return null;
}
