/**
 * The SurfaceSpec seam (unified-canvas phases A–C): the three module lenses — the folder Map, the
 * Service lens, and (since phase C) the renders-rooted UI lens — declare how they differ from the
 * shared canvas (`GraphSurface`), and a viewMode → spec registry replaces the `viewMode === "call"`
 * ternaries that used to be scattered through the store (moduleRelayout / moduleTreeNodes /
 * applyScoped / buildMinimalGraph) and the interaction hook. Phase B gave the Service lens the
 * Map's full capability set, per-surface where the semantics differ:
 *
 *   - NAVIGATION: double-click follows `navigation.navigateInto` while Recenter remains a separate
 *     canvas action; the Map navigates into folders/files while the Service lens navigates into
 *     synthetic domains and `svc:` cluster frames;
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
import { deriveServiceDomains, isServiceDomainId, shouldGroupServiceDomains } from "../../derive/serviceDomains";
import type { ServiceGroupingMode } from "../../derive/serviceClusteringModes";
import { semanticOuterLevel } from "../../derive/moduleSemanticComposite";
import { resolveServiceAnchors } from "../../state/lensPath";
import { scopeSetOf, serviceScopeFor, type ServiceScope } from "../../state/serviceScope";
import {
  MAP_RELATION_POLICY,
  SERVICE_RELATION_POLICY,
  UI_RELATION_POLICY,
  type LensRelationPolicy,
} from "../../graph/lensRelationPolicy";

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
  serviceGroupingMode?: ServiceGroupingMode;
  serviceGroupingTargetSize?: number;
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
  /** The node kind, when known — a "package" segment can be descended into (its breadcrumb dropdown
   * lists children); a "module" (file) segment cannot. Absent for synthetic (Service) segments. */
  kind?: string;
}

/** The laid level plus the lens-local state needed to resolve its real enclosing graph. Passing the
 * state object (rather than only two focus strings) lets a lens interpret "parent" inside its own
 * projection — notably Service's scoped cluster neighbourhood. */
export interface SurfaceSemanticParentContext {
  state: SurfaceTreeState;
  effectiveFocus: string | null;
}

/** One canonical graph immediately outside the current level. `context` is a narrow state override
 * applied while deriving that outer tree; unspecified fields inherit from the current lens. This
 * keeps the hierarchy generic without teaching the store what a Service scope means. */
export interface SurfaceSemanticParent {
  focus: string | null;
  anchorId: string;
  label: string;
  context?: Partial<Pick<SurfaceTreeState, "serviceScope">>;
}

/** A surface's containment navigation model: where navigation lands and how its trail reads. The
 * separate canvas Recenter/focus action owns camera focus; this model never means “focus the
 * camera.” The semantic-parent resolver supplies outward hierarchy navigation without changing
 * the universal double-click contract or treating expansion as navigation. */
export interface SurfaceNavigationModel {
  /** Navigate into a container card; null == the surface has no containment navigation model. */
  navigateInto: ((actions: SurfaceActions, id: string) => void) | null;
  /** Whether navigation-into applies to THIS card. Expansion never acts as a double-click fallback;
   * it remains an explicit chevron/action. */
  canNavigateInto(nodeType: string | undefined, id: string): boolean;
  /** The breadcrumb's root segment ("Repository" / "All services") and its count noun. */
  rootLabel: string;
  rootNoun: string;
  /** The trail below the root for the LAID-OUT effective focus (never a render-time re-derive of
   * the tree — only of the trail labels, which are stable per index). */
  crumbs(
    effectiveFocus: string | null,
    index: GraphIndex,
    groupingMode?: ServiceGroupingMode,
    groupingTargetSize?: number,
  ): Crumb[];
  /** Resolve the real graph which contains this level as one node. The caller derives that tree by
   * changing `moduleFocus` to the returned focus, clearing level-local expansion, and applying the
   * optional context override; null means this surface is already at its semantic root. */
  semanticParent(context: SurfaceSemanticParentContext): SurfaceSemanticParent | null;
}

export interface SurfaceSpec {
  /** Stable surface identity. State such as relation visibility is stored per id, so switching
   * lenses never leaks Service's quiet defaults into Map or UI. */
  id: "map" | "service" | "ui";
  /** Derive the surface's visible tree — the ONLY required difference between surfaces. Its
   * `effectiveFocus` output lands in the store as `moduleEffectiveFocus`, and the breadcrumb
   * renders from THAT laid-out slice, so the trail always matches the canvas on screen — even
   * mid-lens-switch, before the new layout lands. */
  deriveTree(state: SurfaceTreeState, caches: SurfaceCaches, extras?: SurfaceTreeExtras): ModuleTree;
  /** Double-click navigation and its breadcrumb root/trail. */
  navigation: SurfaceNavigationModel;
  /** Surface a ghost card's real definition (the double-click gesture on a satellite). */
  ghostReveal(actions: SurfaceActions, id: string): void;
  /** How a selection seeds the minimal-graph overlay: real ids pass through; the Service lens
   * decomposes `svc:` frames into their cluster members' home FILE ids (the overlay draws
   * file/folder boxes, never bare units). */
  minimalSeeds(
    selection: readonly string[],
    index: GraphIndex,
    groupingMode?: ServiceGroupingMode,
    groupingTargetSize?: number,
  ): string[];
  /** The semantic relationship story this lens tells. Shared layout/paint/highway/ghost passes
   * consume this policy; lenses configure meaning, not graph machinery. */
  relations: LensRelationPolicy;
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
    .map((node) => ({ id: node.id, label: node.displayName ?? node.id, kind: node.kind }));
}

/** Map/UI share containment ancestry even though their edge projections differ. Their canonical
 * outer focus/anchor pair is therefore the same resolver used by the original Map stack. */
function containmentSemanticParent({ state, effectiveFocus }: SurfaceSemanticParentContext): SurfaceSemanticParent | null {
  const parent = semanticOuterLevel(state.index, state.moduleFocus, effectiveFocus);
  if (parent === null) {
    return null;
  }
  return {
    ...parent,
    label: state.index.nodesById.get(parent.anchorId)?.displayName ?? parent.anchorId,
  };
}

/** The Service trail: a synthetic filesystem domain followed by the focused service when present. */
function serviceCrumbs(
  effectiveFocus: string | null,
  index: GraphIndex,
  groupingMode?: ServiceGroupingMode,
  groupingTargetSize?: number,
): Crumb[] {
  if (effectiveFocus === null) {
    return [];
  }
  const clustering = clusteringFor(index);
  const model = deriveServiceDomains(clustering, groupingMode, groupingTargetSize);
  const focusedDomain = model.domainById.get(effectiveFocus);
  if (focusedDomain) {
    return [{ id: focusedDomain.id, label: focusedDomain.label }];
  }
  const lead = effectiveFocus === null ? null : leadIdOf(effectiveFocus);
  if (lead === null) {
    return [];
  }
  const service = { id: effectiveFocus, label: clustering.metrics.get(lead)?.displayName ?? lead };
  const domain = model.domainByLead.get(lead);
  return shouldGroupServiceDomains(clustering) && domain
    ? [{ id: domain.id, label: domain.label }, service]
    : [service];
}

/** Resolve Service's real containment hierarchy. The dense unscoped lens is root → domain →
 * service. A scoped or small lens stays flat; a direct service deep-link with no domain synthesizes
 * the same localized neighbourhood as Service scope so its parent remains useful. Grouping inputs
 * match deriveServiceTree, so changing strategy cannot leave parents on stale domain ids. */
function serviceSemanticParent({ state, effectiveFocus }: SurfaceSemanticParentContext): SurfaceSemanticParent | null {
  if (effectiveFocus === null) {
    return null;
  }
  const clustering = clusteringFor(state.index);
  const model = deriveServiceDomains(
    clustering,
    state.serviceGroupingMode,
    state.serviceGroupingTargetSize,
  );
  const focusedDomain = model.domainById.get(effectiveFocus);
  if (focusedDomain !== undefined) {
    // Scoped overviews intentionally draw no domain cards, so such a stale/deep-linked focus has
    // no canonical parent anchor in that projection.
    return state.serviceScope === null
      ? { focus: null, anchorId: focusedDomain.id, label: focusedDomain.label }
      : null;
  }
  const lead = leadIdOf(effectiveFocus);
  if (lead === null) {
    return null;
  }
  const label = clustering.metrics.get(lead)?.displayName ?? lead;
  if (state.serviceScope === null && shouldGroupServiceDomains(clustering)) {
    const domain = model.domainByLead.get(lead);
    if (domain !== undefined) {
      return { focus: domain.id, anchorId: effectiveFocus, label };
    }
  }
  const resolution = resolveServiceAnchors(
    [lead],
    state.index,
    state.serviceGroupingMode,
    state.serviceGroupingTargetSize,
  );
  if (resolution === null) {
    return null;
  }
  const serviceScope = state.serviceScope ?? serviceScopeFor(resolution.owningLeads, state.index);
  return {
    focus: null,
    anchorId: effectiveFocus,
    label,
    context: { serviceScope },
  };
}

/** The folder Map: focus = moduleFocus (containment dive over folders AND files), ghosts reveal by
 * refocusing at the definition. */
const MAP_SURFACE: SurfaceSpec = {
  id: "map",
  // `showCommons` threads through as the hub-demotion switch: on, logger-grade utility hubs leave
  // ELK for the commons dock tray; off, they rejoin the level with ordinary wires.
  deriveTree: (state, caches, extras = {}) =>
    deriveModuleTree(state.index, state.moduleFocus, state.moduleExpanded, caches.graph, caches.deps, caches.flows, extras.extraIds ?? EMPTY_IDS, extras.hiddenIds ?? EMPTY_IDS, state.showCommons),
  navigation: {
    navigateInto: (actions, id) => actions.setModuleFocus(id),
    canNavigateInto: (nodeType) => nodeType === "package" || nodeType === "file",
    rootLabel: "Repository",
    rootNoun: "packages",
    crumbs: crumbsFor,
    semanticParent: containmentSemanticParent,
  },
  ghostReveal: (actions, id) => actions.revealModule(id),
  minimalSeeds: (selection) => [...selection],
  relations: MAP_RELATION_POLICY,
  highways: ALL_HIGHWAYS,
};

/** The Service lens: focus = one domain or cluster (Scope stays the coupling filter),
 * ghosts from the shared projection with expand-based reveal — `revealServiceGhost` opens the
 * owning frame in place and NEVER sets a folder focus. The minimal overlay defers its gestures to
 * this spec while it covers the lens (`viewMode` stays "call"), exactly as before the extraction. */
const SERVICE_SURFACE: SurfaceSpec = {
  id: "service",
  deriveTree: (state, caches, extras = {}) =>
    deriveServiceTree(state.index, state.moduleFocus, state.moduleExpanded, caches.graph, caches.deps, caches.flows, {
      scopeLeadIds: scopeSetOf(state.serviceScope),
      extraIds: extras.extraIds,
      hiddenIds: extras.hiddenIds,
      groupingMode: state.serviceGroupingMode,
      groupingTargetSize: state.serviceGroupingTargetSize,
    }),
  navigation: {
    navigateInto: (actions, id) => actions.setModuleFocus(id),
    // ONLY `svc:` cluster frames dive on this lens — a folder frame (the minimal overlay's home
    // boxes) or a file card keeps its expand/select gesture, never a junk focus.
    canNavigateInto: (nodeType, id) =>
      (nodeType === "package" && leadIdOf(id) !== null)
      || (nodeType === "serviceDomain" && isServiceDomainId(id)),
    rootLabel: "All services",
    rootNoun: "services",
    crumbs: serviceCrumbs,
    semanticParent: serviceSemanticParent,
  },
  ghostReveal: (actions, id) => actions.revealServiceGhost(id),
  minimalSeeds: clusterMemberSeeds,
  relations: SERVICE_RELATION_POLICY,
  highways: ALL_HIGHWAYS,
};

/** The UI lens (unified-canvas phase C): the Map's machinery over the RENDERS projection. Focus is
 * the same containment dive (packages AND files — a double-clicked component card zooms into its
 * render subtree's containment), ghosts reveal by refocusing at the definition (the Map's model),
 * and minimal-graph seeds land on each selection's home FILE (the overlay draws file/folder boxes,
 * never bare component symbols). */
const UI_SURFACE: SurfaceSpec = {
  id: "ui",
  deriveTree: (state, caches, extras = {}) =>
    deriveUiTree(state.index, state.moduleFocus, state.moduleExpanded, caches.graph, caches.deps, caches.flows, extras.extraIds ?? EMPTY_IDS, extras.hiddenIds ?? EMPTY_IDS),
  navigation: {
    navigateInto: (actions, id) => actions.setModuleFocus(id),
    canNavigateInto: (nodeType) => nodeType === "package" || nodeType === "file",
    rootLabel: "UI",
    rootNoun: "components",
    crumbs: crumbsFor,
    semanticParent: containmentSemanticParent,
  },
  ghostReveal: (actions, id) => actions.revealModule(id),
  minimalSeeds: (selection, index) => [...new Set(selection.map((id) => homeFileOf(id, index)))],
  relations: UI_RELATION_POLICY,
  highways: ALL_HIGHWAYS,
};

/** The minimal-graph overlay's Highways shape: SPOOL only — a flat graph has no containers to
 * pair-bundle and no frames to gutter-route. Its members+satellite tree still comes from the
 * separate `minimalRelayout` input shape rather than a SurfaceSpec `deriveTree`; semantic parity is
 * supplied by `minimalSemanticSource` plus the same required GraphSurface/controller contract used
 * here. Its gestures defer to the UNDERLYING lens's spec (`viewMode` stays modules/call/ui). */
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
