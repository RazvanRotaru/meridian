/** Lightweight navigation coordinates plus separately-evictable rendered scenes. */

import type { BlueprintState, LayoutActivity } from "./store";

/**
 * One exact parent coordinate in an arbitrarily deep chain of extracted graphs.
 *
 * This record deliberately contains no ReactFlow arrays, layout geometry, graph artifacts/indexes,
 * or synthetic execution payloads. Those objects live in `MinimalGraphSceneSnapshot` and are kept
 * only by the shared byte/count-bounded recent-view cache. A history entry therefore remains cheap
 * after its fast-path scene has been evicted and can still reconstruct itself through a relayout.
 */
export interface MinimalGraphHistoryEntry {
  label: string;
  /** Opaque key into the bounded scene cache. Missing/evicted keys are normal. */
  sceneKey: string;
  moduleSelected: BlueprintState["moduleSelected"];
  moduleExpanded: BlueprintState["moduleExpanded"];
  minimalSeedIds: BlueprintState["minimalSeedIds"];
  minimalMemberIds: BlueprintState["minimalMemberIds"];
  minimalRollups: BlueprintState["minimalRollups"];
  minimalArrange: BlueprintState["minimalArrange"];
  minimalView: BlueprintState["minimalView"];
  minimalShowGhostNodes: BlueprintState["minimalShowGhostNodes"];
  minimalCodebaseExpansionOverrides: BlueprintState["minimalCodebaseExpansionOverrides"];
  minimalCodebaseTargetIds: BlueprintState["minimalCodebaseTargetIds"];
  minimalCodebaseRetainedExpandedIds: BlueprintState["minimalCodebaseRetainedExpandedIds"];
  showHighways: BlueprintState["showHighways"];
  showTests: BlueprintState["showTests"];
  reviewDiffOnly: BlueprintState["reviewDiffOnly"];
  reviewSelectedId: BlueprintState["reviewSelectedId"];
  reviewLitNodeIds: BlueprintState["reviewLitNodeIds"];
  reviewFocusedSubgraph: BlueprintState["reviewFocusedSubgraph"];
  flowSelection: BlueprintState["flowSelection"];
  flowPaneOrigin: BlueprintState["flowPaneOrigin"];
  requestFlowTraceId: BlueprintState["requestFlowTraceId"];
  requestFlowExpansionOverrides: BlueprintState["requestFlowExpansionOverrides"];
  flowPaneExpansionOverrides: BlueprintState["flowPaneExpansionOverrides"];
  syntheticExecutionRootId: BlueprintState["syntheticExecutionRootId"];
  syntheticExecutionHost: BlueprintState["syntheticExecutionHost"];
  syntheticExecutionStatus: BlueprintState["syntheticExecutionStatus"];
  syntheticExecutionError: BlueprintState["syntheticExecutionError"];
  syntheticExperimentRootId: BlueprintState["syntheticExperimentRootId"];
  syntheticInputOverrides: BlueprintState["syntheticInputOverrides"];
  syntheticFieldWatchers: BlueprintState["syntheticFieldWatchers"];
  syntheticEditorRequest: BlueprintState["syntheticEditorRequest"];
  syntheticSelectedMomentId: BlueprintState["syntheticSelectedMomentId"];
  syntheticFlowOrientation: BlueprintState["syntheticFlowOrientation"];
  syntheticFlowPresentation: BlueprintState["syntheticFlowPresentation"];
  reviewFlowSplitView: BlueprintState["reviewFlowSplitView"];
  reviewOpenFlowSplitOnSelect: BlueprintState["reviewOpenFlowSplitOnSelect"];
  reviewFlowExplicitView: BlueprintState["reviewFlowExplicitView"];
  logicSelected: BlueprintState["logicSelected"];
  /** Semantic return state only. The potentially large position map lives in the scene snapshot. */
  reviewFlowBaseline: BlueprintState["reviewFlowBaseline"];
}

/** Heavy, exact scene state. This is the only history object allowed in the bounded scene cache. */
export interface MinimalGraphSceneSnapshot {
  minimalBasePositions: BlueprintState["minimalBasePositions"];
  minimalRfNodes: BlueprintState["minimalRfNodes"];
  minimalRfEdges: BlueprintState["minimalRfEdges"];
  minimalLayoutStatus: BlueprintState["minimalLayoutStatus"];
  minimalLayoutActivity: BlueprintState["minimalLayoutActivity"];
  flowPaneRfNodes: BlueprintState["flowPaneRfNodes"];
  flowPaneRfEdges: BlueprintState["flowPaneRfEdges"];
  flowPaneLayoutStatus: BlueprintState["flowPaneLayoutStatus"];
  syntheticExecution: BlueprintState["syntheticExecution"];
  syntheticPreviousExecution: BlueprintState["syntheticPreviousExecution"];
  reviewFlowBaseline: BlueprintState["reviewFlowBaseline"];
}

export function captureMinimalGraphHistory(
  state: BlueprintState,
  sceneKey = "",
): MinimalGraphHistoryEntry {
  return {
    label: state.reviewFocusedSubgraph?.label
      ?? (state.review !== null && state.minimalGraphHistory.length === 0 ? "PR graph" : "extracted graph"),
    sceneKey,
    moduleSelected: new Set(state.moduleSelected),
    moduleExpanded: new Set(state.moduleExpanded),
    minimalSeedIds: [...state.minimalSeedIds],
    minimalMemberIds: [...state.minimalMemberIds],
    minimalRollups: cloneRollups(state.minimalRollups),
    minimalArrange: state.minimalArrange,
    minimalView: state.minimalView,
    minimalShowGhostNodes: state.minimalShowGhostNodes,
    minimalCodebaseExpansionOverrides: new Map(state.minimalCodebaseExpansionOverrides),
    minimalCodebaseTargetIds: [...state.minimalCodebaseTargetIds],
    minimalCodebaseRetainedExpandedIds: new Set(state.minimalCodebaseRetainedExpandedIds),
    showHighways: state.showHighways,
    showTests: state.showTests,
    reviewDiffOnly: state.reviewDiffOnly,
    reviewSelectedId: state.reviewSelectedId,
    reviewLitNodeIds: state.reviewLitNodeIds === null ? null : new Set(state.reviewLitNodeIds),
    reviewFocusedSubgraph: cloneReviewFocusedSubgraph(state.reviewFocusedSubgraph),
    flowSelection: cloneFlowSelection(state.flowSelection),
    flowPaneOrigin: state.flowPaneOrigin,
    requestFlowTraceId: state.requestFlowTraceId,
    requestFlowExpansionOverrides: new Set(state.requestFlowExpansionOverrides),
    flowPaneExpansionOverrides: new Set(state.flowPaneExpansionOverrides),
    syntheticExecutionRootId: state.syntheticExecutionRootId,
    syntheticExecutionHost: state.syntheticExecutionHost,
    syntheticExecutionStatus: state.syntheticExecutionStatus,
    syntheticExecutionError: state.syntheticExecutionError,
    syntheticExperimentRootId: state.syntheticExperimentRootId,
    syntheticInputOverrides: [...state.syntheticInputOverrides],
    syntheticFieldWatchers: [...state.syntheticFieldWatchers],
    syntheticEditorRequest: state.syntheticEditorRequest === null ? null : { ...state.syntheticEditorRequest },
    syntheticSelectedMomentId: state.syntheticSelectedMomentId,
    syntheticFlowOrientation: state.syntheticFlowOrientation,
    syntheticFlowPresentation: state.syntheticFlowPresentation,
    reviewFlowSplitView: state.reviewFlowSplitView,
    reviewOpenFlowSplitOnSelect: state.reviewOpenFlowSplitOnSelect,
    reviewFlowExplicitView: state.reviewFlowExplicitView,
    logicSelected: state.logicSelected,
    reviewFlowBaseline: cloneReviewFlowBaseline(state.reviewFlowBaseline, false),
  };
}

export function captureMinimalGraphScene(state: BlueprintState): MinimalGraphSceneSnapshot {
  return {
    minimalBasePositions: { ...state.minimalBasePositions },
    minimalRfNodes: state.minimalRfNodes,
    minimalRfEdges: state.minimalRfEdges,
    minimalLayoutStatus: state.minimalLayoutStatus,
    minimalLayoutActivity: state.minimalLayoutActivity,
    flowPaneRfNodes: state.flowPaneRfNodes,
    flowPaneRfEdges: state.flowPaneRfEdges,
    flowPaneLayoutStatus: state.flowPaneLayoutStatus,
    syntheticExecution: state.syntheticExecution,
    syntheticPreviousExecution: state.syntheticPreviousExecution,
    reviewFlowBaseline: cloneReviewFlowBaseline(state.reviewFlowBaseline, true),
  };
}

export function restoreMinimalGraphHistory(parent: MinimalGraphHistoryEntry): Partial<BlueprintState> {
  return {
    moduleSelected: new Set(parent.moduleSelected),
    moduleExpanded: new Set(parent.moduleExpanded),
    minimalSeedIds: [...parent.minimalSeedIds],
    minimalMemberIds: [...parent.minimalMemberIds],
    minimalRollups: cloneRollups(parent.minimalRollups),
    minimalArrange: parent.minimalArrange,
    minimalView: parent.minimalView,
    minimalShowGhostNodes: parent.minimalShowGhostNodes,
    minimalCodebaseExpansionOverrides: new Map(parent.minimalCodebaseExpansionOverrides),
    minimalCodebaseTargetIds: [...parent.minimalCodebaseTargetIds],
    minimalCodebaseRetainedExpandedIds: new Set(parent.minimalCodebaseRetainedExpandedIds),
    showHighways: parent.showHighways,
    showTests: parent.showTests,
    reviewDiffOnly: parent.reviewDiffOnly,
    reviewSelectedId: parent.reviewSelectedId,
    reviewLitNodeIds: parent.reviewLitNodeIds === null ? null : new Set(parent.reviewLitNodeIds),
    reviewFocusedSubgraph: cloneReviewFocusedSubgraph(parent.reviewFocusedSubgraph),
    flowSelection: cloneFlowSelection(parent.flowSelection),
    flowPaneOrigin: parent.flowPaneOrigin,
    requestFlowTraceId: parent.requestFlowTraceId,
    requestFlowExpansionOverrides: new Set(parent.requestFlowExpansionOverrides),
    flowPaneExpansionOverrides: new Set(parent.flowPaneExpansionOverrides),
    syntheticExecutionRootId: parent.syntheticExecutionRootId,
    syntheticExecutionHost: parent.syntheticExecutionHost,
    syntheticExecutionStatus: parent.syntheticExecutionStatus,
    syntheticExecutionError: parent.syntheticExecutionError,
    syntheticExperimentRootId: parent.syntheticExperimentRootId,
    syntheticInputOverrides: [...parent.syntheticInputOverrides],
    syntheticFieldWatchers: [...parent.syntheticFieldWatchers],
    syntheticEditorRequest: parent.syntheticEditorRequest === null ? null : { ...parent.syntheticEditorRequest },
    syntheticSelectedMomentId: parent.syntheticSelectedMomentId,
    syntheticFlowOrientation: parent.syntheticFlowOrientation,
    syntheticFlowPresentation: parent.syntheticFlowPresentation,
    reviewFlowExplicitView: parent.reviewFlowExplicitView,
    logicSelected: parent.logicSelected,
    reviewFlowBaseline: cloneReviewFlowBaseline(parent.reviewFlowBaseline, false),
  };
}

export function restoreMinimalGraphScene(scene: MinimalGraphSceneSnapshot): Partial<BlueprintState> {
  return {
    minimalBasePositions: { ...scene.minimalBasePositions },
    minimalRfNodes: scene.minimalRfNodes,
    minimalRfEdges: scene.minimalRfEdges,
    minimalLayoutStatus: scene.minimalLayoutStatus,
    minimalLayoutActivity: scene.minimalLayoutActivity,
    flowPaneRfNodes: scene.flowPaneRfNodes,
    flowPaneRfEdges: scene.flowPaneRfEdges,
    flowPaneLayoutStatus: scene.flowPaneLayoutStatus,
    syntheticExecution: scene.syntheticExecution,
    syntheticPreviousExecution: scene.syntheticPreviousExecution,
    reviewFlowBaseline: cloneReviewFlowBaseline(scene.reviewFlowBaseline, true),
  };
}

/** Safe reconstruction state when an exact scene was evicted. */
export function emptyMinimalGraphScene(
  parent: MinimalGraphHistoryEntry,
  activity: LayoutActivity = { label: "Restoring extracted graph…" },
): Partial<BlueprintState> {
  const needsLayout = parent.minimalView === "graph" && parent.minimalMemberIds.length > 0;
  return {
    minimalBasePositions: {},
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: needsLayout ? "laying-out" : "idle",
    minimalLayoutActivity: needsLayout ? activity : null,
    flowPaneRfNodes: [],
    flowPaneRfEdges: [],
    flowPaneLayoutStatus: "idle",
    syntheticExecution: null,
    syntheticPreviousExecution: null,
    syntheticExecutionRootId: null,
    syntheticExecutionHost: null,
    syntheticExecutionStatus: "idle",
    syntheticExecutionError: null,
    syntheticSelectedMomentId: null,
  };
}

/** Conservative byte estimate charged to the shared inactive-allocation budget. */
export function minimalGraphSceneResidentBytes(scene: MinimalGraphSceneSnapshot): number {
  try {
    const json = JSON.stringify(scene);
    if (json === undefined) return Number.MAX_SAFE_INTEGER;
    const serializedBytes = new TextEncoder().encode(json).byteLength;
    if (serializedBytes > Math.floor(Number.MAX_SAFE_INTEGER / 2)) return Number.MAX_SAFE_INTEGER;
    // The snapshot holds decoded JS objects/strings rather than a compact wire payload. Charging
    // two bytes per serialized byte is intentionally conservative without traversing it twice.
    return Math.max(1, serializedBytes * 2);
  } catch {
    // Cycles or non-serializable host objects must remain usable while current, but never enter the
    // inactive cache where their resident size cannot be bounded honestly.
    return Number.MAX_SAFE_INTEGER;
  }
}

function cloneRollups(rollups: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(rollups).map(([packageId, fileIds]) => [packageId, [...fileIds]]));
}

function cloneReviewFocusedSubgraph(
  value: BlueprintState["reviewFocusedSubgraph"],
): BlueprintState["reviewFocusedSubgraph"] {
  return value === null
    ? null
    : { ...value, filePaths: [...value.filePaths], moduleIds: [...value.moduleIds] };
}

function cloneFlowSelection(value: BlueprintState["flowSelection"]): BlueprintState["flowSelection"] {
  return value === null
    ? null
    : { rootId: value.rootId, blockPath: value.blockPath.map((segment) => ({ ...segment })) };
}

function cloneReviewFlowBaseline(
  value: BlueprintState["reviewFlowBaseline"],
  includePositions: boolean,
): BlueprintState["reviewFlowBaseline"] {
  return value === null
    ? null
    : {
        ...value,
        moduleSelected: new Set(value.moduleSelected),
        moduleExpanded: new Set(value.moduleExpanded),
        minimalSeedIds: [...value.minimalSeedIds],
        minimalMemberIds: [...value.minimalMemberIds],
        minimalBasePositions: includePositions ? { ...value.minimalBasePositions } : {},
        reviewLitNodeIds: value.reviewLitNodeIds === null ? null : new Set(value.reviewLitNodeIds),
      };
}
