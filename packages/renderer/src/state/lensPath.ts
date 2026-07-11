/**
 * Cross-lens path carry. Flipping lenses used to reset the incoming lens to its own top level;
 * instead we read "where you are" — the code node ids anchored in the OUTGOING lens (its whole
 * selection, or failing that its focus) — and translate them into the INCOMING lens's own reveal
 * state, so Map ↔ Service ↔ UI keeps the same files/symbols opened and selected. Multi-select two
 * services on the Map, flip to the Service lens, and both owning cluster frames are already open.
 *
 * This works because every lens shares ONE node.id space (ADR-0001); a lens differs only in WHICH
 * container ids it must expand to reach an anchor. Best-effort per anchor: a node the target lens
 * can't place (a bare folder with no service cluster) is dropped from the reveal, and only when NO
 * anchor is placeable does the whole reveal go null so the caller opens the lens at its top.
 */

import type { GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ViewMode } from "../derive/edgeSelection";
import { UNIT_CARD_KINDS } from "../derive/blockDeps";
import { frameIdOf, leadIdOf } from "../derive/serviceClusterEdges";
import { clusteringFor } from "../derive/serviceClusteringCache";
import { uiFocusTarget } from "../derive/uiFocus";
import { commonPackageFocus, withAncestorsOfMany, type ModuleRevealState } from "./flowExplorer";

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

/** The selection fields of `AnchorSource` — all `selectedAnchorIds` reads. */
export type SelectionSource = Pick<AnchorSource, "viewMode" | "moduleSelected" | "selectedId">;

/** The code nodes the reader is currently on, read from the ACTIVE lens; empty when nothing is
 * picked. Map/Service carry their WHOLE selection; UI and Logic are single-anchor lenses. A selected
 * `svc:` cluster frame is a pseudo-id absent from the graph, so it carries as its LEAD unit — a real
 * node every reveal below can place. */
export function anchorNodeIds(state: AnchorSource): string[] {
  return anchorIds(state, state);
}

/** The reader's EXPLICIT picks alone — the selection panel's anchors. Same switch and same
 * `svc:`-lead normalization as `anchorNodeIds` (so panel enablement can never diverge from what a
 * lens flip actually carries), but without the focus/root fallbacks: empty means nothing is
 * selected, even when a lens has a focus to fall back on. */
export function selectedAnchorIds(state: SelectionSource): string[] {
  return anchorIds(state, null);
}

export interface UiRevealState {
  focusId: string | null;
  expanded: Set<string>;
  selectedId: string;
}

/** Reveal `anchors` on the folder Map: focus their deepest COMMON directory (null → repo root when
 * they share none), expand every container chain down to each anchor, and select them all. Anchors
 * in no file (bare package overview targets) are dropped; null when none survive. */
export function mapRevealStateForMany(anchors: readonly string[], index: GraphIndex): ModuleRevealState | null {
  const placeable = anchors.filter((anchor) => nearestOfKind(anchor, index, (node) => node.kind === "module") !== null);
  if (placeable.length === 0) {
    return null;
  }
  const focus = commonPackageFocus(placeable, index);
  const moduleExpanded = new Set<string>();
  for (const anchor of placeable) {
    for (const id of containersOnPath(anchor, index, focus)) {
      moduleExpanded.add(id);
    }
  }
  return { moduleFocus: focus, moduleExpanded, moduleSelected: new Set(placeable) };
}

/** Reveal a PR review's change on the Map as TIGHTLY as the edit allows: dive INTO the single changed
 * file when every edit lives in one (so only its own members show — no sibling neighbours), else the
 * changed files' common package. Then expand the container chain down to each affected block so the
 * amber-highlighted edits are the visible, selected cards. Anchors fall back to the seed files when a
 * change carries no block-level node (a file-only edit). Null when there is nothing to reveal. */
export function reviewChangeReveal(seeds: readonly string[], affected: ReadonlySet<string>, index: GraphIndex): ModuleRevealState | null {
  if (seeds.length === 0) {
    return null;
  }
  const focus = seeds.length === 1 ? seeds[0] : commonPackageFocus(seeds, index);
  const anchors = affected.size > 0 ? [...affected] : [...seeds];
  const moduleExpanded = new Set<string>();
  for (const anchor of anchors) {
    for (const id of containersOnPath(anchor, index, focus)) {
      moduleExpanded.add(id);
    }
  }
  return { moduleFocus: focus, moduleExpanded, moduleSelected: new Set(anchors) };
}

/** Reveal `anchors` in the Service-cluster lens: open every service frame owning an anchor's unit(s)
 * — a FILE anchor resolves through ALL its contained clustered units — plus any block containers on
 * each path, and select them all. Anchors in no clustered unit (a bare folder, an unclustered
 * helper) are dropped; null when none survive, so the caller opens the lens at its top. The Service
 * lens keeps `moduleFocus` null (it has no folder zoom). */
export function serviceRevealStateForMany(anchors: readonly string[], index: GraphIndex): ModuleRevealState | null {
  return resolveServiceAnchors(anchors, index)?.reveal ?? null;
}

export interface ServiceAnchorResolution {
  reveal: ModuleRevealState;
  /** The cluster leads owning the anchors, deduped in anchor order — seeds the scoped sub-view. */
  owningLeads: string[];
}

/** The ONE anchors→clusters resolution pass: each anchor resolves to its clustered unit(s), whose
 * frames the reveal opens and whose leads seed the Service scope — so the reveal gate and the scope
 * gate can never disagree. Null when no anchor resolves (reveal and scope both have nothing). */
export function resolveServiceAnchors(anchors: readonly string[], index: GraphIndex): ServiceAnchorResolution | null {
  const { leadOf } = clusteringFor(index);
  const moduleExpanded = new Set<string>();
  const owningLeads = new Set<string>();
  const placeable: string[] = [];
  for (const anchor of anchors) {
    const owned = ownedUnitsOf(anchor, index, leadOf);
    if (owned.length === 0) {
      continue;
    }
    for (const { unitId, leadId } of owned) {
      owningLeads.add(leadId);
      // Open the owning frame plus every container BELOW the unit on the path to the anchor (a
      // method's flow frame, say); the unit itself is always-open in the service walk. A FILE
      // anchor sits above its units, so it contributes the frames alone.
      moduleExpanded.add(frameIdOf(leadId));
      for (const id of containersOnPath(anchor, index, unitId)) {
        moduleExpanded.add(id);
      }
    }
    placeable.push(anchor);
  }
  if (placeable.length === 0) {
    return null;
  }
  return {
    reveal: { moduleFocus: null, moduleExpanded, moduleSelected: new Set(placeable) },
    owningLeads: [...owningLeads],
  };
}

/** Reveal `anchors` in the UI (React composition) lens: expand every container chain and select the
 * FIRST placeable anchor (the UI lens is single-selection). UI's focused render-subtree dive is kept
 * only while it contains EVERY placeable anchor — else show the whole (renders-filtered) graph so no
 * anchor is hidden beneath the dive. Ids not in the graph are dropped; null when none survive. */
export function uiRevealStateForMany(anchors: readonly string[], index: GraphIndex): UiRevealState | null {
  const placeable = anchors.filter((anchor) => index.nodesById.has(anchor));
  if (placeable.length === 0) {
    return null;
  }
  const target = uiFocusTarget(index);
  const focusId = target !== null && placeable.every((anchor) => index.isWithinFocus(target, anchor)) ? target : null;
  return { focusId, expanded: withAncestorsOfMany(placeable, index, new Set<string>()), selectedId: placeable[0] };
}

/** The ONE viewMode switch and the ONE `svc:`→lead normalization spot behind both anchor readers;
 * `fallback` null skips the selection-less focus/root fallbacks. */
function anchorIds(selection: SelectionSource, fallback: AnchorSource | null): string[] {
  return rawAnchorIds(selection, fallback).map((id) => leadIdOf(id) ?? id);
}

function rawAnchorIds(selection: SelectionSource, fallback: AnchorSource | null): string[] {
  switch (selection.viewMode) {
    case "modules":
    case "call": {
      if (selection.moduleSelected.size > 0) {
        return [...selection.moduleSelected];
      }
      return asSingleton(fallback !== null ? (fallback.moduleEffectiveFocus ?? fallback.moduleFocus) : null);
    }
    case "ui":
      return asSingleton(selection.selectedId ?? fallback?.focusId ?? null);
    case "logic":
      return asSingleton(fallback !== null ? fallback.logicRoot : null);
    default:
      return [];
  }
}

/** The clustered unit(s) an anchor maps onto — each with the lead of its owning cluster: its nearest
 * unit ancestor when it has one, else — for a FILE anchor, which sits ABOVE units — each clustered
 * unit inside the file (a file may span several clusters; all of them count). Units outside every
 * cluster resolve to nothing. */
function ownedUnitsOf(anchorId: string, index: GraphIndex, leadOf: ReadonlyMap<string, string>): { unitId: string; leadId: string }[] {
  const owned: { unitId: string; leadId: string }[] = [];
  for (const unit of candidateUnits(anchorId, index)) {
    const leadId = leadOf.get(unit.id);
    if (leadId !== undefined) {
      owned.push({ unitId: unit.id, leadId });
    }
  }
  return owned;
}

function candidateUnits(anchorId: string, index: GraphIndex): GraphNode[] {
  const unit = nearestOfKind(anchorId, index, (node) => UNIT_CARD_KINDS.has(node.kind));
  if (unit !== null) {
    return [unit];
  }
  if (index.nodesById.get(anchorId)?.kind !== "module") {
    return [];
  }
  return index.childrenOf(anchorId).filter((child) => UNIT_CARD_KINDS.has(child.kind));
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

function asSingleton(id: string | null): string[] {
  return id !== null ? [id] : [];
}
