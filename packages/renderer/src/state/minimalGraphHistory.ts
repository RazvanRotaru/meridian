/** Lightweight navigation coordinates plus separately-evictable rendered scenes. */

import type { BlueprintState, LayoutActivity } from "./store";

export interface MinimalGraphNavigationLimits {
  /** Maximum semantic parent coordinates retained for Back navigation. */
  maxEntries: number;
  /** Maximum estimated resident bytes across coordinates and their projection metadata. */
  maxResidentBytes: number;
}

/**
 * Semantic graph coordinates are much smaller than decoded scenes, but a reader can create an
 * arbitrarily deep chain and each coordinate contains real Sets/Maps of ids. Keep a useful deep
 * window without allowing that metadata to become a second unbounded graph-shaped allocation.
 */
export const DEFAULT_MINIMAL_GRAPH_NAVIGATION_LIMITS: Readonly<MinimalGraphNavigationLimits> = {
  maxEntries: 64,
  maxResidentBytes: 4 * 1024 * 1024,
};

/**
 * One exact parent coordinate in the bounded semantic Back window of extracted graphs.
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
  minimalProjectionExtraIds: BlueprintState["minimalProjectionExtraIds"];
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

export interface BoundedMinimalGraphHistory {
  history: MinimalGraphHistoryEntry[];
  /** Oldest coordinates removed from the semantic window, in their original order. */
  truncatedSceneKeys: string[];
  residentBytes: number;
}

/**
 * Retain the newest semantic coordinates that fit both limits. `residentBytesBySceneKey` must
 * charge each history entry together with its projection frame; a missing/non-finite charge fails
 * closed and truncates that coordinate. Rendered scenes have their own stricter LRU and are not
 * part of this metadata budget.
 */
export function boundMinimalGraphHistory(
  entries: readonly MinimalGraphHistoryEntry[],
  residentBytesBySceneKey: ReadonlyMap<string, number>,
  limits: Readonly<MinimalGraphNavigationLimits> = DEFAULT_MINIMAL_GRAPH_NAVIGATION_LIMITS,
): BoundedMinimalGraphHistory {
  const maxEntries = nonNegativeSafeInteger(limits.maxEntries, "maxEntries");
  const maxResidentBytes = nonNegativeSafeInteger(limits.maxResidentBytes, "maxResidentBytes");
  let firstRetained = entries.length;
  let residentBytes = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries.length - index > maxEntries) break;
    const charge = residentBytesBySceneKey.get(entries[index]!.sceneKey);
    if (charge === undefined || !Number.isSafeInteger(charge) || charge < 0) break;
    const nextResidentBytes = saturatedAdd(residentBytes, charge);
    if (nextResidentBytes > maxResidentBytes) break;
    residentBytes = nextResidentBytes;
    firstRetained = index;
  }

  return {
    history: entries.slice(firstRetained),
    truncatedSceneKeys: entries.slice(0, firstRetained).map((entry) => entry.sceneKey),
    residentBytes,
  };
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
    minimalProjectionExtraIds: new Set(state.minimalProjectionExtraIds),
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
    minimalProjectionExtraIds: new Set(parent.minimalProjectionExtraIds),
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
  return minimalGraphResidentBytes(scene);
}

/**
 * Conservative heap-size estimate for decoded graph navigation values.
 *
 * JSON serialization cannot be used here: Set and Map serialize as `{}`, which made large id sets
 * effectively free. This traversal charges their backing slots and values, object/array slots,
 * UTF-16 strings, typed buffers, and shared references without walking an object twice. Values
 * whose resident contents cannot be inspected safely are rejected from inactive retention.
 */
export function minimalGraphResidentBytes(value: unknown): number {
  try {
    return Math.max(1, residentBytes(value, new WeakSet<object>()));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function residentBytes(value: unknown, seen: WeakSet<object>): number {
  if (value === null || value === undefined) return 8;
  switch (typeof value) {
    case "boolean": return 8;
    case "number": return 8;
    case "bigint": return 24 + value.toString().length * 2;
    case "string": return stringResidentBytes(value);
    case "symbol": return 24 + stringResidentBytes(value.description ?? "");
    // A function's captured environment is not inspectable. It may stay mounted in the current
    // scene, but must never enter a cache whose byte ceiling claims to account for it.
    case "function": return Number.MAX_SAFE_INTEGER;
    case "object": break;
  }

  const object = value as object;
  if (seen.has(object)) return 8;
  seen.add(object);

  if (object instanceof WeakMap || object instanceof WeakSet || object instanceof Promise) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (object instanceof ArrayBuffer) {
    return saturatedAdd(48, object.byteLength);
  }
  if (ArrayBuffer.isView(object)) {
    return saturatedAdd(64, object.byteLength);
  }
  if (object instanceof Date) return 48;
  if (Array.isArray(object)) {
    let total = saturatedAdd(40, saturatedMultiply(object.length, 8));
    for (let index = 0; index < object.length; index += 1) {
      if (index in object) total = saturatedAdd(total, residentBytes(object[index], seen));
    }
    return total;
  }
  if (object instanceof Set) {
    let total = saturatedAdd(56, saturatedMultiply(object.size, 24));
    for (const entry of object) total = saturatedAdd(total, residentBytes(entry, seen));
    return total;
  }
  if (object instanceof Map) {
    let total = saturatedAdd(56, saturatedMultiply(object.size, 40));
    for (const [key, entry] of object) {
      total = saturatedAdd(total, residentBytes(key, seen));
      total = saturatedAdd(total, residentBytes(entry, seen));
    }
    return total;
  }

  let total = 56;
  const descriptors = Object.getOwnPropertyDescriptors(object);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (descriptor === undefined) continue;
    total = saturatedAdd(total, typeof key === "string" ? stringResidentBytes(key) : 32);
    total = saturatedAdd(total, 16);
    if (!("value" in descriptor)) return Number.MAX_SAFE_INTEGER;
    total = saturatedAdd(total, residentBytes(descriptor.value, seen));
  }
  return total;
}

function stringResidentBytes(value: string): number {
  return saturatedAdd(24, saturatedMultiply(value.length, 2));
}

function saturatedMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  if (left > Math.floor(Number.MAX_SAFE_INTEGER / right)) return Number.MAX_SAFE_INTEGER;
  return left * right;
}

function saturatedAdd(left: number, right: number): number {
  if (left >= Number.MAX_SAFE_INTEGER - right) return Number.MAX_SAFE_INTEGER;
  return left + right;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
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
