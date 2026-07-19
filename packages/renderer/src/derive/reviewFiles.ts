/**
 * The files-first review checklist's data: every changed file as one row, expanded into the touched
 * code units (functions/classes/interfaces/methods) inside it — the GitHub "Files changed" mental
 * model projected onto the graph. Units are exactly `computeAffectedNodes`' blocks (hunks ∩ node
 * ranges), so a checked unit corresponds 1:1 with an amber-ringed card on the review graph.
 *
 * Each unit carries a FINGERPRINT (its source span + the hunks that hit it); a persisted tick whose
 * fingerprint no longer matches renders "stale", so a new push after a tick never leaves a
 * silently-green row (same contract as flow ticks in reviewData.ts). File-level progress lives in
 * the graph-free review progress catalog, not in these projection-shaped rows.
 */

import { computeAffectedNodes, isTestPath, NON_BLOCK_KINDS, rangesOverlap } from "@meridian/core";
import type { ChangeStatus, GraphArtifact, GraphEdge, LineRange, ReviewContext } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ReviewTick } from "../state/reviewTicksPref";
import { buildInboundByTarget } from "./inboundEdges";
import { matchAffectedFiles } from "./matchAffectedFiles";

/** Kept in lockstep with core/coverage.ts: these edges mean execution reaches the target. */
const EXECUTION_EDGE_KINDS: ReadonlySet<string> = new Set(["calls", "instantiates", "renders"]);
const CALLER_CAP = 8;

export interface ReviewUnitRow {
  nodeId: string;
  displayName: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** Revision that owns this declaration's source span. Omitted rows are treated as HEAD for
   * backward-compatible persisted/test data; newly derived rows always set this explicitly. */
  sourceSide?: "head" | "base";
  /** Nesting depth below the file container (0 = top-level unit) — pure indentation. */
  depth: number;
  isTest: boolean;
  /** Span + overlapping hunks; a mismatch with a stored tick marks it stale. */
  fingerprint: string;
}

export interface CallerRef {
  nodeId: string;
  displayName: string;
  file: string;
  line: number;
}

export interface DeletedImpact {
  callers: CallerRef[];
  unresolvedCount: number;
  truncated: boolean;
  /** Exact overflow behind the capped list, retained so the UI can name what was omitted. */
  omittedCallerCount: number;
}

export interface ReviewFileRow {
  path: string;
  status: ChangeStatus;
  /** The file's module node on the active graph; a deleted file may resolve only via deletedImpact. */
  moduleId: string | null;
  /** Canonical test-code verdict. The path fallback covers added/deleted/unmatched files while the
   * graph tag covers explicitly tagged test modules whose filename is not heuristic-shaped. */
  isTest: boolean;
  /** Touched code units, ordered by start line. Empty ⇒ the change mapped to no extracted block. */
  units: ReviewUnitRow[];
  /** Distinct unchanged files with a direct, resolved execution edge into a changed unit. */
  blastRadius: number;
  /** Surviving direct callers into deleted code, resolved from the deletion-source graph. */
  deletedImpact: DeletedImpact | null;
}

/** Classify a review path even when its file row is currently projected out. Path heuristics cover
 * added/deleted files; the graph join covers explicitly tagged test modules with ordinary names. */
export function isReviewTestPath(
  path: string,
  index: GraphIndex,
  fallbackIndex: GraphIndex | null = null,
  testVerdicts: ReadonlyMap<string, boolean> | null = null,
): boolean {
  if (isTestPath(path)) {
    return true;
  }
  const explicitVerdict = testVerdicts?.get(path);
  if (explicitVerdict !== undefined) {
    return explicitVerdict;
  }
  const activeMatch = matchAffectedFiles(index, [path]).matched[0];
  if (activeMatch !== undefined) {
    // HEAD/current truth wins when the same path changed classification since the baseline.
    return index.testIds.has(activeMatch.moduleId);
  }
  if (fallbackIndex === null) {
    return false;
  }
  const fallbackMatch = matchAffectedFiles(fallbackIndex, [path]).matched[0];
  return fallbackMatch !== undefined && fallbackIndex.testIds.has(fallbackMatch.moduleId);
}

/** All changed files as review rows: in-graph files first (they are what the review is about; the
 * unmatched tail is typically build artifacts), path-ascending within each group, units by start
 * line. Pure. */
export function deriveReviewFiles(
  context: ReviewContext,
  artifact: GraphArtifact,
  index: GraphIndex,
  options: {
    baseIndex: GraphIndex | null;
    /** Canonical current-page verdicts retained outside the bounded graph projection. */
    testVerdicts?: ReadonlyMap<string, boolean>;
  },
): ReviewFileRow[] {
  const affected = computeAffectedNodes(artifact.nodes, context.changedFiles);
  const unitsByFile = new Map<string, ReviewUnitRow[]>();
  for (const node of affected) {
    // A hunk-less file's affected set is its MODULE node (core's honest fallback) — the file row
    // itself already represents that; a container kind must never render as a checkable unit.
    if (NON_BLOCK_KINDS.has(index.nodesById.get(node.nodeId)?.kind ?? "")) {
      continue;
    }
    const row = toUnitRow(node.nodeId, node.file, context, index);
    if (row) {
      const bucket = unitsByFile.get(node.file);
      bucket ? bucket.push(row) : unitsByFile.set(node.file, [row]);
    }
  }
  const matches = matchAffectedFiles(index, context.changedFiles.map((file) => file.path));
  const moduleByPath = new Map(matches.matched.map((match) => [match.path, match.moduleId]));
  const changedPaths = new Set(context.changedFiles.map((file) => file.path));
  const deletedPaths = new Set(
    context.changedFiles.filter((file) => file.status === "deleted").map((file) => file.path),
  );
  const activeInbound = buildInboundByTarget(index.edges, EXECUTION_EDGE_KINDS);
  const deletionIndex = options.baseIndex ?? index;
  const deletionInbound = options.baseIndex && deletedPaths.size > 0
    ? buildInboundByTarget(options.baseIndex.edges, EXECUTION_EDGE_KINDS)
    : activeInbound;
  const deletionTargetsByPath = new Map<string, string[]>();
  for (const node of deletionIndex.nodesById.values()) {
    if (!deletedPaths.has(node.location.file)) {
      continue;
    }
    const targets = deletionTargetsByPath.get(node.location.file);
    targets ? targets.push(node.id) : deletionTargetsByPath.set(node.location.file, [node.id]);
  }
  return [...context.changedFiles]
    .map((file) => {
      const units = (unitsByFile.get(file.path) ?? []).sort((a, b) => a.startLine - b.startLine);
      const moduleId = moduleByPath.get(file.path) ?? null;
      return {
        path: file.path,
        status: file.status,
        moduleId,
        isTest: isReviewTestPath(file.path, index, options.baseIndex, options.testVerdicts),
        units,
        blastRadius: blastRadiusOf(units, changedPaths, index, activeInbound),
        deletedImpact: file.status === "deleted"
          ? deletionImpactOf(deletionTargetsByPath.get(file.path), changedPaths, deletionIndex, deletionInbound)
          : null,
      };
    })
    .sort(byGraphThenPath);
}

function blastRadiusOf(
  units: readonly ReviewUnitRow[],
  changedPaths: ReadonlySet<string>,
  index: GraphIndex,
  inbound: ReadonlyMap<string, GraphEdge[]>,
): number {
  const callerFiles = new Set<string>();
  for (const unit of units) {
    for (const edge of inbound.get(unit.nodeId) ?? []) {
      if ((edge.resolution ?? "resolved") !== "resolved") {
        continue;
      }
      const source = index.nodesById.get(edge.source);
      if (source && !changedPaths.has(source.location.file)) {
        callerFiles.add(source.location.file);
      }
    }
  }
  return callerFiles.size;
}

function deletionImpactOf(
  targetIds: readonly string[] | undefined,
  changedPaths: ReadonlySet<string>,
  index: GraphIndex,
  inbound: ReadonlyMap<string, GraphEdge[]>,
): DeletedImpact | null {
  if (!targetIds || targetIds.length === 0) {
    return null;
  }

  const callers: CallerRef[] = [];
  const seenCallers = new Set<string>();
  let unresolvedCount = 0;
  for (const targetId of targetIds) {
    for (const edge of inbound.get(targetId) ?? []) {
      const source = index.nodesById.get(edge.source);
      if (!source || changedPaths.has(source.location.file)) {
        continue;
      }
      if ((edge.resolution ?? "resolved") !== "resolved") {
        unresolvedCount += 1;
        continue;
      }
      if (seenCallers.has(source.id)) {
        continue;
      }
      seenCallers.add(source.id);
      if (callers.length === CALLER_CAP) {
        continue;
      }
      callers.push({
        nodeId: source.id,
        displayName: source.displayName,
        file: source.location.file,
        line: source.location.startLine,
      });
    }
  }
  const omittedCallerCount = seenCallers.size - callers.length;
  return { callers, unresolvedCount, truncated: omittedCallerCount > 0, omittedCallerCount };
}

function byGraphThenPath(a: ReviewFileRow, b: ReviewFileRow): number {
  if ((a.moduleId === null) !== (b.moduleId === null)) {
    return a.moduleId === null ? 1 : -1;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** todo = never ticked; done = tick's fingerprint still matches; stale = the code moved since. */
export type CheckState = "todo" | "done" | "stale";

export function checkStateOf(fingerprint: string, tick: ReviewTick | undefined): CheckState {
  if (!tick) {
    return "todo";
  }
  return tick.fingerprint === fingerprint ? "done" : "stale";
}

/** Aggregate changed leaves beneath a structural unit (for example, methods inside a class). */
export function unitsViewState(
  units: readonly Pick<ReviewUnitRow, "nodeId" | "fingerprint">[],
  unitTicks: Record<string, ReviewTick>,
): CheckState {
  const states = units.map((unit) => checkStateOf(unit.fingerprint, unitTicks[unit.nodeId]));
  if (states.some((state) => state === "stale")) {
    return "stale";
  }
  return states.length > 0 && states.every((state) => state === "done") ? "done" : "todo";
}

/** The single unit-tick transition: done un-ticks; todo/stale ticks fresh. Returns a new record. */
export function applyUnitTick(
  ticks: Record<string, ReviewTick>,
  unit: Pick<ReviewUnitRow, "nodeId" | "fingerprint">,
  at: string,
): Record<string, ReviewTick> {
  const next = { ...ticks };
  if (checkStateOf(unit.fingerprint, ticks[unit.nodeId]) === "done") {
    delete next[unit.nodeId];
    return next;
  }
  next[unit.nodeId] = { at, fingerprint: unit.fingerprint };
  return next;
}

/** Toggle all directly changed leaves represented by one structural ancestor. */
export function applyUnitsToggle(
  units: readonly Pick<ReviewUnitRow, "nodeId" | "fingerprint">[],
  ticks: Record<string, ReviewTick>,
  at: string,
): Record<string, ReviewTick> {
  const markViewed = unitsViewState(units, ticks) !== "done";
  const next = { ...ticks };
  for (const unit of units) {
    if (markViewed) {
      next[unit.nodeId] = { at, fingerprint: unit.fingerprint };
    } else {
      delete next[unit.nodeId];
    }
  }
  return next;
}

/** Join an affected node to its display shape; null when the node vanished from the index. */
function toUnitRow(
  nodeId: string,
  file: string,
  context: ReviewContext,
  index: GraphIndex,
): ReviewUnitRow | null {
  const node = index.nodesById.get(nodeId);
  if (!node) {
    return null;
  }
  const hunks = context.changedFiles.find((changed) => changed.path === file)?.hunks;
  const start = node.location.startLine;
  const end = node.location.endLine ?? start;
  return {
    nodeId,
    displayName: node.displayName,
    kind: node.kind,
    startLine: start,
    endLine: end,
    sourceSide: "head",
    depth: unitDepth(nodeId, index),
    isTest: index.testIds.has(nodeId),
    fingerprint: `${start}:${end}|${hunksFingerprint(overlapping(hunks, start, end))}`,
  };
}

/** Containment steps below the file/package containers (core's NON_BLOCK_KINDS): a method inside a
 * class indents once. */
function unitDepth(nodeId: string, index: GraphIndex): number {
  return index
    .ancestorsOf(nodeId)
    .filter((ancestor) => ancestor.id !== nodeId && !NON_BLOCK_KINDS.has(ancestor.kind)).length;
}

function overlapping(hunks: readonly LineRange[] | undefined, start: number, end: number): LineRange[] {
  return (hunks ?? []).filter((hunk) => rangesOverlap(start, end, hunk));
}

/** Stable digest of hunk ranges; "whole-file" when the diff carried none (add/untracked/unparsed). */
function hunksFingerprint(hunks: readonly LineRange[] | undefined): string {
  if (!hunks || hunks.length === 0) {
    return "whole-file";
  }
  return hunks.map((hunk) => `${hunk.start}-${hunk.end}`).join(",");
}
