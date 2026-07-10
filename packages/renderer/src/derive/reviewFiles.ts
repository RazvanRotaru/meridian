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
import type { ChangeStatus, GraphArtifact, LineRange, ReviewContext } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ReviewTick } from "../state/reviewTicksPref";
import { matchAffectedFiles } from "./matchAffectedFiles";

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

export interface ReviewFileRow {
  path: string;
  status: ChangeStatus;
  /** The file's module node on the graph (a minimal-graph seed frame); null == not in the graph. */
  moduleId: string | null;
  /** Touched code units, ordered by start line. Empty ⇒ the change mapped to no extracted block. */
  units: ReviewUnitRow[];
  /** File-level fingerprint (hunks digest) — staleness for the unit-less viewed tick. */
  fingerprint: string;
}

/** All changed files as review rows: in-graph files first (they are what the review is about; the
 * unmatched tail is typically build artifacts), path-ascending within each group, units by start
 * line. Pure. */
export function deriveReviewFiles(
  context: ReviewContext,
  artifact: GraphArtifact,
  index: GraphIndex,
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
  return [...context.changedFiles]
    .map((file) => ({
      path: file.path,
      status: file.status,
      moduleId: moduleByPath.get(file.path) ?? null,
      units: (unitsByFile.get(file.path) ?? []).sort((a, b) => a.startLine - b.startLine),
      fingerprint: hunksFingerprint(file.hunks),
    }))
    .sort(byGraphThenPath);
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
