/**
 * The files-first review checklist's data: every changed file as one row, expanded into the touched
 * code units (functions/classes/interfaces/methods) inside it — the GitHub "Files changed" mental
 * model projected onto the graph. Units are exactly `computeAffectedNodes`' blocks (hunks ∩ node
 * ranges), so a checked unit corresponds 1:1 with an amber-ringed card on the review graph.
 *
 * Each unit and unit-less file carries a worker-proven semantic address plus exact-source digest.
 * A persisted tick whose identity/content no longer matches renders "stale", so line motion does
 * not erase progress and same-shaped changed text never stays silently green.
 */

import { computeAffectedNodes, isTestPath, NON_BLOCK_KINDS } from "@meridian/core";
import { reviewFingerprintsFromArtifact } from "@meridian/core";
import type { ChangeStatus, GraphArtifact, GraphEdge, ReviewContext } from "@meridian/core";
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
  /** Exact declaration-source digest; a mismatch with a stored tick marks it stale. */
  fingerprint: string;
  /** Worker-proven logical identity. Null means persistence must fail closed. */
  address?: string | null;
  /** Exact old-path identity accepted only for a unique Git rename mapping. */
  previousAddress?: string | null;
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
  /** Exact file/blob digest — staleness for the unit-less viewed tick. */
  fingerprint: string;
  address?: string | null;
  previousAddress?: string | null;
  /** Distinct unchanged files with a direct, resolved execution edge into a changed unit. */
  blastRadius: number;
  /** Surviving direct callers into deleted code, resolved from the deletion-source graph. */
  deletedImpact: DeletedImpact | null;
}

/** Classify a review path even when its file row is currently projected out. Path heuristics cover
 * added/deleted files; the graph join covers explicitly tagged test modules with ordinary names. */
export function isReviewTestPath(path: string, index: GraphIndex, fallbackIndex: GraphIndex | null = null): boolean {
  if (isTestPath(path)) {
    return true;
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
  options: { baseIndex: GraphIndex | null },
): ReviewFileRow[] {
  const affected = computeAffectedNodes(artifact.nodes, context.changedFiles);
  const fingerprints = reviewFingerprintsFromArtifact(artifact);
  const unitsByFile = new Map<string, ReviewUnitRow[]>();
  for (const node of affected) {
    // A hunk-less file's affected set is its MODULE node (core's honest fallback) — the file row
    // itself already represents that; a container kind must never render as a checkable unit.
    if (NON_BLOCK_KINDS.has(index.nodesById.get(node.nodeId)?.kind ?? "")) {
      continue;
    }
    const row = toUnitRow(node.nodeId, node.file, context, index, fingerprints?.units ?? null);
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
        isTest: isReviewTestPath(file.path, index, options.baseIndex),
        units,
        fingerprint: fingerprints?.files[normalizeReviewPath(file.path)]?.digest ?? "unverified",
        address: fingerprints?.files[normalizeReviewPath(file.path)]?.address ?? null,
        previousAddress: file.status === "renamed" && file.previousPath
          ? `file:v1\0${normalizeReviewPath(file.previousPath)}`
          : null,
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

/** todo = never ticked; done = semantic address + digest match; stale = reviewed content changed. */
export type CheckState = "todo" | "done" | "stale";

export function checkStateOf(
  fingerprint: string,
  tick: ReviewTick | undefined,
  address?: string | null,
): CheckState {
  if (!tick) {
    return "todo";
  }
  if (address === null || (address !== undefined && tick.address !== address)) return "stale";
  return tick.fingerprint === fingerprint ? "done" : "stale";
}

export function tickForUnit(unit: ReviewUnitRow, ticks: Record<string, ReviewTick>): ReviewTick | undefined {
  const direct = ticks[unit.nodeId];
  if (direct !== undefined) {
    return direct.address === unit.previousAddress && unit.address ? { ...direct, address: unit.address } : direct;
  }
  const addresses = [unit.address, unit.previousAddress].filter((value): value is string => typeof value === "string");
  const matches = Object.values(ticks).filter((tick) => tick.address !== undefined && addresses.includes(tick.address));
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  return match.address === unit.previousAddress && unit.address ? { ...match, address: unit.address } : match;
}

export function tickForFile(file: ReviewFileRow, ticks: Record<string, ReviewTick>): ReviewTick | undefined {
  const direct = ticks[file.path];
  if (direct !== undefined) {
    return direct.address === file.previousAddress && file.address ? { ...direct, address: file.address } : direct;
  }
  const addresses = [file.address, file.previousAddress].filter((value): value is string => typeof value === "string");
  const matches = Object.values(ticks).filter((tick) => tick.address !== undefined && addresses.includes(tick.address));
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  return match.address === file.previousAddress && file.address ? { ...match, address: file.address } : match;
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
    return checkStateOf(file.fingerprint, tickForFile(file, fileTicks), file.address);
  }
  return unitsViewState(file.units, unitTicks);
}

/** Aggregate changed leaves beneath a structural unit (for example, methods inside a class). */
export function unitsViewState(
  units: readonly ReviewUnitRow[],
  unitTicks: Record<string, ReviewTick>,
): CheckState {
  const states = units.map((unit) => checkStateOf(unit.fingerprint, tickForUnit(unit, unitTicks), unit.address));
  if (states.some((state) => state === "stale")) {
    return "stale";
  }
  return states.length > 0 && states.every((state) => state === "done") ? "done" : "todo";
}

/** Aggregate a set of changed files for folder-level progress. A stale descendant wins so a folder
 * can never retain a completed marker after one of its reviewed files changes. */
export function filesViewState(
  files: readonly ReviewFileRow[],
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
): CheckState {
  const states = files.map((file) => fileViewState(file, unitTicks, fileTicks));
  if (states.some((state) => state === "stale")) {
    return "stale";
  }
  return states.length > 0 && states.every((state) => state === "done") ? "done" : "todo";
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
  if (checkStateOf(unit.fingerprint, tickForUnit(unit, ticks), unit.address) === "done") {
    removeUnitTick(next, unit);
    return next;
  }
  removeUnitTick(next, unit);
  next[unit.nodeId] = { at, fingerprint: unit.fingerprint, ...(unit.address ? { address: unit.address } : {}) };
  return next;
}

/** Toggle all directly changed leaves represented by one structural ancestor. */
export function applyUnitsToggle(
  units: readonly ReviewUnitRow[],
  ticks: Record<string, ReviewTick>,
  at: string,
): Record<string, ReviewTick> {
  const markViewed = unitsViewState(units, ticks) !== "done";
  const next = { ...ticks };
  for (const unit of units) {
    if (markViewed) {
      removeUnitTick(next, unit);
      next[unit.nodeId] = { at, fingerprint: unit.fingerprint, ...(unit.address ? { address: unit.address } : {}) };
    } else {
      removeUnitTick(next, unit);
    }
  }
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
      removeFileTick(nextFiles, file);
    } else {
      removeFileTick(nextFiles, file);
      nextFiles[file.path] = { at, fingerprint: file.fingerprint, ...(file.address ? { address: file.address } : {}) };
    }
    return { unitTicks, fileTicks: nextFiles };
  }
  const nextUnits = { ...unitTicks };
  for (const unit of file.units) {
    if (state === "done") {
      removeUnitTick(nextUnits, unit);
    } else {
      removeUnitTick(nextUnits, unit);
      nextUnits[unit.nodeId] = { at, fingerprint: unit.fingerprint, ...(unit.address ? { address: unit.address } : {}) };
    }
  }
  return { unitTicks: nextUnits, fileTicks };
}

function removeUnitTick(ticks: Record<string, ReviewTick>, unit: ReviewUnitRow): void {
  delete ticks[unit.nodeId];
  removeUniqueAddressTick(ticks, [unit.address, unit.previousAddress]);
}

function removeFileTick(ticks: Record<string, ReviewTick>, file: ReviewFileRow): void {
  delete ticks[file.path];
  removeUniqueAddressTick(ticks, [file.address, file.previousAddress]);
}

function removeUniqueAddressTick(ticks: Record<string, ReviewTick>, candidates: readonly (string | null | undefined)[]): void {
  const addresses = candidates.filter((value): value is string => typeof value === "string");
  const keys = Object.entries(ticks)
    .filter(([, tick]) => tick.address !== undefined && addresses.includes(tick.address))
    .map(([key]) => key);
  if (keys.length === 1) delete ticks[keys[0]];
}

/** Folder-level bulk toggle. A partially viewed folder completes only its unfinished/stale files;
 * a fully viewed folder clears every descendant tick. This preserves already-completed work while
 * making the folder control an unambiguous all-on/all-off gesture. */
export function applyFilesToggle(
  files: readonly ReviewFileRow[],
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  at: string,
): { unitTicks: Record<string, ReviewTick>; fileTicks: Record<string, ReviewTick> } {
  const markViewed = filesViewState(files, unitTicks, fileTicks) !== "done";
  let nextUnitTicks = unitTicks;
  let nextFileTicks = fileTicks;
  for (const file of files) {
    const state = fileViewState(file, nextUnitTicks, nextFileTicks);
    if ((markViewed && state === "done") || (!markViewed && state !== "done")) {
      continue;
    }
    const next = applyFileToggle(file, nextUnitTicks, nextFileTicks, at);
    nextUnitTicks = next.unitTicks;
    nextFileTicks = next.fileTicks;
  }
  return { unitTicks: nextUnitTicks, fileTicks: nextFileTicks };
}

/** Join an affected node to its display shape; null when the node vanished from the index. */
function toUnitRow(
  nodeId: string,
  file: string,
  context: ReviewContext,
  index: GraphIndex,
  fingerprints: Record<string, { address: string; digest: string }> | null,
): ReviewUnitRow | null {
  const node = index.nodesById.get(nodeId);
  if (!node) {
    return null;
  }
  const start = node.location.startLine;
  const end = node.location.endLine ?? start;
  const identity = fingerprints?.[nodeId];
  const changed = context.changedFiles.find((entry) => normalizeReviewPath(entry.path) === normalizeReviewPath(file));
  return {
    nodeId,
    displayName: node.displayName,
    kind: node.kind,
    startLine: start,
    endLine: end,
    sourceSide: "head",
    depth: unitDepth(nodeId, index),
    isTest: index.testIds.has(nodeId),
    fingerprint: identity?.digest ?? "unverified",
    address: identity?.address ?? null,
    previousAddress: changed?.status === "renamed" && changed.previousPath
      ? semanticAddressAtPath(identity?.address, normalizeReviewPath(changed.previousPath))
      : null,
  };
}

function semanticAddressAtPath(address: string | undefined, path: string): string | null {
  if (!address?.startsWith("unit:v1\0")) return null;
  const parts = address.split("\0");
  if (parts.length !== 4) return null;
  parts[1] = path;
  return parts.join("\0");
}

function normalizeReviewPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Containment steps below the file/package containers (core's NON_BLOCK_KINDS): a method inside a
 * class indents once. */
function unitDepth(nodeId: string, index: GraphIndex): number {
  return index
    .ancestorsOf(nodeId)
    .filter((ancestor) => ancestor.id !== nodeId && !NON_BLOCK_KINDS.has(ancestor.kind)).length;
}
