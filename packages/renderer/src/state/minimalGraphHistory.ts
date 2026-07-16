/** Exact, session-only parent scenes for recursively extracted minimal graphs. */

import type { BlueprintState } from "./store";

/** One exact parent scene in an arbitrarily deep chain of extracted graphs. Arrays are retained by
 * reference so Back restores the already-laid geometry; mutable collections are copied at capture. */
export interface MinimalGraphHistoryEntry {
  label: string;
  moduleSelected: BlueprintState["moduleSelected"];
  moduleExpanded: BlueprintState["moduleExpanded"];
  minimalSeedIds: BlueprintState["minimalSeedIds"];
  minimalMemberIds: BlueprintState["minimalMemberIds"];
  minimalRollups: BlueprintState["minimalRollups"];
  minimalBasePositions: BlueprintState["minimalBasePositions"];
  minimalArrange: BlueprintState["minimalArrange"];
  minimalRfNodes: BlueprintState["minimalRfNodes"];
  minimalRfEdges: BlueprintState["minimalRfEdges"];
  minimalLayoutStatus: BlueprintState["minimalLayoutStatus"];
  minimalLayoutActivity: BlueprintState["minimalLayoutActivity"];
  minimalView: BlueprintState["minimalView"];
  minimalShowGhostNodes: BlueprintState["minimalShowGhostNodes"];
  minimalCodebaseExpansionOverrides: BlueprintState["minimalCodebaseExpansionOverrides"];
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
  flowPaneRfNodes: BlueprintState["flowPaneRfNodes"];
  flowPaneRfEdges: BlueprintState["flowPaneRfEdges"];
  flowPaneLayoutStatus: BlueprintState["flowPaneLayoutStatus"];
  syntheticExecution: BlueprintState["syntheticExecution"];
  syntheticPreviousExecution: BlueprintState["syntheticPreviousExecution"];
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
  reviewFlowBaseline: BlueprintState["reviewFlowBaseline"];
}

export function captureMinimalGraphHistory(state: BlueprintState): MinimalGraphHistoryEntry {
  return {
    label: state.reviewFocusedSubgraph?.label
      ?? (state.review !== null && state.minimalGraphHistory.length === 0 ? "PR graph" : "extracted graph"),
    moduleSelected: new Set(state.moduleSelected),
    moduleExpanded: new Set(state.moduleExpanded),
    minimalSeedIds: [...state.minimalSeedIds],
    minimalMemberIds: [...state.minimalMemberIds],
    minimalRollups: cloneRollups(state.minimalRollups),
    minimalBasePositions: { ...state.minimalBasePositions },
    minimalArrange: state.minimalArrange,
    minimalRfNodes: state.minimalRfNodes,
    minimalRfEdges: state.minimalRfEdges,
    minimalLayoutStatus: state.minimalLayoutStatus,
    minimalLayoutActivity: state.minimalLayoutActivity,
    minimalView: state.minimalView,
    minimalShowGhostNodes: state.minimalShowGhostNodes,
    minimalCodebaseExpansionOverrides: new Map(state.minimalCodebaseExpansionOverrides),
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
    flowPaneRfNodes: state.flowPaneRfNodes,
    flowPaneRfEdges: state.flowPaneRfEdges,
    flowPaneLayoutStatus: state.flowPaneLayoutStatus,
    syntheticExecution: state.syntheticExecution,
    syntheticPreviousExecution: state.syntheticPreviousExecution,
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
    reviewFlowBaseline: cloneReviewFlowBaseline(state.reviewFlowBaseline),
  };
}

export function restoreMinimalGraphHistory(parent: MinimalGraphHistoryEntry): Partial<BlueprintState> {
  return {
    moduleSelected: new Set(parent.moduleSelected),
    moduleExpanded: new Set(parent.moduleExpanded),
    minimalSeedIds: [...parent.minimalSeedIds],
    minimalMemberIds: [...parent.minimalMemberIds],
    minimalRollups: cloneRollups(parent.minimalRollups),
    minimalBasePositions: { ...parent.minimalBasePositions },
    minimalArrange: parent.minimalArrange,
    minimalRfNodes: parent.minimalRfNodes,
    minimalRfEdges: parent.minimalRfEdges,
    minimalLayoutStatus: parent.minimalLayoutStatus,
    minimalLayoutActivity: parent.minimalLayoutActivity,
    minimalView: parent.minimalView,
    minimalShowGhostNodes: parent.minimalShowGhostNodes,
    minimalCodebaseExpansionOverrides: new Map(parent.minimalCodebaseExpansionOverrides),
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
    flowPaneRfNodes: parent.flowPaneRfNodes,
    flowPaneRfEdges: parent.flowPaneRfEdges,
    flowPaneLayoutStatus: parent.flowPaneLayoutStatus,
    syntheticExecution: parent.syntheticExecution,
    syntheticPreviousExecution: parent.syntheticPreviousExecution,
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
    reviewFlowBaseline: cloneReviewFlowBaseline(parent.reviewFlowBaseline),
  };
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
): BlueprintState["reviewFlowBaseline"] {
  return value === null
    ? null
    : {
        ...value,
        moduleSelected: new Set(value.moduleSelected),
        moduleExpanded: new Set(value.moduleExpanded),
        minimalSeedIds: [...value.minimalSeedIds],
        minimalMemberIds: [...value.minimalMemberIds],
        minimalBasePositions: { ...value.minimalBasePositions },
        reviewLitNodeIds: value.reviewLitNodeIds === null ? null : new Set(value.reviewLitNodeIds),
      };
}
