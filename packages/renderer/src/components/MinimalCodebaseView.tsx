/** Navigation-frozen Map projection which locates the open minimal graph in selectable context. */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { LogicFlows } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { buildModuleGraph } from "../derive/moduleGraph";
import { buildBlockDeps } from "../derive/blockDeps";
import {
  applyMinimalCodebaseExpansionOverrides,
  deriveMinimalCodebaseContext,
  type MinimalCodebaseContext,
} from "../derive/minimalCodebaseContext";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import { MAP_RELATION_POLICY } from "../graph/lensRelationPolicy";
import { GraphSurface } from "./canvas/GraphSurface";
import { useModuleNodeInteractions } from "./canvas/useModuleNodeInteractions";
import { useSemanticSurfaceNavigation } from "./canvas/useSemanticSurfaceNavigation";
import { useRecenter } from "./canvas/useRecenter";
import { activeModuleSurfaceSpec } from "./canvas/surfaceSpec";
import { minimalMiniMapColor } from "./minimalGraphStyles";
import { MapLegend } from "./MapLegend";
import { CanvasActionBar } from "./controlpanel/CanvasActionBar";
import { EmptyMinimalCodebaseContext, MinimalCodebaseSummary } from "./MinimalCodebaseChrome";

type ContextLayoutStatus = "laying-out" | "ready" | "error";
const EMPTY_LAYOUT = { nodes: [] as Node[], edges: [] as Edge[] };
interface ContextLayoutResult {
  context: MinimalCodebaseContext | null;
  layout: typeof EMPTY_LAYOUT;
  status: ContextLayoutStatus;
}
const NO_SEMANTIC_COMMIT = { mode: "retained-anchor", commit: () => false } as const;
const CONTEXT_FIT = { maxZoom: 1 } as const;
export function MinimalCodebaseView({
  onBackToGraph,
  backButtonRef,
}: {
  onBackToGraph: () => void;
  backButtonRef?: React.Ref<HTMLButtonElement>;
}) {
  const artifact = useBlueprint((state) => state.artifact);
  const index = useBlueprint((state) => state.index);
  const capturedTargetIds = useBlueprint((state) => state.minimalCodebaseTargetIds);
  const retainedExpandedIds = useBlueprint((state) => state.minimalCodebaseRetainedExpandedIds);
  const projectionPending = useBlueprint((state) => state.minimalCodebaseProjectionPending);
  const selected = useBlueprint((state) => state.moduleSelected);
  const expansionOverrides = useBlueprint((state) => state.minimalCodebaseExpansionOverrides);
  const rollups = useBlueprint((state) => state.minimalRollups);
  const showTests = useBlueprint((state) => state.showTests);
  const reviewActive = useBlueprint((state) => state.review !== null);
  const reviewLit = useBlueprint((state) => state.reviewLitNodeIds);
  const reviewSelectedId = useBlueprint((state) => state.reviewSelectedId);
  const reviewFlowOpen = useBlueprint((state) => state.flowSelection !== null && state.reviewFlowBaseline !== null);
  const { setMinimalCodebaseExpansionOverride, toggleModuleSelect } = useBlueprintActions();
  const interactions = useModuleNodeInteractions({ onDoubleClick: () => true });
  const moduleGraph = useMemo(() => buildModuleGraph(index), [index]);
  const blockDeps = useMemo(() => buildBlockDeps(index), [index]);
  const flows = useMemo(
    () => (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows,
    [artifact],
  );
  // The store releases the hidden ReactFlow scene on Codebase entry. These ids are the lightweight
  // semantic coordinate captured before release; they preserve highlighting/disclosure without
  // pinning any inactive node/edge objects outside the shared eviction budget.
  const minimalVisibleIds = useMemo(() => new Set(capturedTargetIds), [capturedTargetIds]);
  const contextTargetIds = useMemo(
    () => [...new Set([
      ...capturedTargetIds,
      ...selected,
    ])],
    [capturedTargetIds, selected],
  );
  const canonicalContext = useMemo(
    () => projectionPending
      ? null
      : deriveMinimalCodebaseContext({
          index,
          moduleGraph,
          blockDeps,
          flows,
          minimalMemberIds: contextTargetIds,
          minimalRollups: rollups,
          hiddenIds: showTests ? undefined : index.testIds,
          expandedIds: retainedExpandedIds,
          demoteCommons: false,
        }),
    [blockDeps, contextTargetIds, flows, index, moduleGraph, projectionPending, retainedExpandedIds, rollups, showTests],
  );
  // Context disclosure is intentionally local to this mount. The canvas remains read-only for
  // selection/navigation, and leaving this tab drops the overrides without ever touching the
  // hidden minimal graph's shared moduleExpanded state.
  const context = useMemo(
    () => canonicalContext === null
      ? null
      : applyMinimalCodebaseExpansionOverrides(
          canonicalContext,
          {
            index,
            moduleGraph,
            blockDeps,
            flows,
            hiddenIds: showTests ? undefined : index.testIds,
            demoteCommons: false,
          },
          expansionOverrides,
        ),
    [blockDeps, canonicalContext, expansionOverrides, flows, index, moduleGraph, showTests],
  );
  useEffect(() => {
    if (context === null) {
      return;
    }
    const visibleIds = new Set(
      context.tree.nodes.filter((node) => node.kind !== "ghost").map((node) => node.id),
    );
    [...selected]
      .filter((id) => !visibleIds.has(id))
      .forEach(toggleModuleSelect);
  }, [context, selected, toggleModuleSelect]);
  const toggleContextExpand = useCallback((nodeId: string) => {
    if (context === null) {
      return;
    }
    const node = context.tree.nodes.find((candidate) => candidate.id === nodeId);
    if (!node?.isContainer) {
      return;
    }
    const nextExpanded = !context.reveal.moduleExpanded.has(nodeId);
    setMinimalCodebaseExpansionOverride(nodeId, nextExpanded);
  }, [context, setMinimalCodebaseExpansionOverride]);
  const [layoutResult, setLayoutResult] = useState<ContextLayoutResult>({
    context: null,
    layout: EMPTY_LAYOUT,
    status: "laying-out",
  });

  useEffect(() => {
    let current = true;
    if (projectionPending) {
      setLayoutResult({ context: null, layout: EMPTY_LAYOUT, status: "laying-out" });
      return () => { current = false; };
    }
    if (context === null) {
      setLayoutResult({ context: null, layout: EMPTY_LAYOUT, status: "ready" });
      return () => { current = false; };
    }
    setLayoutResult({ context, layout: EMPTY_LAYOUT, status: "laying-out" });
    void layoutModuleTree(context.tree.nodes, context.tree.edges, MAP_RELATION_POLICY).then(
      (next) => {
        if (!current) return;
        setLayoutResult({ context, layout: next, status: "ready" });
      },
      () => {
        if (current) setLayoutResult({ context, layout: EMPTY_LAYOUT, status: "error" });
      },
    );
    return () => { current = false; };
  }, [context, projectionPending]);

  // A context can change between render and the passive layout effect. Never expose the previous
  // context's nodes or ready status during that window: doing so lets navigation fit stale geometry
  // and strand the eventual projection beneath the review rail.
  const layoutCurrent = !projectionPending && layoutResult.context === context;
  const layout = layoutCurrent ? layoutResult.layout : EMPTY_LAYOUT;
  const layoutStatus: ContextLayoutStatus = projectionPending
    ? "laying-out"
    : layoutCurrent
      ? layoutResult.status
      : context === null ? "ready" : "laying-out";

  const highlighted = useMemo(() => {
    const ids = new Set(context?.highlightTargetIds ?? EMPTY_HIGHLIGHTS);
    layout.nodes.forEach((node) => {
      if (minimalVisibleIds.has(node.id)) ids.add(node.id);
    });
    return ids;
  }, [context, layout.nodes, minimalVisibleIds]);
  const paintTargets = reviewActive && reviewLit !== null ? reviewLit : highlighted;
  const highlightedIds = useMemo(() => [...highlighted], [highlighted]);
  const highlightedNodes = useMemo(() => {
    const targets = layout.nodes.filter((node) => highlighted.has(node.id));
    return targets.length > 0 ? targets : layout.nodes;
  }, [highlighted, layout.nodes]);
  const recenterIds = useMemo(
    () => reviewSelectedId !== null
      ? [reviewSelectedId]
      : selected.size > 0 ? [...selected] : highlightedIds,
    [highlightedIds, reviewSelectedId, selected],
  );
  useRecenter(recenterIds, { maxZoom: 1 });
  const navigation = useSemanticSurfaceNavigation({
    nodes: layout.nodes,
    fitNodes: highlightedNodes,
    layoutStatus,
    semanticLayers: [],
    resetKeys: [context],
    commitAdapter: NO_SEMANTIC_COMMIT,
    fit: CONTEXT_FIT,
  });

  return (
    <GraphSurface
      nodes={layout.nodes}
      edges={layout.edges}
      highways={activeModuleSurfaceSpec("modules").highways}
      relations={MAP_RELATION_POLICY}
      miniMapColor={minimalMiniMapColor}
      interactions={interactions}
      readOnly
      selectionOnly
      onToggleExpand={toggleContextExpand}
      // PR nodes keep their added/modified/deleted rings; a neutral selection ring would mask the
      // very change colours this overview exists to locate. Paint still emphasizes the full set.
      paintSelectionOverride={paintTargets}
      nodeDiffPreview={reviewActive && !projectionPending}
      emphasisMode={reviewFlowOpen ? (reviewSelectedId === null ? "subgraph" : "node") : undefined}
      groupGhosts={reviewFlowOpen && reviewSelectedId !== null ? false : undefined}
      wireHover
      requestOverlayChrome={false}
      busy={layoutStatus === "laying-out"
        ? { label: projectionPending ? "Loading codebase projection…" : "Locating code in the codebase…" }
        : undefined}
      autoFitView={false}
      semanticLayers={[]}
      semanticDepths={navigation.semanticDepths}
      semanticBandOriginDepth={navigation.semanticBandOriginDepth}
      semanticLodEnabled={navigation.semanticLodEnabled}
      semanticCommitEnabled={navigation.semanticCommitEnabled}
      onSemanticCommit={navigation.onSemanticCommit}
      onInit={navigation.onInit}
    >
      <MinimalCodebaseSummary
        context={context}
        status={layoutStatus}
        targetCount={contextTargetIds.length}
        highlightedCount={highlighted.size}
      />
      {!projectionPending && context === null && layoutStatus === "ready" ? <EmptyMinimalCodebaseContext /> : null}
      <MapLegend
        hasSteps={layout.nodes.some((node) => node.type === "step")}
        showPackages={layout.nodes.some((node) => node.type === "package")}
        showIpc={false}
        relationPolicy={MAP_RELATION_POLICY}
        readOnly
      />
      <CanvasActionBar minimalView="codebase" onBackToGraph={onBackToGraph} backButtonRef={backButtonRef} />
    </GraphSurface>
  );
}

const EMPTY_HIGHLIGHTS: ReadonlySet<string> = new Set<string>();
