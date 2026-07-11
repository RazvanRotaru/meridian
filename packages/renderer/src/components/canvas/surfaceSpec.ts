/**
 * The SurfaceSpec seam (unified-canvas phases A–C): the three module lenses — the folder Map, the
 * Service lens, and (since phase C) the renders-rooted UI lens — declare how they differ from the
 * shared canvas (`GraphSurface`), and a viewMode → spec registry replaces the `viewMode === "call"`
 * ternaries that used to be scattered through the store (moduleRelayout / moduleTreeNodes /
 * applyScoped / buildMinimalGraph) and the interaction hook. Phase B gave the Service lens the
 * Map's full capability set, per-surface where the semantics differ:
 *
 *   - FOCUS: both lenses zoom by double-click (`focus.dive` → moduleFocus), but the Map dives
 *     folders AND files while the Service lens dives ONLY `svc:` cluster frames (`divableKinds`);
 *     each surface names its own breadcrumb root and crumbs its own effective focus.
 *   - GHOST REVEAL: the Map refocuses at the definition (`revealModule` — a focus jump); the
 *     Service lens OPENS the owning cluster frame in place (`revealServiceGhost` — an expand,
 *     never a folder focus).
 *   - MINIMAL SEEDS: the Map extracts the selection verbatim; the Service lens decomposes a
 *     selected `svc:` frame (a pseudo-id no overlay could draw) into its members' home FILES.
 *
 * Lives beside the canvas it configures. The STORE imports this module — the dependency points
 * store → spec, never spec → store (only pure derives and narrow structural state/action types),
 * so there is no import cycle.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../../graph/graphIndex";
import type { ViewMode } from "../../derive/edgeSelection";
import type { ModuleGraph } from "../../derive/moduleGraph";
import type { BlockDeps } from "../../derive/blockDeps";
import { deriveModuleTree, type ModuleTree } from "../../derive/moduleTree";
import { deriveServiceTree } from "../../derive/serviceClusterTree";
import { deriveUiTree } from "../../derive/uiTree";
import { clusterMemberSeeds, homeFileOf, leadIdOf } from "../../derive/serviceClusterEdges";
import { clusteringFor } from "../../derive/serviceClusteringCache";
import { scopeSetOf, type ServiceScope } from "../../state/serviceScope";

/** Which of the Visual Highways passes apply to a surface's shape (always bundle → route → spool). */
export interface HighwayFlags {
  /** Merge parallel cross-container wires into container-pair highway bundles. */
  bundling: boolean;
  /** Ride frame-crossing wires through the frame's gutter rail (the bus). */
  routing: boolean;
  /** Gather the remaining open-canvas fan-hub wires into shared trunks. */
  spooling: boolean;
}

/** The store slice a tree derive reads — structural, so `BlueprintState` satisfies it directly. */
export interface SurfaceTreeState {
  index: GraphIndex;
  moduleFocus: string | null;
  moduleExpanded: ReadonlySet<string>;
  serviceScope: ServiceScope | null;
  /** The Commons toggle: utility hubs demote into the dock tray (the Map's hub treatment — the
   * toggle is Map-gated in the control panel, and only the Map's derive reads it). */
  showCommons: boolean;
}

/** The store's memoized substrates, built once per artifact and threaded into every derive. */
export interface SurfaceCaches {
  graph: ModuleGraph;
  deps: BlockDeps;
  flows: LogicFlows;
}

/** Optional derive inputs only the RELAYOUT passes (the scoped-expansion frontier read omits both,
 * exactly as the old call sites did): palette "+" pins and the Tests-toggle exclusion set. */
export interface SurfaceTreeExtras {
  extraIds?: ReadonlySet<string>;
  hiddenIds?: ReadonlySet<string>;
}

/** The store actions a spec's gestures may call — narrow, so the spec never imports the store. */
export interface SurfaceActions {
  setModuleFocus(id: string | null): void;
  revealModule(id: string): void;
  revealServiceGhost(id: string): void;
}

/** One breadcrumb segment of a surface's containment trail. */
export interface Crumb {
  id: string;
  label: string;
}

/** A surface's zoom model: how a dive lands and how the trail reads. Every surface holds its zoom
 * in the ONE shared `moduleFocus` slot (phase C migrates the UI lens's `focusId` into it too), so
 * there is deliberately no per-spec `of(state)` accessor — read `state.moduleFocus` directly. */
export interface SurfaceFocusModel {
  /** Zoom into a container card (the double-click dive); null == the surface has no focus model
   * (containers expand in place instead). */
  dive: ((actions: SurfaceActions, id: string) => void) | null;
  /** Whether the dive gesture applies to THIS card (by its React Flow node type + id); a refusing
   * container falls back to expand-in-place, exactly the chevron's gesture. */
  divable(nodeType: string | undefined, id: string): boolean;
  /** The breadcrumb's root segment ("Repository" / "All services") and its count noun. */
  rootLabel: string;
  rootNoun: string;
  /** The trail below the root for the LAID-OUT effective focus (never a render-time re-derive of
   * the tree — only of the trail labels, which are stable per index). */
  crumbs(effectiveFocus: string | null, index: GraphIndex): Crumb[];
}

export interface SurfaceSpec {
  /** Derive the surface's visible tree — the ONLY required difference between surfaces. Its
   * `effectiveFocus` output lands in the store as `moduleEffectiveFocus`, and the breadcrumb
   * renders from THAT laid-out slice, so the trail always matches the canvas on screen — even
   * mid-lens-switch, before the new layout lands. */
  deriveTree(state: SurfaceTreeState, caches: SurfaceCaches, extras?: SurfaceTreeExtras): ModuleTree;
  /** The surface's zoom model — dive gesture, breadcrumb root + trail. */
  focus: SurfaceFocusModel;
  /** Surface a ghost card's real definition (the double-click gesture on a satellite). */
  ghostReveal(actions: SurfaceActions, id: string): void;
  /** How a selection seeds the minimal-graph overlay: real ids pass through; the Service lens
   * decomposes `svc:` frames into their cluster members' home FILE ids (the overlay draws
   * file/folder boxes, never bare units). */
  minimalSeeds(selection: readonly string[], index: GraphIndex): string[];
  highways: HighwayFlags;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const ALL_HIGHWAYS: HighwayFlags = { bundling: true, routing: true, spooling: true };

/** The Map's containment trail: package/file ancestors from the repo down to the focus, inclusive. */
export function crumbsFor(focus: string | null, index: GraphIndex): Crumb[] {
  if (focus === null) {
    return [];
  }
  return index
    .ancestorsOf(focus)
    .filter((node) => node.kind === "package" || node.kind === "module")
    .map((node) => ({ id: node.id, label: node.displayName ?? node.id }));
}

/** The Service trail: one segment — the focused cluster, by its lead's display name. */
function serviceCrumbs(effectiveFocus: string | null, index: GraphIndex): Crumb[] {
  const lead = effectiveFocus === null ? null : leadIdOf(effectiveFocus);
  if (effectiveFocus === null || lead === null) {
    return [];
  }
  return [{ id: effectiveFocus, label: clusteringFor(index).metrics.get(lead)?.displayName ?? lead }];
}

/** The folder Map: focus = moduleFocus (containment dive over folders AND files), ghosts reveal by
 * refocusing at the definition. */
const MAP_SURFACE: SurfaceSpec = {
  // `showCommons` threads through as the hub-demotion switch: on, logger-grade utility hubs leave
  // ELK for the commons dock tray; off, they rejoin the level with ordinary wires.
  deriveTree: (state, caches, extras = {}) =>
    deriveModuleTree(state.index, state.moduleFocus, state.moduleExpanded, caches.graph, caches.deps, caches.flows, extras.extraIds ?? EMPTY_IDS, extras.hiddenIds ?? EMPTY_IDS, state.showCommons),
  focus: {
    dive: (actions, id) => actions.setModuleFocus(id),
    divable: (nodeType) => nodeType === "package" || nodeType === "file",
    rootLabel: "Repository",
    rootNoun: "packages",
    crumbs: crumbsFor,
  },
  ghostReveal: (actions, id) => actions.revealModule(id),
  minimalSeeds: (selection) => [...selection],
  highways: ALL_HIGHWAYS,
};

/** The Service lens: focus = ONE cluster (dive a `svc:` frame; Scope stays the coupling filter),
 * ghosts from the shared projection with expand-based reveal — `revealServiceGhost` opens the
 * owning frame in place and NEVER sets a folder focus. The minimal overlay defers its gestures to
 * this spec while it covers the lens (`viewMode` stays "call"), exactly as before the extraction. */
const SERVICE_SURFACE: SurfaceSpec = {
  deriveTree: (state, caches, extras = {}) =>
    deriveServiceTree(state.index, state.moduleFocus, state.moduleExpanded, caches.graph, caches.deps, caches.flows, {
      scopeLeadIds: scopeSetOf(state.serviceScope),
      extraIds: extras.extraIds,
      hiddenIds: extras.hiddenIds,
    }),
  focus: {
    dive: (actions, id) => actions.setModuleFocus(id),
    // ONLY `svc:` cluster frames dive on this lens — a folder frame (the minimal overlay's home
    // boxes) or a file card keeps its expand/select gesture, never a junk focus.
    divable: (nodeType, id) => nodeType === "package" && leadIdOf(id) !== null,
    rootLabel: "All services",
    rootNoun: "services",
    crumbs: serviceCrumbs,
  },
  ghostReveal: (actions, id) => actions.revealServiceGhost(id),
  minimalSeeds: clusterMemberSeeds,
  highways: ALL_HIGHWAYS,
};

/** The UI lens (unified-canvas phase C): the Map's machinery over the RENDERS projection. Focus is
 * the same containment dive (packages AND files — a double-clicked component card zooms into its
 * render subtree's containment), ghosts reveal by refocusing at the definition (the Map's model),
 * and minimal-graph seeds land on each selection's home FILE (the overlay draws file/folder boxes,
 * never bare component symbols). */
const UI_SURFACE: SurfaceSpec = {
  deriveTree: (state, caches, extras = {}) =>
    deriveUiTree(state.index, state.moduleFocus, state.moduleExpanded, caches.graph, caches.deps, caches.flows, extras.extraIds ?? EMPTY_IDS, extras.hiddenIds ?? EMPTY_IDS),
  focus: {
    dive: (actions, id) => actions.setModuleFocus(id),
    divable: (nodeType) => nodeType === "package" || nodeType === "file",
    rootLabel: "UI",
    rootNoun: "components",
    crumbs: crumbsFor,
  },
  ghostReveal: (actions, id) => actions.revealModule(id),
  minimalSeeds: (selection, index) => [...new Set(selection.map((id) => homeFileOf(id, index)))],
  highways: ALL_HIGHWAYS,
};

/** The minimal-graph overlay's Highways shape: SPOOL only — a flat graph has no containers to
 * pair-bundle and no frames to gutter-route. The overlay is deliberately NOT a SurfaceSpec yet:
 * its members+satellite tree is built by `minimalRelayout` (`buildMinimalSubgraph` mirrors
 * captured Map positions — a different input shape than `deriveTree`), and its gestures defer to
 * the UNDERLYING lens's spec by construction (`viewMode` stays "modules"/"call" while it covers
 * the Map, so the interaction hook resolves that spec). Folding it into the registry is phase C
 * work; until a real deriveTree exists, exporting only the flags keeps every spec member honest. */
export const MINIMAL_OVERLAY_HIGHWAYS: HighwayFlags = { bundling: false, routing: false, spooling: true };

/** The strict registry: the three viewMode-keyed module surfaces (Map / Service / UI — phase C
 * folded the UI lens in); null for the lenses with their own render (logic) or no canvas (prs). */
export function moduleSurfaceSpec(viewMode: ViewMode): SurfaceSpec | null {
  return viewMode === "modules" ? MAP_SURFACE : viewMode === "call" ? SERVICE_SURFACE : viewMode === "ui" ? UI_SURFACE : null;
}

/** The module surface a module-family action reads for ANY mode: the Map is the default — every
 * historical branch was `viewMode === "call" ? service : map`, so non-call modes fell to the Map. */
export function activeModuleSurfaceSpec(viewMode: ViewMode): SurfaceSpec {
  return moduleSurfaceSpec(viewMode) ?? MAP_SURFACE;
}
