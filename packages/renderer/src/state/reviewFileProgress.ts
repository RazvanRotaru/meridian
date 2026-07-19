/**
 * Compact, graph-free PR review progress metadata.
 *
 * Exact unit rows belong only to the currently decoded review coordinate (or to an evictable
 * projection in the transport LRU). This catalog deliberately retains no exact unit inventory or
 * graph fingerprint after that coordinate leaves. Inactive files keep only their aggregate state
 * and ids which already own real user ticks, so untouched graph data cannot accumulate while a
 * reader navigates through a large pull request.
 */

import type { ReviewContext } from "@meridian/core";
import type { ReviewFileRow, ReviewUnitRow } from "../derive/reviewFiles";
import { checkStateOf, unitsViewState, type CheckState } from "../derive/reviewFiles";
import type { ReviewTick } from "./reviewTicksPref";

export interface ReviewProgressUnit {
  nodeId: string;
  fingerprint: string;
}

export interface ReviewProgressFile {
  path: string;
  /** Stable for one review revision; retained when a later coordinate carries less diff detail. */
  fingerprint: string;
  /** Last authoritative or explicit user state; no exact unit inventory is retained here. */
  state: CheckState;
  /** Projection filter under which `state` was authoritative; null means graph-unloaded. */
  includeTests: boolean | null;
  /** Only ids with persisted user progress. Untouched exact-unit ids are never retained. */
  tickedUnitIds: readonly string[];
}

export interface ReviewProgressCatalog {
  reviewKey: string;
  revisionKey: string;
  /** Canonical changed-file order, independent of the current graph/scope coordinate. */
  order: readonly string[];
  byPath: ReadonlyMap<string, ReviewProgressFile>;
}

export interface ReviewProgressReconciliation {
  catalog: ReviewProgressCatalog;
  unitTicks: Record<string, ReviewTick>;
  fileTicks: Record<string, ReviewTick>;
  ticksChanged: boolean;
}

export interface ReviewProgressToggle {
  catalog: ReviewProgressCatalog;
  unitTicks: Record<string, ReviewTick>;
  fileTicks: Record<string, ReviewTick>;
}

export function reconcileReviewProgress(input: {
  previous: ReviewProgressCatalog | null;
  reviewKey: string;
  revisionKey: string;
  changedFiles: ReviewContext["changedFiles"];
  /** Complete current-revision rows. Prepared reviews pass only the exact selected file. */
  authoritativeFiles?: readonly ReviewFileRow[];
  includeTests: boolean;
  unitTicks: Record<string, ReviewTick>;
  fileTicks: Record<string, ReviewTick>;
}): ReviewProgressReconciliation {
  const sameRevision = input.previous?.reviewKey === input.reviewKey
    && input.previous.revisionKey === input.revisionKey;
  const previousByPath = sameRevision && input.previous !== null
    ? input.previous.byPath
    : new Map<string, ReviewProgressFile>();
  const byPath = new Map<string, ReviewProgressFile>();
  const order: string[] = [];
  for (const changed of input.changedFiles) {
    const path = changed.path;
    if (byPath.has(path)) continue;
    order.push(path);
    const fingerprint = changedFileFingerprint(changed.hunks);
    const retained = previousByPath.get(path);
    byPath.set(path, retained ?? {
      path,
      fingerprint,
      state: checkStateOf(fingerprint, input.fileTicks[path]),
      includeTests: null,
      tickedUnitIds: [],
    });
  }

  let unitTicks = input.unitTicks;
  let fileTicks = input.fileTicks;
  let ticksChanged = false;
  for (const file of input.authoritativeFiles ?? []) {
    const prior = byPath.get(file.path);
    if (prior === undefined) continue;
    const units = file.units.map(progressUnit);
    const fileTick = fileTicks[file.path];
    const explicit = checkStateOf(prior.fingerprint, fileTick);
    if (units.length > 0 && explicit === "done") {
      // A mark made while the exact graph was absent becomes real per-unit user progress when the
      // file is reloaded. The compact file tick then leaves so future fingerprints can go stale.
      if (unitTicks === input.unitTicks) unitTicks = { ...unitTicks };
      for (const unit of units) {
        unitTicks[unit.nodeId] = { at: fileTick!.at, fingerprint: unit.fingerprint };
      }
      if (fileTicks === input.fileTicks) fileTicks = { ...fileTicks };
      delete fileTicks[file.path];
      ticksChanged = true;
    }

    const state = explicit === "stale"
      ? "stale"
      : units.length === 0
        ? explicit
        : unitsViewState(units, unitTicks);
    byPath.set(file.path, {
      ...prior,
      state,
      includeTests: input.includeTests,
      // Filtered absence is never deletion. Preserve prior user-owned ids and add newly visible
      // tick owners; toggling Tests back on must be able to recover the same progress.
      tickedUnitIds: [...new Set([
        ...prior.tickedUnitIds.filter((id) => unitTicks[id] !== undefined),
        ...units.filter((unit) => unitTicks[unit.nodeId] !== undefined).map((unit) => unit.nodeId),
      ])],
    });
  }

  return {
    catalog: { reviewKey: input.reviewKey, revisionKey: input.revisionKey, order, byPath },
    unitTicks,
    fileTicks,
    ticksChanged,
  };
}

export function progressUnit(unit: Pick<ReviewUnitRow, "nodeId" | "fingerprint">): ReviewProgressUnit {
  return { nodeId: unit.nodeId, fingerprint: unit.fingerprint };
}

/** Existing hunk-based semantics: richer later coordinates must not mutate this within a revision. */
export function changedFileFingerprint(hunks: ReviewContext["changedFiles"][number]["hunks"]): string {
  if (!hunks || hunks.length === 0) return "whole-file";
  return hunks.map((hunk) => `${hunk.start}-${hunk.end}`).join(",");
}

export function reviewFileProgressState(
  file: ReviewProgressFile,
  _unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  includeTests: boolean,
): CheckState {
  if (file.includeTests !== null && file.includeTests !== includeTests) return "todo";
  const explicit = checkStateOf(file.fingerprint, fileTicks[file.path]);
  return explicit === "todo" ? file.state : explicit;
}

export function reviewFilesProgressState(
  files: readonly ReviewProgressFile[],
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  includeTests: boolean,
): CheckState {
  const states = files.map((file) => reviewFileProgressState(file, unitTicks, fileTicks, includeTests));
  if (states.some((state) => state === "stale")) return "stale";
  return states.length > 0 && states.every((state) => state === "done") ? "done" : "todo";
}

export function countViewedReviewFiles(
  catalog: ReviewProgressCatalog | null,
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  includeTests: boolean,
): number {
  if (catalog === null) return 0;
  let viewed = 0;
  for (const path of catalog.order) {
    const file = catalog.byPath.get(path);
    if (file && reviewFileProgressState(file, unitTicks, fileTicks, includeTests) === "done") viewed += 1;
  }
  return viewed;
}

export function applyReviewFileToggle(
  catalog: ReviewProgressCatalog,
  file: ReviewProgressFile,
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  at: string,
  includeTests: boolean,
  authoritativeUnits: readonly ReviewProgressUnit[] | null = null,
): ReviewProgressToggle {
  const state = reviewFileProgressState(file, unitTicks, fileTicks, includeTests);
  const nextUnits = { ...unitTicks };
  const nextFiles = { ...fileTicks };
  for (const id of file.tickedUnitIds) delete nextUnits[id];
  for (const unit of authoritativeUnits ?? []) delete nextUnits[unit.nodeId];

  let nextFile: ReviewProgressFile;
  if (state === "done") {
    delete nextFiles[file.path];
    nextFile = { ...file, state: "todo", includeTests, tickedUnitIds: [] };
  } else if (authoritativeUnits !== null && authoritativeUnits.length > 0) {
    delete nextFiles[file.path];
    for (const unit of authoritativeUnits) {
      nextUnits[unit.nodeId] = { at, fingerprint: unit.fingerprint };
    }
    nextFile = {
      ...file,
      state: "done",
      includeTests,
      tickedUnitIds: authoritativeUnits.map((unit) => unit.nodeId),
    };
  } else {
    nextFiles[file.path] = { at, fingerprint: file.fingerprint };
    nextFile = { ...file, state: "done", includeTests, tickedUnitIds: [] };
  }
  return {
    catalog: replaceProgressFiles(catalog, [nextFile]),
    unitTicks: nextUnits,
    fileTicks: nextFiles,
  };
}

export function applyReviewFilesToggle(
  catalog: ReviewProgressCatalog,
  files: readonly ReviewProgressFile[],
  unitTicks: Record<string, ReviewTick>,
  fileTicks: Record<string, ReviewTick>,
  at: string,
  includeTests: boolean,
  authoritativeUnits: ReadonlyMap<string, readonly ReviewProgressUnit[]> = new Map(),
): ReviewProgressToggle {
  const markViewed = reviewFilesProgressState(files, unitTicks, fileTicks, includeTests) !== "done";
  let nextCatalog = catalog;
  let nextUnitTicks = unitTicks;
  let nextFileTicks = fileTicks;
  for (const original of files) {
    const file = nextCatalog.byPath.get(original.path) ?? original;
    const state = reviewFileProgressState(file, nextUnitTicks, nextFileTicks, includeTests);
    if ((markViewed && state === "done") || (!markViewed && state !== "done")) continue;
    const next = applyReviewFileToggle(
      nextCatalog,
      file,
      nextUnitTicks,
      nextFileTicks,
      at,
      includeTests,
      authoritativeUnits.get(file.path) ?? null,
    );
    nextCatalog = next.catalog;
    nextUnitTicks = next.unitTicks;
    nextFileTicks = next.fileTicks;
  }
  return { catalog: nextCatalog, unitTicks: nextUnitTicks, fileTicks: nextFileTicks };
}

export function progressFilesForPaths(
  catalog: ReviewProgressCatalog | null,
  paths: readonly string[],
): ReviewProgressFile[] {
  if (catalog === null) return [];
  const unique = new Set(paths);
  return catalog.order.flatMap((path) => {
    const file = unique.has(path) ? catalog.byPath.get(path) : undefined;
    return file === undefined ? [] : [file];
  });
}

export function resetReviewProgressCatalog(
  catalog: ReviewProgressCatalog | null,
): ReviewProgressCatalog | null {
  if (catalog === null) return null;
  return {
    ...catalog,
    byPath: new Map([...catalog.byPath].map(([path, file]) => [
      path,
      { ...file, state: "todo" as const, includeTests: null, tickedUnitIds: [] },
    ])),
  };
}

function replaceProgressFiles(
  catalog: ReviewProgressCatalog,
  files: readonly ReviewProgressFile[],
): ReviewProgressCatalog {
  const byPath = new Map(catalog.byPath);
  for (const file of files) byPath.set(file.path, file);
  return { ...catalog, byPath };
}
