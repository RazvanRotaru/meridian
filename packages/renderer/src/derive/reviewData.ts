/**
 * The review checklist's data: every logic flow the PR directly touches, decorated for one row each.
 *
 * The affected-flow predicate and the change-detection fingerprint both live in `@meridian/core` (one
 * tested implementation shared with any future CLI report); this module joins their output to the
 * renderer's node index for display, preserving core's sort (changed flows first, then file/line).
 * `deriveReviewData` returns null when there is no valid `review` extension — the tab gates off.
 */

import { computeAffectedFlows, flowFingerprint, LOGIC_FLOW_EXTENSION, readReviewContext } from "@meridian/core";
import type { AffectedFlow, FlowStep, GraphArtifact, GraphNode, LogicFlows, NodeId, ReviewContext } from "@meridian/core";
import { buildGraphIndex, type GraphIndex } from "../graph/graphIndex";
import type { ReviewTick } from "../state/reviewTicksPref";
import { matchAffectedFiles, normalizePath } from "./matchAffectedFiles";
import { checkStateOf, type CheckState } from "./reviewFiles";

export interface AffectedFlowRow {
  /** Representative root opened by the review UI. For a Promise-resource story this is the
   * `returnsPromise` callable, which gives the sequence viewer the most complete lifecycle. */
  flow: AffectedFlow;
  /** Every original affected flow collapsed into this review story. Singleton rows contain only
   * their representative; grouped rows retain the unmerged evidence for filtering and debugging. */
  memberEvidence: AffectedFlowMemberEvidence[];
  /** Convenience identity set for group membership, selection, and legacy tick lookup. */
  memberFlowIds: NodeId[];
  /** Promise identity that caused multiple callable roots to be presented as one story. */
  causalResourceId: NodeId | null;
  displayName: string;
  kind: string;
  /** Owner node's location.file; null when the flow's node is missing from the graph. */
  file: string | null;
  /** Owner node's location.startLine; 0 when unknown. */
  startLine: number;
  isTest: boolean;
  group: "changed" | "impacted";
  /** Exact HEAD-vs-merge-base flow comparison when a prepared PR supplies both artifacts. */
  flowChange: "new" | "changed" | "unchanged" | "unknown";
  /** Current story fingerprint — a singleton's flowFingerprint, or all grouped member fingerprints. */
  fingerprint: string;
}

export interface AffectedFlowMemberEvidence {
  flow: AffectedFlow;
  displayName: string;
  kind: string;
  file: string | null;
  startLine: number;
  isTest: boolean;
  flowChange: AffectedFlowRow["flowChange"];
  fingerprint: string;
}

export interface ReviewData {
  context: ReviewContext;
  /** Order preserved from core sort: group "changed" first, then file asc, then startLine asc. */
  rows: AffectedFlowRow[];
  /** The full logic-flow trees, so the panel can render each affected flow's steps hierarchically. */
  flows: LogicFlows;
}

/** A grouped causal story matches a scope when any of its original flow roots belongs to it. */
export function affectedFlowTouchesIds(row: AffectedFlowRow, ids: ReadonlySet<string>): boolean {
  return row.memberFlowIds.some((flowId) => ids.has(flowId));
}

/** null when extensions.review is absent/malformed. Pure; called once in createBlueprintStore. */
export function deriveReviewData(artifact: GraphArtifact, index: GraphIndex): ReviewData | null {
  const context = readReviewContext(artifact);
  if (!context) {
    return null;
  }
  return deriveReviewDataFromContext(context, artifact, index);
}

/**
 * Same derivation from an EXPLICIT context rather than the artifact extension — the join point for a
 * runtime review source (a GitHub PR opened via `reviewPrInGraph`, whose changed files carry patch
 * hunks). The affected-flow predicate and the flow trees still come from the loaded artifact.
 */
export function deriveReviewDataFromContext(
  context: ReviewContext,
  artifact: GraphArtifact,
  index: GraphIndex,
  comparisonArtifact: GraphArtifact | null = null,
): ReviewData {
  const flows = readLogicFlows(artifact);
  const comparison = comparisonArtifact === null
    ? null
    : prepareFlowComparison(context, index, comparisonArtifact);
  const affected = computeAffectedFlows(artifact.nodes, flows, context.changedFiles);
  const decorated = affected.map((flow) => decorate(flow, flows, comparison, index));
  const rows = groupPromiseResourceRows(decorated, artifact, index);
  return { context, rows, flows };
}

/** One vocabulary with the files checklist (reviewFiles.ts), so the two never drift. */
export type TickState = CheckState;

/** todo = never ticked; done = ticked fingerprint still matches; stale = the flow changed since. */
export function tickStateOf(row: AffectedFlowRow, ticks: Record<string, ReviewTick>): TickState {
  return checkStateOf(row.fingerprint, ticks[row.flow.flowId]);
}

/**
 * The single pure tick transition, shared by the checklist checkbox and "Mark reviewed & back".
 * `toggle` is the checkbox: a done row un-ticks; a todo/stale row ticks fresh. `confirm` only ever
 * CONFIRMS — a done row is left exactly as-is (it must never silently un-tick the flow the reader
 * just finished reviewing). `at` is passed in so this stays pure: the store hands the wall clock, a
 * test hands a fixed string. Returns a new record; the caller persists it whole (never pruned).
 */
export function applyTick(
  ticks: Record<string, ReviewTick>,
  row: AffectedFlowRow,
  mode: "toggle" | "confirm",
  at: string,
): Record<string, ReviewTick> {
  const next = { ...ticks };
  if (tickStateOf(row, ticks) === "done") {
    if (mode === "toggle") {
      delete next[row.flow.flowId];
    }
    return next;
  }
  next[row.flow.flowId] = { at, fingerprint: row.fingerprint };
  return next;
}

/** Join one affected flow to its owner node for display; fall back to the raw id when it is missing. */
function decorate(
  flow: AffectedFlow,
  flows: LogicFlows,
  comparison: FlowComparison | null,
  index: GraphIndex,
): AffectedFlowRow {
  const node = index.nodesById.get(flow.flowId);
  const steps = flows[flow.flowId] ?? [];
  const evidence: AffectedFlowMemberEvidence = {
    flow,
    displayName: node?.displayName ?? flow.flowId,
    kind: node?.kind ?? "function",
    file: node?.location.file ?? null,
    startLine: node?.location.startLine ?? 0,
    isTest: index.testIds.has(flow.flowId),
    flowChange: compareFlow(flow.flowId, steps, comparison),
    fingerprint: flowFingerprint(steps),
  };
  return {
    ...evidence,
    memberEvidence: [evidence],
    memberFlowIds: [flow.flowId],
    causalResourceId: null,
    group: flow.ownerChanged ? "changed" : "impacted",
  };
}

const PROMISE_MEMBER_EDGE_KINDS = new Set(["returnsPromise", "resolvesPromise", "rejectsPromise"]);

/**
 * Present the API around one Promise identity as one review story. Awaiting callers intentionally
 * stay separate: they are broader flows that *use* the resource, while return/settlement callables
 * are the resource's own split API surface. Ambiguous callables touching multiple Promise
 * resources fail closed and keep their original row.
 */
export function groupPromiseResourceRows(
  rows: readonly AffectedFlowRow[],
  artifact: Pick<GraphArtifact, "edges">,
  index: Pick<GraphIndex, "nodesById">,
): AffectedFlowRow[] {
  const resourcesByFlow = new Map<NodeId, Set<NodeId>>();
  const returnersByResource = new Map<NodeId, Set<NodeId>>();
  for (const edge of artifact.edges) {
    if (!PROMISE_MEMBER_EDGE_KINDS.has(edge.kind)
      || (edge.resolution ?? "resolved") !== "resolved"
      || index.nodesById.get(edge.target)?.kind !== "promise") {
      continue;
    }
    addToSet(resourcesByFlow, edge.source, edge.target);
    if (edge.kind === "returnsPromise") {
      addToSet(returnersByResource, edge.target, edge.source);
    }
  }

  const groupsByResource = new Map<NodeId, AffectedFlowRow[]>();
  for (const row of rows) {
    const resources = [...(resourcesByFlow.get(row.flow.flowId) ?? [])];
    if (resources.length !== 1) {
      continue;
    }
    const resourceId = resources[0];
    const group = groupsByResource.get(resourceId);
    group ? group.push(row) : groupsByResource.set(resourceId, [row]);
  }

  const representativeByMember = new Map<NodeId, AffectedFlowRow>();
  for (const [resourceId, members] of groupsByResource) {
    if (members.length < 2) {
      continue;
    }
    const returners = returnersByResource.get(resourceId) ?? new Set<NodeId>();
    const representative = [...members].sort((left, right) =>
      Number(returners.has(right.flow.flowId)) - Number(returners.has(left.flow.flowId))
      || compareRows(left, right))[0]!;
    const merged = mergePromiseRows(resourceId, representative, members);
    for (const member of members) {
      representativeByMember.set(member.flow.flowId, merged);
    }
  }

  // Preserve computeAffectedFlows' review order: a grouped story occupies the first member's slot,
  // even when its preferred waiter representative occurred later in the original list.
  const emitted = new Set<AffectedFlowRow>();
  const result: AffectedFlowRow[] = [];
  for (const row of rows) {
    const grouped = representativeByMember.get(row.flow.flowId);
    if (grouped) {
      if (!emitted.has(grouped)) {
        emitted.add(grouped);
        result.push(grouped);
      }
    } else {
      result.push(row);
    }
  }
  return result;
}

function mergePromiseRows(
  resourceId: NodeId,
  representative: AffectedFlowRow,
  members: readonly AffectedFlowRow[],
): AffectedFlowRow {
  const evidence = members
    .flatMap((member) => member.memberEvidence)
    .sort((left, right) => compareEvidence(left, right));
  const memberFlowIds = evidence.map((member) => member.flow.flowId);
  const changedFiles = new Set<string>();
  for (const member of evidence) {
    member.flow.changedFilesHit.forEach((file) => changedFiles.add(file));
    if (member.flow.ownerChanged && member.flow.ownerFile !== null
      && member.flow.ownerFile !== representative.flow.ownerFile) {
      changedFiles.add(member.flow.ownerFile);
    }
  }
  const memberChanges = evidence.map((member) => member.flowChange);
  return {
    ...representative,
    flow: {
      ...representative.flow,
      ownerChanged: evidence.some((member) => member.flow.ownerChanged),
      changedFilesHit: [...changedFiles].sort(),
    },
    memberEvidence: evidence,
    memberFlowIds,
    causalResourceId: resourceId,
    isTest: evidence.every((member) => member.isTest),
    group: evidence.some((member) => member.flow.ownerChanged) ? "changed" : "impacted",
    flowChange: mergedFlowChange(memberChanges),
    fingerprint: groupedFingerprint(resourceId, evidence),
  };
}

function mergedFlowChange(changes: readonly AffectedFlowRow["flowChange"][]): AffectedFlowRow["flowChange"] {
  if (changes.includes("new")) return "new";
  if (changes.includes("changed")) return "changed";
  return changes.every((change) => change === "unchanged") ? "unchanged" : "unknown";
}

function groupedFingerprint(resourceId: NodeId, evidence: readonly AffectedFlowMemberEvidence[]): string {
  const identity = evidence
    .map((member) => `${member.flow.flowId}\u0000${member.fingerprint}`)
    .sort()
    .join("\u0001");
  return `causal:${resourceId}:${fnv1aHex(identity)}`;
}

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function addToSet(map: Map<NodeId, Set<NodeId>>, key: NodeId, value: NodeId): void {
  const values = map.get(key);
  values ? values.add(value) : map.set(key, new Set([value]));
}

function compareRows(left: AffectedFlowRow, right: AffectedFlowRow): number {
  return compareNullable(left.file, right.file)
    || left.startLine - right.startLine
    || compareText(left.flow.flowId, right.flow.flowId);
}

function compareEvidence(left: AffectedFlowMemberEvidence, right: AffectedFlowMemberEvidence): number {
  return compareNullable(left.file, right.file)
    || left.startLine - right.startLine
    || compareText(left.flow.flowId, right.flow.flowId);
}

function compareNullable(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compareText(left, right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface FlowComparison {
  flows: LogicFlows;
  /** Confident semantic counterpart for a HEAD id whose path-derived id changed in a rename. */
  baseIdByHeadId: Map<string, string>;
  /** Reverse map used to compare call targets without treating the path-only id rewrite as logic. */
  headIdByBaseId: Map<string, string>;
  /** Ambiguous rename matches are not evidence that a HEAD flow is new. */
  uncertainHeadIds: Set<string>;
  /** Old artifact source path -> current artifact source path for source-anchor normalization. */
  headSourcePathByBasePath: Map<string, string>;
}

/**
 * A flow is NEW only when the exact merge-base artifact has no flow under the same stable node id.
 * Node diff colour is deliberately not used as the authority: a pre-existing callable can acquire
 * its first chartable call/control step without the declaration itself being an added node.
 */
function compareFlow(
  flowId: string,
  steps: readonly FlowStep[],
  comparison: FlowComparison | null,
): AffectedFlowRow["flowChange"] {
  if (comparison === null) {
    return "unknown";
  }
  // Exact stable ids remain authoritative. Rename recovery is deliberately only a fallback.
  if (Object.prototype.hasOwnProperty.call(comparison.flows, flowId)) {
    return flowFingerprint(comparison.flows[flowId] ?? []) === flowFingerprint(steps)
      ? "unchanged"
      : "changed";
  }

  const baseId = comparison.baseIdByHeadId.get(flowId);
  if (baseId === undefined) {
    return comparison.uncertainHeadIds.has(flowId) ? "unknown" : "new";
  }
  if (!Object.prototype.hasOwnProperty.call(comparison.flows, baseId)) {
    // The callable survived the rename but acquired its first chartable flow in this PR.
    return "new";
  }
  const baseSteps = remapComparisonSteps(comparison.flows[baseId] ?? [], comparison);
  return flowFingerprint(baseSteps) === flowFingerprint(steps)
    ? "unchanged"
    : "changed";
}

/** The logicFlow extension, defensively: a non-object payload reads as no flows (graph-only artifact). */
function readLogicFlows(artifact: GraphArtifact): LogicFlows {
  return readLogicFlowsOrNull(artifact) ?? {};
}

/** null means the comparison artifact cannot answer flow-presence questions at all. */
function readLogicFlowsOrNull(artifact: GraphArtifact): LogicFlows | null {
  const raw = artifact.extensions?.[LOGIC_FLOW_EXTENSION];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  return raw as unknown as LogicFlows;
}

function prepareFlowComparison(
  context: ReviewContext,
  headIndex: GraphIndex,
  baseArtifact: GraphArtifact,
): FlowComparison | null {
  const flows = readLogicFlowsOrNull(baseArtifact);
  if (flows === null) {
    return null;
  }
  const comparison: FlowComparison = {
    flows,
    baseIdByHeadId: new Map(),
    headIdByBaseId: new Map(),
    uncertainHeadIds: new Set(),
    headSourcePathByBasePath: new Map(),
  };
  const baseIndex = buildGraphIndex(baseArtifact);
  for (const changed of context.changedFiles) {
    if (changed.status !== "renamed" || changed.previousPath === undefined) {
      continue;
    }
    const baseModuleId = matchedModuleId(baseIndex, changed.previousPath);
    const headModuleId = matchedModuleId(headIndex, changed.path);
    if (baseModuleId === null || headModuleId === null) {
      continue;
    }
    addRenamedFileCounterparts(baseIndex, baseModuleId, headIndex, headModuleId, comparison);
    const baseFile = baseIndex.nodesById.get(baseModuleId)?.location.file;
    const headFile = headIndex.nodesById.get(headModuleId)?.location.file;
    if (baseFile !== undefined && headFile !== undefined) {
      comparison.headSourcePathByBasePath.set(normalizePath(baseFile), headFile);
    }
  }
  return comparison;
}

function matchedModuleId(index: GraphIndex, path: string): string | null {
  const result = matchAffectedFiles(index, [path]);
  return result.matched.length === 1 && result.ambiguous.length === 0 ? result.matched[0].moduleId : null;
}

/**
 * Mirrors deletedNodeProjection's semantic counterpart rules: containment identity first,
 * signatures for overloads, then only a one-to-one remainder. Ambiguity stays unknown.
 */
function addRenamedFileCounterparts(
  baseIndex: GraphIndex,
  baseModuleId: string,
  headIndex: GraphIndex,
  headModuleId: string,
  result: FlowComparison,
): void {
  addCounterpart(baseModuleId, headModuleId, result);
  const baseGroups = groupBySemanticPath(moduleSubtree(baseIndex, baseModuleId), baseIndex, baseModuleId);
  const headGroups = groupBySemanticPath(moduleSubtree(headIndex, headModuleId), headIndex, headModuleId);
  for (const [key, headNodes] of headGroups) {
    const baseNodes = baseGroups.get(key);
    if (!baseNodes || baseNodes.length === 0) {
      continue;
    }
    pairSemanticGroup(baseNodes, headNodes, result);
  }
}

function moduleSubtree(index: GraphIndex, moduleId: string): GraphNode[] {
  return [...index.nodesById.values()].filter((node) => index.isWithinFocus(moduleId, node.id));
}

function groupBySemanticPath(
  nodes: readonly GraphNode[],
  index: GraphIndex,
  moduleId: string,
): Map<string, GraphNode[]> {
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.id === moduleId) {
      continue;
    }
    const path = index.ancestorsOf(node.id);
    const moduleIndex = path.findIndex((ancestor) => ancestor.id === moduleId);
    if (moduleIndex === -1) {
      continue;
    }
    const key = path
      .slice(moduleIndex + 1)
      .map((ancestor) => `${ancestor.kind}\u0000${ancestor.qualifiedName}`)
      .join("\u0001");
    const group = groups.get(key);
    group ? group.push(node) : groups.set(key, [node]);
  }
  return groups;
}

function pairSemanticGroup(
  baseNodes: readonly GraphNode[],
  headNodes: readonly GraphNode[],
  result: FlowComparison,
): void {
  const remainingBase = new Set(baseNodes);
  const remainingHead = new Set(headNodes);

  for (const base of baseNodes) {
    const exact = headNodes.find((head) => head.id === base.id);
    if (exact) {
      addCounterpart(base.id, exact.id, result);
      remainingBase.delete(base);
      remainingHead.delete(exact);
    }
  }

  const baseBySignature = uniqueBySignature(remainingBase);
  const headBySignature = uniqueBySignature(remainingHead);
  for (const [signature, base] of baseBySignature) {
    const head = headBySignature.get(signature);
    if (head) {
      addCounterpart(base.id, head.id, result);
      remainingBase.delete(base);
      remainingHead.delete(head);
    }
  }

  if (remainingBase.size === 1 && remainingHead.size === 1) {
    addCounterpart([...remainingBase][0].id, [...remainingHead][0].id, result);
    remainingBase.clear();
    remainingHead.clear();
  }

  if (remainingBase.size > 0) {
    for (const head of remainingHead) {
      result.uncertainHeadIds.add(head.id);
    }
  }
}

function uniqueBySignature(nodes: ReadonlySet<GraphNode>): Map<string, GraphNode> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.signature) {
      counts.set(node.signature, (counts.get(node.signature) ?? 0) + 1);
    }
  }
  const unique = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.signature && counts.get(node.signature) === 1) {
      unique.set(node.signature, node);
    }
  }
  return unique;
}

function addCounterpart(baseId: string, headId: string, result: FlowComparison): void {
  result.baseIdByHeadId.set(headId, baseId);
  result.headIdByBaseId.set(baseId, headId);
}

function remapComparisonSteps(steps: readonly FlowStep[], comparison: FlowComparison): FlowStep[] {
  return steps.map((step): FlowStep => {
    const source = step.source === undefined
      ? {}
      : { source: remapSource(step.source, comparison.headSourcePathByBasePath) };
    if (step.kind === "call") {
      return {
        ...step,
        ...source,
        target: step.target === null ? null : comparison.headIdByBaseId.get(step.target) ?? step.target,
      };
    }
    if (step.kind === "loop" || step.kind === "callback") {
      return { ...step, ...source, body: remapComparisonSteps(step.body, comparison) };
    }
    if (step.kind === "branch") {
      return {
        ...step,
        ...source,
        paths: step.paths.map((path) => ({
          ...path,
          ...(path.source === undefined
            ? {}
            : { source: remapSource(path.source, comparison.headSourcePathByBasePath) }),
          body: remapComparisonSteps(path.body, comparison),
        })),
      };
    }
    return { ...step, ...source };
  });
}

function remapSource(
  source: NonNullable<FlowStep["source"]>,
  headPathByBasePath: ReadonlyMap<string, string>,
): NonNullable<FlowStep["source"]> {
  const file = headPathByBasePath.get(normalizePath(source.file));
  return file === undefined || file === source.file ? source : { ...source, file };
}
