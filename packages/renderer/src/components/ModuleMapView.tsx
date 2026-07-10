/**
 * The Module-map view — a THIN MOUNT of the shared GraphSurface (unified-canvas phase A): ONE
 * zoomable containment level. The whole-repo package overview at the top, or — once you
 * double-click a group card — that package/directory's children (sub-dirs as group cards, files as
 * file cards) wired by the import graph folded to this level. Nodes/edges are laid out in the
 * store (`moduleRfNodes`/`moduleRfEdges`); the base canvas runs the shared paint chain, highways,
 * hover, recenter, and interactions, configured by this lens's SurfaceSpec (Map or Service — both
 * mount here). Supplied by THIS mount, because they are Map/Service-specific:
 *
 *   1. `filterVisible` drops file cards a category/Tests toggle hides (group cards always stay) —
 *      a pure VISIBILITY filter over the laid-out graph, so positions are untouched;
 *   2. the LENS-lifetime hooks: the fit-once-per-LEVEL guard, the interaction hook (its pending
 *      single-click select), and the (muted-while-covered) recenter reaction — all of which must
 *      survive the minimal overlay replacing the canvas beneath it;
 *   3. the containment/scope breadcrumb, extract strip, empty-level card, legend, and coverage chrome.
 *
 * Navigation is one gesture set: double-click a package/file card to zoom IN (the spec's focus
 * dive); the breadcrumb (the containment trail) zooms OUT.
 */

import { useEffect, useMemo, useRef } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { BuildMinimalGraphButton, EmptyModuleMapCard, LevelBreadcrumb, ServiceScopeBreadcrumb } from "./ModuleMapChrome";
import { filterVisible } from "./moduleMapPaint";
import { CoveragePanel } from "./CoveragePanel";
import { BeaconArrows } from "./BeaconArrows";
import { MapLegend } from "./MapLegend";
import { GraphSurface, SURFACE_STYLE, type SurfaceFlowView } from "./canvas/GraphSurface";
import { activeModuleSurfaceSpec } from "./canvas/surfaceSpec";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { useRecenter } from "./canvas/useRecenter";
import { MinimalGraphView } from "./MinimalGraphView";
import { ReviewPanel } from "./review/ReviewPanel";
import { accentForKind } from "../theme/kindColors";
import type { BlockData, UnitCardData } from "../derive/moduleLevel";

const PACKAGE_KIND = "package";

export function ModuleMapView() {
  const nodes = useBlueprint((state) => state.moduleRfNodes);
  const edges = useBlueprint((state) => state.moduleRfEdges);
  const selected = useBlueprint((state) => state.moduleSelected);
  const layoutStatus = useBlueprint((state) => state.moduleLayoutStatus);
  const effectiveFocus = useBlueprint((state) => state.moduleEffectiveFocus);
  const index = useBlueprint((state) => state.index);
  const hiddenCategories = useBlueprint((state) => state.hiddenCategories);
  const showTests = useBlueprint((state) => state.showTests);
  const showPrivate = useBlueprint((state) => state.showPrivate);
  const minimalOpen = useBlueprint((state) => state.minimalSeedIds.length > 0);
  const viewMode = useBlueprint((state) => state.viewMode);
  const serviceScope = useBlueprint((state) => state.serviceScope);
  const { buildMinimalGraph, setModuleFocus, clearServiceScope } = useBlueprintActions();
  // This lens's spec (Map or Service) — the highways flags read from it.
  const spec = activeModuleSurfaceSpec(viewMode);
  // The lens-lifetime hooks live HERE (not in GraphSurface, which unmounts under the overlay): a
  // pending single-click select still lands after the overlay opens, and the recenter reaction is
  // muted while covered — the overlay's own recenter must win — then re-fits the kept selection
  // when the enabled flip fires on close.
  const interactions = useModuleNodeInteractions();
  useRecenter(useMemo(() => [...selected], [selected]), { enabled: !minimalOpen });

  // Category/test hiding is a pure VISIBILITY filter over the laid-out graph; positions are untouched.
  const { nodes: shownNodes, edges: shownEdges } = useMemo(
    () => filterVisible(nodes, edges, { hiddenCategories, showTests, testIds: index.testIds, showPrivate, privateIds: index.privateIds }),
    [nodes, edges, hiddenCategories, showTests, showPrivate, index.testIds, index.privateIds],
  );

  // Fit once per RELAYOUT: `moduleRfNodes` only changes when the level does, so clearing the guard
  // on `effectiveFocus` (a focus change) OR `showTests` (the Tests toggle relayouts + re-coords the
  // level) re-fits the fresh level to the viewport. Category/Private toggles and radius are
  // paint-only (they never change `nodes`), so they correctly do NOT trigger a refit. The Service
  // lens has no focus (`effectiveFocus` stays null there), so entering/exiting a scoped sub-view
  // clears the guard on the SCOPE's identity instead — the refit then fires only when the re-laid
  // `nodes` land, never against the outgoing canvas. Kept HERE (not in GraphSurface) so the guard
  // survives the minimal overlay covering this canvas — closing the overlay must not re-run the
  // whole-LEVEL fit (the recenter hook's enabled flip owns the close-time fit-to-selection).
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    fitted.current = false;
  }, [effectiveFocus, showTests, serviceScope]);
  useEffect(() => {
    if (!rfRef.current || nodes.length === 0 || fitted.current) {
      return;
    }
    fitted.current = true;
    requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 400, minZoom: 0.01 }));
  }, [nodes]);

  const isEmpty = nodes.length === 0 && layoutStatus === "ready";

  // The built minimal graph REPLACES the level canvas while open (after every hook above, so the
  // hook order is stable across open/close). Closing returns here with the selection intact. When a
  // PR review seeded the graph, ReviewPanel rides on the right (it self-hides when review is null —
  // a hand-built minimal graph — or when the reader hid it; MinimalGraphView then offers "Review").
  if (minimalOpen) {
    return (
      <div style={SURFACE_STYLE}>
        <div style={REVIEW_SPLIT_STYLE}>
          <div style={REVIEW_GRAPH_STYLE}>
            <MinimalGraphView />
          </div>
          <ReviewPanel />
        </div>
      </div>
    );
  }

  return (
    <GraphSurface
      nodes={shownNodes}
      edges={shownEdges}
      highways={spec.highways}
      miniMapColor={miniMapColor}
      interactions={interactions}
      onInit={(instance) => {
        rfRef.current = instance;
      }}
      wireHover
      flowExtras={renderBeacons}
    >
      {viewMode === "call" && serviceScope !== null ? (
        // The scoped Service sub-view's trail: "All services › <scope> ✕ [› <cluster>]" — the
        // cluster zoom (spec.focus.crumbs of the laid-out focus) composes onto the scope segment.
        // "All services" exits everything; ✕ drops the scope filter; the scope label (a button
        // only while zoomed) steps back out of the dive.
        <ServiceScopeBreadcrumb
          label={serviceScope.label}
          crumbs={spec.focus.crumbs(effectiveFocus, index)}
          onClear={() => {
            clearServiceScope();
            setModuleFocus(null);
          }}
          onExitScope={clearServiceScope}
          onFocus={setModuleFocus}
        />
      ) : (
        // The breadcrumb reads the LAID-OUT level's focus (`moduleEffectiveFocus`, written by the
        // relayout from the spec's deriveTree) — never a render-time re-derive — so the trail
        // always matches the canvas on screen, even mid-lens-switch before the new layout lands.
        // The spec names the root ("Repository" / "All services") and crumbs its own focus model.
        <LevelBreadcrumb
          focus={effectiveFocus}
          packageCount={effectiveFocus === null ? nodes.filter((node) => !node.parentId && node.type !== "ghost").length : 0}
          crumbs={spec.focus.crumbs(effectiveFocus, index)}
          onFocus={setModuleFocus}
          rootLabel={spec.focus.rootLabel}
          rootNoun={spec.focus.rootNoun}
        />
      )}
      {selected.size >= 1 ? <BuildMinimalGraphButton count={selected.size} onBuild={buildMinimalGraph} /> : null}
      {isEmpty ? <EmptyModuleMapCard focus={effectiveFocus} /> : null}
      <MapLegend hasSteps={shownNodes.some((node) => node.type === "step")} hasSelection={selected.size > 0} />
      <CoveragePanel />
    </GraphSurface>
  );
}

// A selected call step's definition beacons ride INSIDE the flow so they track pan/zoom.
const renderBeacons = (view: SurfaceFlowView) => <BeaconArrows targets={view.beacons} />;

// The MiniMap gets untyped `Node`s: a group card reads as a blue package tone, unit/block dots tint
// by their kind, each file dot by its category (the same palette as the cards) so a level stays
// legible at overview zoom.
function miniMapColor(node: Node): string {
  if (node.type === PACKAGE_KIND) {
    return "#5B9BE3";
  }
  if (node.type === "unit") {
    return accentForKind((node.data as UnitCardData).unitKind);
  }
  if (node.type === "block") {
    return accentForKind((node.data as BlockData).blockKind);
  }
  if (node.type === "step" || node.type === "ghost") {
    return "#565E68";
  }
  // File dots wear the neutral file-family accent (category lives on the card's text chip, not a hue).
  return accentForKind("module");
}

// PR-review split: the minimal-graph overlay flexes to fill, the flow panel takes its fixed rail on the right.
const REVIEW_SPLIT_STYLE: React.CSSProperties = { position: "absolute", inset: 0, display: "flex" };
const REVIEW_GRAPH_STYLE: React.CSSProperties = { position: "relative", flex: 1, minWidth: 0 };
