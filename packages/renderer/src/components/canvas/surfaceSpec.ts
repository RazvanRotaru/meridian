/**
 * The SurfaceSpec seam (unified-canvas phase A): the two module lenses — the folder Map and the
 * Service lens — declare how they differ from the shared canvas (`GraphSurface`), and a
 * viewMode → spec registry replaces the `viewMode === "call"` ternaries that used to be scattered
 * through the store (moduleRelayout / moduleTreeNodes / applyScoped / buildMinimalGraph) and the
 * interaction hook. The specs encode EXACTLY the historical branches — no new capabilities: the
 * Map dives a folder focus and reveals ghosts by refocusing; the Service lens has no focus model
 * and its tree derives no ghosts. The minimal overlay is NOT a spec (yet — see
 * `MINIMAL_OVERLAY_HIGHWAYS`): it spools its flat graph and defers every gesture to the lens
 * beneath it.
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
}

export interface SurfaceSpec {
  /** Derive the surface's visible tree — the ONLY required difference between surfaces. Its
   * `effectiveFocus` output lands in the store as `moduleEffectiveFocus`, and the breadcrumb
   * renders from THAT laid-out slice (never a render-time re-derive), so the trail always matches
   * the canvas on screen — even mid-lens-switch, before the new layout lands. A per-surface
   * render-time focus model (`of`/`crumbs`) arrives with phase B, when a lens actually branches. */
  deriveTree(state: SurfaceTreeState, caches: SurfaceCaches, extras?: SurfaceTreeExtras): ModuleTree;
  /** Zoom into a container card (the double-click dive); null == the surface has no focus model
   * (containers expand in place instead). */
  dive: ((actions: SurfaceActions, id: string) => void) | null;
  /** Surface a ghost card's real definition (the double-click gesture on a satellite). */
  ghostReveal(actions: SurfaceActions, id: string): void;
  /** How a selection seeds the minimal-graph overlay (identity today; phase B decomposes frames). */
  minimalSeeds(selection: readonly string[]): string[];
  highways: HighwayFlags;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const ALL_HIGHWAYS: HighwayFlags = { bundling: true, routing: true, spooling: true };

/** The folder Map: focus = moduleFocus (containment dive), ghosts reveal by refocusing. */
const MAP_SURFACE: SurfaceSpec = {
  deriveTree: (state, caches, extras = {}) =>
    deriveModuleTree(state.index, state.moduleFocus, state.moduleExpanded, caches.graph, caches.deps, caches.flows, extras.extraIds ?? EMPTY_IDS, extras.hiddenIds ?? EMPTY_IDS),
  dive: (actions, id) => actions.setModuleFocus(id),
  ghostReveal: (actions, id) => actions.revealModule(id),
  minimalSeeds: (selection) => [...selection],
  highways: ALL_HIGHWAYS,
};

/** The Service lens: no zoom/focus (cluster frames expand in place). Its LEVEL tree emits no ghosts
 * today, but `ghostReveal` is LIVE here regardless: the minimal overlay always derives ghost
 * satellites and defers its gestures to the lens beneath (`viewMode` stays "call" while it covers
 * this canvas), so a satellite double-click in an overlay opened FROM the Service lens resolves
 * this spec — the shared reveal path is that gesture's landing, exactly as before the extraction.
 * Tests-toggle hiding never applied to this tree; that stands. */
const SERVICE_SURFACE: SurfaceSpec = {
  deriveTree: (state, caches, extras = {}) => ({
    ...deriveServiceTree(state.index, state.moduleExpanded, caches.graph, caches.deps, caches.flows, scopeSetOf(state.serviceScope), extras.extraIds ?? EMPTY_IDS),
    effectiveFocus: null,
  }),
  dive: null,
  ghostReveal: (actions, id) => actions.revealModule(id),
  minimalSeeds: (selection) => [...selection],
  highways: ALL_HIGHWAYS,
};

/** The minimal-graph overlay's Highways shape: SPOOL only — a flat graph has no containers to
 * pair-bundle and no frames to gutter-route. The overlay is deliberately NOT a SurfaceSpec yet:
 * its members+satellite tree is built by `minimalRelayout` (`buildMinimalSubgraph` mirrors
 * captured Map positions — a different input shape than `deriveTree`), and its gestures defer to
 * the UNDERLYING lens's spec by construction (`viewMode` stays "modules"/"call" while it covers
 * the Map, so the interaction hook resolves that spec). Folding it into the registry is phase B/C
 * work; until a real deriveTree exists, exporting only the flags keeps every spec member honest. */
export const MINIMAL_OVERLAY_HIGHWAYS: HighwayFlags = { bundling: false, routing: false, spooling: true };

/** The strict registry: the two viewMode-keyed module surfaces; null for every non-module lens
 * (ui/logic/prs keep their own machinery until later phases). */
export function moduleSurfaceSpec(viewMode: ViewMode): SurfaceSpec | null {
  return viewMode === "modules" ? MAP_SURFACE : viewMode === "call" ? SERVICE_SURFACE : null;
}

/** The module surface a module-family action reads for ANY mode: the Map is the default — every
 * historical branch was `viewMode === "call" ? service : map`, so non-call modes fell to the Map. */
export function activeModuleSurfaceSpec(viewMode: ViewMode): SurfaceSpec {
  return moduleSurfaceSpec(viewMode) ?? MAP_SURFACE;
}
