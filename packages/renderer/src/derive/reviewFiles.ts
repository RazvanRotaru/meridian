/**
 * The files-first review checklist's data: every changed file as one row, expanded into the touched
 * code units (functions/classes/interfaces/methods) inside it — the GitHub "Files changed" mental
 * model projected onto the graph. Units are exactly `computeAffectedNodes`' blocks (hunks ∩ node
 * ranges), so a checked unit corresponds 1:1 with a reviewed card on the graph. GitHub still
 * exposes one file-level checkbox; callers synchronize that checkbox only when every unit in the
 * file crosses the viewed boundary.
 *
 * Each unit and file carries a worker-proven semantic address plus exact-source digest.
 * A persisted tick whose identity/content no longer matches renders "stale", so line motion does
 * not erase progress and same-shaped changed text never stays silently green.
 */

import { computeAffectedNodes, isTestPath, NON_BLOCK_KINDS } from "@meridian/core";
import { reviewFingerprintsFromArtifact } from "@meridian/core";
import type { ChangeStatus, GraphArtifact, GraphEdge, ReviewContext } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { PrFileViewedState } from "../state/prTypes";
import { setReviewTick, type ReviewTick } from "../state/reviewTicksPref";
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
  const moduleByPath = new Map<string, string>();
  for (const file of context.changedFiles) {
    const matches = matchAffectedFiles(index, [file.path]);
    if (matches.matched.length === 1) moduleByPath.set(file.path, matches.matched[0].moduleId);
  }
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
      const fileIdentity = fingerprints !== null && Object.hasOwn(fingerprints.files, file.path)
        ? fingerprints.files[file.path]
        : undefined;
      return {
        path: file.path,
        status: file.status,
        moduleId,
        isTest: isReviewTestPath(file.path, index, options.baseIndex),
        units,
        fingerprint: fileIdentity?.digest ?? "unverified",
        address: fileIdentity?.address ?? null,
        previousAddress: file.status === "renamed" && file.previousPath
          ? `file:v1\0${file.previousPath}`
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

export interface ReviewUnitCoordinates {
  viewerId?: string | null;
  headSha?: string | null;
}

export interface ReviewUnitProvenance {
  viewerId?: string;
  viewerLogin?: string;
  headSha?: string;
}

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
  const direct = Object.hasOwn(ticks, unit.nodeId) ? ticks[unit.nodeId] : undefined;
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
  const direct = Object.hasOwn(ticks, file.path) ? ticks[file.path] : undefined;
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
 * A file with extracted units derives its state from those units. GitHub's VIEWED bit is a
 * whole-file baseline (all units viewed), while UNVIEWED/DISMISSED still permit Meridian's finer
 * partial progress. Unit-less files continue to use GitHub or their explicit file tick directly.
 */
export function fileViewState(
  file: ReviewFileRow,
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  githubStates: Readonly<Record<string, PrFileViewedState>> | null | undefined = null,
  coordinates: ReviewUnitCoordinates | undefined = undefined,
): CheckState {
  const githubState = githubStates != null && Object.hasOwn(githubStates, file.path)
    ? githubStates[file.path]
    : undefined;
  if (file.units.length > 0) {
    const state = unitsViewState(file.units, unitTicks, githubState, coordinates);
    if (state === "done" || githubStates != null) return state;
    // The file-atomic release persisted whole-file ticks. Keep a current positive tick as an
    // all-units baseline and a changed positive tick visibly stale until migration can expand it.
    // A negative sync intent does not erase finer partial unit progress.
    const tick = tickForFile(file, fileTicks);
    if (tick === undefined || tick.viewed === false) return state;
    return tick.fingerprint === file.fingerprint ? "done" : "stale";
  }
  if (githubStates != null) {
    if (githubState === "VIEWED") return "done";
    if (githubState === "DISMISSED") return "stale";
    return "todo";
  }
  // File ticks are already keyed by an exact path (or reconciled through one unique rename
  // address), so unmatched files without worker semantic addresses remain safely reviewable.
  const tick = tickForFile(file, fileTicks);
  if (tick === undefined) return "todo";
  if (tick.viewed === false) return "todo";
  return tick.fingerprint === file.fingerprint ? "done" : "stale";
}

/** One changed leaf. GitHub VIEWED supplies an all-units baseline; otherwise its own tick wins. */
export function unitViewState(
  unit: ReviewUnitRow,
  unitTicks: Record<string, ReviewTick>,
  githubState: PrFileViewedState | undefined = undefined,
  coordinates: ReviewUnitCoordinates | undefined = undefined,
): CheckState {
  if (githubState === "VIEWED") {
    return "done";
  }
  const tick = tickForUnit(unit, unitTicks);
  const coordinateBound = tick !== undefined && (
    tick.viewerId !== undefined
    || tick.viewerLogin !== undefined
    || tick.headSha !== undefined
  );
  const viewerCoordinatesMatch = tick !== undefined
    && tick.viewerId !== undefined
    && tick.viewerLogin !== undefined
    && tick.headSha !== undefined
    && sameReviewHead(tick.headSha, coordinates?.headSha)
    && (coordinates?.viewerId == null || tick.viewerId === coordinates.viewerId);
  const localHeadCoordinatesMatch = tick !== undefined
    && tick.viewerId === undefined
    && tick.viewerLogin === undefined
    && tick.headSha !== undefined
    && coordinates?.viewerId == null
    && sameReviewHead(tick.headSha, coordinates?.headSha);
  const coordinatesMatch = viewerCoordinatesMatch || localHeadCoordinatesMatch;
  let state = coordinateBound && !coordinatesMatch
    ? "stale" as const
    : checkStateOf(unit.fingerprint, tick, unit.address);
  if (
    unit.address === null
    && tick !== undefined
    && tick.fingerprint === unit.fingerprint
    && coordinatesMatch
  ) {
    // A live PR supplies an immutable head coordinate even when the extractor could not prove a
    // semantic address. Authenticated progress also binds to its viewer; explicit signed-out
    // progress remains valid only while no viewer is active and the exact head still matches.
    state = "done";
  }
  return githubState === "DISMISSED" && state !== "done" ? "stale" : state;
}

/** Aggregate changed leaves beneath a structural unit (for example, methods inside a class). */
export function unitsViewState(
  units: readonly ReviewUnitRow[],
  unitTicks: Record<string, ReviewTick>,
  githubState: PrFileViewedState | undefined = undefined,
  coordinates: ReviewUnitCoordinates | undefined = undefined,
): CheckState {
  const states = units.map((unit) => unitViewState(unit, unitTicks, githubState, coordinates));
  if (states.some((state) => state === "stale")) {
    return "stale";
  }
  return states.length > 0 && states.every((state) => state === "done") ? "done" : "todo";
}

function sameReviewHead(left: string, right: string | null | undefined): boolean {
  return right != null && left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Bridge persisted progress across the file-atomic release. A valid whole-file tick expands back
 * into exact unit ticks, while a fully viewed unit set also retains a whole-file intent for GitHub
 * synchronization. Partial/stale and currently filtered-out unit progress is never discarded.
 */
export function promoteFullyViewedUnitTicks(
  files: readonly ReviewFileRow[],
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
): { unitTicks: Record<string, ReviewTick>; fileTicks: Record<string, ReviewTick> } {
  const nextUnits = { ...unitTicks };
  const nextFiles = { ...fileTicks };
  for (const file of files) {
    const existingFileTick = tickForFile(file, fileTicks);
    if (
      file.units.length > 0
      && existingFileTick !== undefined
      && existingFileTick.viewed !== false
      && existingFileTick.fingerprint === file.fingerprint
    ) {
      for (const unit of file.units) {
        removeUnitTick(nextUnits, unit);
        setReviewTick(nextUnits, unit.nodeId, {
          at: existingFileTick.at,
          fingerprint: unit.fingerprint,
          ...(unit.address ? { address: unit.address } : {}),
          ...reviewUnitProvenance(existingFileTick),
        });
      }
    }
    const resolved = file.units.map((unit) => tickForUnit(unit, nextUnits));
    const sharedProvenance = sharedReviewUnitProvenance(resolved);
    const coordinates = existingFileTick === undefined
      ? {
          viewerId: sharedProvenance.viewerId,
          headSha: sharedProvenance.headSha,
        }
      : { viewerId: existingFileTick.viewerId, headSha: existingFileTick.headSha };
    const fullyViewed = file.units.length > 0
      && file.units.every((unit) =>
        unitViewState(unit, nextUnits, undefined, coordinates) === "done");
    if (fullyViewed && existingFileTick?.viewed === false) {
      for (const unit of file.units) removeUnitTick(nextUnits, unit);
      continue;
    }
    if (
      fullyViewed
      && existingFileTick?.viewed !== false
      && existingFileTick?.fingerprint !== file.fingerprint
    ) {
      const latestAt = resolved.reduce(
        (latest, tick) => tick !== undefined && tick.at > latest ? tick.at : latest,
        "",
      );
      // A uniquely resolved old-path/stale tick must not suppress a complete current unit
      // migration. Replace it with the exact current file identity before dropping the units.
      removeFileTick(nextFiles, file);
      setReviewTick(nextFiles, file.path, {
        at: latestAt,
        fingerprint: file.fingerprint,
        ...(file.address ? { address: file.address } : {}),
        ...sharedProvenance,
      });
    }
  }
  return { unitTicks: nextUnits, fileTicks: nextFiles };
}

/** Remove one exact or uniquely address-matched local file tick after GitHub accepts it. */
export function removeReviewFileTick(
  ticks: Record<string, ReviewTick>,
  file: ReviewFileRow,
): Record<string, ReviewTick> {
  const next = { ...ticks };
  removeFileTick(next, file);
  return next;
}

/** Remove exact and uniquely address-matched ticks for the supplied review units. */
export function removeReviewUnitTicks(
  ticks: Record<string, ReviewTick>,
  units: readonly ReviewUnitRow[],
): Record<string, ReviewTick> {
  const next = { ...ticks };
  for (const unit of units) removeUnitTick(next, unit);
  return next;
}

/** Aggregate a set of changed files for folder-level progress. A stale descendant wins so a folder
 * can never retain a completed marker after one of its reviewed files changes. */
export function filesViewState(
  files: readonly ReviewFileRow[],
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  githubStates: Readonly<Record<string, PrFileViewedState>> | null | undefined = null,
  coordinates: ReviewUnitCoordinates | undefined = undefined,
): CheckState {
  const states = files.map((file) =>
    fileViewState(file, unitTicks, fileTicks, githubStates, coordinates));
  if (states.some((state) => state === "stale")) {
    return "stale";
  }
  return states.length > 0 && states.every((state) => state === "done") ? "done" : "todo";
}

/** How many changed files read as viewed. ONE definition keeps every progress summary aligned. */
export function countViewedFiles(
  files: readonly ReviewFileRow[],
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  githubStates: Readonly<Record<string, PrFileViewedState>> | null | undefined = null,
  coordinates: ReviewUnitCoordinates | undefined = undefined,
): number {
  return files.filter((file) =>
    fileViewState(file, unitTicks, fileTicks, githubStates, coordinates) === "done").length;
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
  setReviewTick(next, unit.nodeId, {
    at,
    fingerprint: unit.fingerprint,
    ...(unit.address ? { address: unit.address } : {}),
  });
  return next;
}

/** Toggle all directly changed leaves represented by one structural ancestor. */
export function applyUnitsToggle(
  units: readonly ReviewUnitRow[],
  ticks: Record<string, ReviewTick>,
  at: string,
): Record<string, ReviewTick> {
  const markViewed = unitsViewState(units, ticks) !== "done";
  return setReviewUnitsViewed(units, ticks, markViewed, at);
}

/** Set changed leaves explicitly, optionally binding the progress to one GitHub viewer and head. */
export function setReviewUnitsViewed(
  units: readonly ReviewUnitRow[],
  ticks: Record<string, ReviewTick>,
  viewed: boolean,
  at: string,
  provenance: ReviewUnitProvenance = {},
): Record<string, ReviewTick> {
  const next = { ...ticks };
  for (const unit of units) {
    if (viewed) {
      removeUnitTick(next, unit);
      setReviewTick(next, unit.nodeId, {
        at,
        fingerprint: unit.fingerprint,
        ...(unit.address ? { address: unit.address } : {}),
        ...provenance,
      });
    } else {
      removeUnitTick(next, unit);
    }
  }
  return next;
}

function reviewUnitProvenance(tick: ReviewTick): ReviewUnitProvenance {
  return {
    ...(tick.viewerId !== undefined ? { viewerId: tick.viewerId } : {}),
    ...(tick.viewerLogin !== undefined ? { viewerLogin: tick.viewerLogin } : {}),
    ...(tick.headSha !== undefined ? { headSha: tick.headSha } : {}),
  };
}

function sharedReviewUnitProvenance(
  ticks: readonly (ReviewTick | undefined)[],
): ReviewUnitProvenance {
  const first = ticks[0];
  if (
    first?.viewerId === undefined
    || first.viewerLogin === undefined
    || first.headSha === undefined
    || !ticks.every((tick) =>
      tick !== undefined
      && tick.viewerId === first.viewerId
      && tick.viewerLogin === first.viewerLogin
      && tick.headSha === first.headSha)
  ) {
    return {};
  }
  return {
    viewerId: first.viewerId,
    viewerLogin: first.viewerLogin,
    headSha: first.headSha,
  };
}

/** Toggle one file as a bulk gesture over every changed unit; unit-less files use a file tick. */
export function applyFileToggle(
  file: ReviewFileRow,
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  at: string,
  githubStates: Readonly<Record<string, PrFileViewedState>> | null | undefined = null,
  coordinates: ReviewUnitCoordinates | undefined = undefined,
): { unitTicks: Record<string, ReviewTick>; fileTicks: Record<string, ReviewTick> } {
  const state = fileViewState(file, unitTicks, fileTicks, githubStates, coordinates);
  const nextFiles = { ...fileTicks };
  const nextUnits = { ...unitTicks };
  if (file.units.length > 0) {
    removeFileTick(nextFiles, file);
    for (const unit of file.units) {
      removeUnitTick(nextUnits, unit);
      if (state !== "done") {
        setReviewTick(nextUnits, unit.nodeId, {
          at,
          fingerprint: unit.fingerprint,
          ...(unit.address ? { address: unit.address } : {}),
        });
      }
    }
    return { unitTicks: nextUnits, fileTicks: nextFiles };
  }
  removeFileTick(nextFiles, file);
  if (state !== "done") {
    setReviewTick(nextFiles, file.path, {
      at,
      fingerprint: file.fingerprint,
      ...(file.address ? { address: file.address } : {}),
    });
  }
  return { unitTicks: nextUnits, fileTicks: nextFiles };
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

/** Folder-level bulk toggle. A mixed folder completes unfinished/stale files; a done folder clears
 * every descendant file. Already-completed files stay untouched during the completing gesture. */
export function applyFilesToggle(
  files: readonly ReviewFileRow[],
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  at: string,
  githubStates: Readonly<Record<string, PrFileViewedState>> | null | undefined = null,
  coordinates: ReviewUnitCoordinates | undefined = undefined,
): { unitTicks: Record<string, ReviewTick>; fileTicks: Record<string, ReviewTick> } {
  const markViewed = filesViewState(files, unitTicks, fileTicks, githubStates, coordinates) !== "done";
  let nextUnitTicks = unitTicks;
  let nextFileTicks = fileTicks;
  for (const file of files) {
    const state = fileViewState(
      file,
      nextUnitTicks,
      nextFileTicks,
      githubStates,
      coordinates,
    );
    if ((markViewed && state === "done") || (!markViewed && state !== "done")) {
      continue;
    }
    const next = applyFileToggle(
      file,
      nextUnitTicks,
      nextFileTicks,
      at,
      githubStates,
      coordinates,
    );
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
  const identity = fingerprints !== null && Object.hasOwn(fingerprints, nodeId)
    ? fingerprints[nodeId]
    : undefined;
  const exactChanged = context.changedFiles.find((entry) => entry.path === file);
  const normalizedChanged = exactChanged === undefined
    ? context.changedFiles.filter(
        (entry) => normalizeReviewPath(entry.path) === normalizeReviewPath(file),
      )
    : [];
  // A literal backslash is a valid POSIX Git filename. Prefer exact identity, and only use the
  // historical slash-normalized join when it resolves to one unambiguous changed file.
  const changed = exactChanged ?? (normalizedChanged.length === 1 ? normalizedChanged[0] : undefined);
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
      ? semanticAddressAtPath(identity?.address, changed.previousPath)
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
