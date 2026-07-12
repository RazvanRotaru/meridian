/** Read-only Map projection which locates the open minimal graph in locally-disclosable context. */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { LogicFlows } from "@meridian/core";
import { useBlueprint } from "../state/StoreContext";
import { buildModuleGraph } from "../derive/moduleGraph";
import { buildBlockDeps } from "../derive/blockDeps";
import {
  applyMinimalCodebaseExpansionOverrides,
  deriveMinimalCodebaseContext,
} from "../derive/minimalCodebaseContext";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import { MAP_RELATION_POLICY } from "../graph/lensRelationPolicy";
import { GraphSurface } from "./canvas/GraphSurface";
import type { ModuleNodeHandlers } from "./canvas/useModuleNodeInteractions";
import { useSemanticSurfaceNavigation } from "./canvas/useSemanticSurfaceNavigation";
import { useRecenter } from "./canvas/useRecenter";
import { activeModuleSurfaceSpec } from "./canvas/surfaceSpec";
import { minimalMiniMapColor } from "./minimalGraphStyles";
import { MapLegend } from "./MapLegend";
import { CanvasActionBar } from "./controlpanel/CanvasActionBar";
import { EmptyMinimalCodebaseContext, MinimalCodebaseSummary } from "./MinimalCodebaseChrome";

type ContextLayoutStatus = "laying-out" | "ready" | "error";
const EMPTY_LAYOUT = { nodes: [] as Node[], edges: [] as Edge[] };
const NO_SEMANTIC_COMMIT = { mode: "retained-anchor", commit: () => false } as const;
const CONTEXT_FIT = { maxZoom: 1 } as const;
const READ_ONLY_INTERACTIONS: ModuleNodeHandlers = {
  onNodeClick: () => undefined,
  onNodeDoubleClick: () => undefined,
  onPaneClick: () => undefined,
  expandedGhostGroupIds: new Set<string>(),
  toggleGhostGroup: () => undefined,
  paintSelectionOverride: null,
};

export function MinimalCodebaseView({
  onBackToGraph,
  backButtonRef,
}: {
  onBackToGraph: () => void;
  backButtonRef?: React.Ref<HTMLButtonElement>;
}) {
  const artifact = useBlueprint((state) => state.artifact);
  const index = useBlueprint((state) => state.index);
  const memberIds = useBlueprint((state) => state.minimalMemberIds);
  const minimalNodes = useBlueprint((state) => state.minimalRfNodes);
  const minimalLayoutStatus = useBlueprint((state) => state.minimalLayoutStatus);
  const rollups = useBlueprint((state) => state.minimalRollups);
  const showTests = useBlueprint((state) => state.showTests);
  const reviewActive = useBlueprint((state) => state.review !== null);
  const reviewLit = useBlueprint((state) => state.reviewLitNodeIds);
  const reviewSelectedId = useBlueprint((state) => state.reviewSelectedId);
  const reviewFlowOpen = useBlueprint((state) => state.flowSelection !== null && state.reviewFlowBaseline !== null);
  const moduleGraph = useMemo(() => buildModuleGraph(index), [index]);
  const blockDeps = useMemo(() => buildBlockDeps(index), [index]);
  const flows = useMemo(
    () => (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows,
    [artifact],
  );
  // Members are the stable fallback while an overlay relayout is pending. Once laid, include every
  // real core card it disclosed (but not one-hop ghosts): the context must faithfully show the
  // declaration-level shape the reader was looking at, not merely its collapsed member files.
  const currentMinimalNodes = minimalLayoutStatus === "ready" ? minimalNodes : EMPTY_NODES;
  const minimalVisibleIds = useMemo(
    () => new Set(currentMinimalNodes.filter((node) => node.type !== "ghost").map((node) => node.id)),
    [currentMinimalNodes],
  );
  const retainedExpandedIds = useMemo(
    () => new Set(currentMinimalNodes
      .filter((node) => (node.data as { isExpanded?: unknown }).isExpanded === true)
      .map((node) => node.id)),
    [currentMinimalNodes],
  );
  const contextTargetIds = useMemo(
    () => [...new Set([
      ...memberIds,
      ...currentMinimalNodes
        .filter((node) => node.type !== "ghost" && index.nodesById.has(node.id))
        .map((node) => node.id),
    ])],
    [currentMinimalNodes, index, memberIds],
  );
  const canonicalContext = useMemo(
    () => deriveMinimalCodebaseContext({
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
    [blockDeps, contextTargetIds, flows, index, moduleGraph, retainedExpandedIds, rollups, showTests],
  );
  // Context disclosure is intentionally local to this mount. The canvas remains read-only for
  // selection/navigation, and leaving this tab drops the overrides without ever touching the
  // hidden minimal graph's shared moduleExpanded state.
  const [expansionOverrides, setExpansionOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
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
  const toggleContextExpand = useCallback((nodeId: string) => {
    if (context === null) {
      return;
    }
    const node = context.tree.nodes.find((candidate) => candidate.id === nodeId);
    if (!node?.isContainer) {
      return;
    }
    const nextExpanded = !context.reveal.moduleExpanded.has(nodeId);
    setExpansionOverrides((current) => {
      const next = new Map(current);
      next.set(nodeId, nextExpanded);
      return next;
    });
  }, [context]);
  const [layout, setLayout] = useState(EMPTY_LAYOUT);
  const [layoutStatus, setLayoutStatus] = useState<ContextLayoutStatus>("laying-out");

  useEffect(() => {
    let current = true;
    if (context === null) {
      setLayout(EMPTY_LAYOUT);
      setLayoutStatus("ready");
      return () => { current = false; };
    }
    setLayoutStatus("laying-out");
    void layoutModuleTree(context.tree.nodes, context.tree.edges, MAP_RELATION_POLICY).then(
      (next) => {
        if (!current) return;
        setLayout(next);
        setLayoutStatus("ready");
      },
      () => {
        if (current) setLayoutStatus("error");
      },
    );
    return () => { current = false; };
  }, [context]);

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
    () => reviewSelectedId === null ? highlightedIds : [reviewSelectedId],
    [highlightedIds, reviewSelectedId],
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
      interactions={READ_ONLY_INTERACTIONS}
      readOnly
      onToggleExpand={toggleContextExpand}
      // PR nodes keep their added/modified/deleted rings; a neutral selection ring would mask the
      // very change colours this overview exists to locate. Paint still emphasizes the full set.
      selectionOverride={reviewActive ? EMPTY_HIGHLIGHTS : highlighted}
      paintSelectionOverride={paintTargets}
      nodeDiffPreview={reviewActive}
      emphasisMode={reviewFlowOpen ? (reviewSelectedId === null ? "subgraph" : "node") : undefined}
      groupGhosts={reviewFlowOpen && reviewSelectedId !== null ? false : undefined}
      wireHover
      requestOverlayChrome={false}
      busy={layoutStatus === "laying-out" ? { label: "Locating code in the codebase…" } : undefined}
      autoFitView={false}
      semanticLayers={[]}
      semanticDepths={navigation.semanticDepths}
      semanticBandOriginDepth={navigation.semanticBandOriginDepth}
      semanticFirstPreviewMax={navigation.semanticFirstPreviewMax}
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
      {context === null && layoutStatus === "ready" ? <EmptyMinimalCodebaseContext /> : null}
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
const EMPTY_NODES: Node[] = [];
