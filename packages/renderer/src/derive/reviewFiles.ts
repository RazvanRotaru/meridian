/**
 * The files-first review checklist's data: every changed file as one row, expanded into the touched
 * code units (functions/classes/interfaces/methods) inside it — the GitHub "Files changed" mental
 * model projected onto the graph. Units are exactly `computeAffectedNodes`' blocks (hunks ∩ node
 * ranges), so a checked unit corresponds 1:1 with an amber-ringed card on the review graph.
 *
 * Each unit and each unit-less file carries a FINGERPRINT (its source span + the hunks that hit it);
 * a persisted tick whose fingerprint no longer matches renders "stale", so a new push after a tick
 * never leaves a silently-green row (same contract as flow ticks in reviewData.ts).
 */

import { computeAffectedNodes, NON_BLOCK_KINDS, rangesOverlap } from "@meridian/core";
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
  /** Touched code units, ordered by start line. Empty ⇒ the change mapped to no extracted block. */
  units: ReviewUnitRow[];
  /** File-level fingerprint (hunks digest) — staleness for the unit-less viewed tick. */
  fingerprint: string;
  /** Distinct unchanged files with a direct, resolved execution edge into a changed unit. */
  blastRadius: number;
  /** Surviving direct callers into deleted code, resolved from the deletion-source graph. */
  deletedImpact: DeletedImpact | null;
}

/** All changed files as review rows: in-graph files first (they are what the review is about; the
 * unmatched tail is typically build artifacts), path-ascending within each group, units by start
 * line. Pure. */
export function deriveReviewFiles(
  context: ReviewContext,
  artifact: GraphArtifact,
  index: GraphIndex,
  options: { baseIndex: GraphIndex | null },
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
      return {
        path: file.path,
        status: file.status,
        moduleId: moduleByPath.get(file.path) ?? null,
        units,
        fingerprint: hunksFingerprint(file.hunks),
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

/**
 * A file's aggregate viewed state. With units it DERIVES from them (all done ⇒ done; any stale ⇒
 * stale — a moved block must never hide under a green file). Without units the explicit file tick
 * decides. `fileTick` is ignored when units exist: the units are the single source of truth.
 */
export function fileViewState(
  file: ReviewFileRow,
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
): CheckState {
  if (file.units.length === 0) {
    return checkStateOf(file.fingerprint, fileTicks[file.path]);
  }
  const states = file.units.map((unit) => checkStateOf(unit.fingerprint, unitTicks[unit.nodeId]));
  if (states.some((state) => state === "stale")) {
    return "stale";
  }
  return states.every((state) => state === "done") ? "done" : "todo";
}

/** How many rows read as fully "viewed" (all their units done). ONE definition so the panel header,
 * the collapsed rail, and the control-panel resume chip all report the same progress fraction. */
export function countViewedFiles(
  files: readonly ReviewFileRow[],
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
): number {
  return files.filter((file) => fileViewState(file, unitTicks, fileTicks) === "done").length;
}

/** The single unit-tick transition: done un-ticks; todo/stale ticks fresh. Returns a new record. */
export function applyUnitTick(
  ticks: Record<string, ReviewTick>,
  unit: ReviewUnitRow,
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

/**
 * The file-viewed toggle, cascading over its units: a not-fully-viewed file ticks EVERYTHING fresh
 * (the "I've read this file" bulk gesture); a done file un-ticks everything. Unit-less files flip
 * their own explicit tick. Returns new records; callers persist them whole.
 */
export function applyFileToggle(
  file: ReviewFileRow,
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  at: string,
): { unitTicks: Record<string, ReviewTick>; fileTicks: Record<string, ReviewTick> } {
  const state = fileViewState(file, unitTicks, fileTicks);
  if (file.units.length === 0) {
    const nextFiles = { ...fileTicks };
    if (state === "done") {
      delete nextFiles[file.path];
    } else {
      nextFiles[file.path] = { at, fingerprint: file.fingerprint };
    }
    return { unitTicks, fileTicks: nextFiles };
  }
  const nextUnits = { ...unitTicks };
  for (const unit of file.units) {
    if (state === "done") {
      delete nextUnits[unit.nodeId];
    } else {
      nextUnits[unit.nodeId] = { at, fingerprint: unit.fingerprint };
    }
  }
  return { unitTicks: nextUnits, fileTicks };
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
