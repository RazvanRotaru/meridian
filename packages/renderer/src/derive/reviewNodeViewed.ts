/**
 * Resolve graph nodes to the exact review progress they represent. This is shared by the viewed
 * chrome and canvas actions so aggregate folders/classes can never disagree about completion.
 */

import type { GraphIndex } from "../graph/graphIndex";
import {
  filesViewState,
  fileViewState,
  unitViewState,
  type CheckState,
  type ReviewFileRow,
  type ReviewUnitCoordinates,
  type ReviewUnitRow,
} from "./reviewFiles";

export type ReviewViewedScope = "folder" | "file" | "unit";
export type ReviewViewedTargetScope = ReviewViewedScope | "source";

export interface ReviewGraphNodeProgress {
  viewed: number;
  total: number;
}

interface ReviewGraphNode {
  id: string;
  type?: string;
  hidden?: boolean;
}

export interface FolderReviewViewedTarget {
  kind: "folder";
  label: string;
  files: readonly ReviewFileRow[];
}

export interface FileReviewViewedTarget {
  kind: "file";
  file: ReviewFileRow;
}

export interface UnitReviewViewedTarget {
  kind: "unit";
  file: ReviewFileRow;
  unit: ReviewUnitRow;
}

export interface UnitGroupReviewViewedTarget {
  kind: "unit-group";
  label: string;
  units: readonly UnitReviewViewedTarget[];
}

export type ReviewViewedTarget =
  | FolderReviewViewedTarget
  | FileReviewViewedTarget
  | UnitReviewViewedTarget
  | UnitGroupReviewViewedTarget;

interface CachedFolderTarget {
  memberIds: readonly string[] | undefined;
  label: string;
  target: FolderReviewViewedTarget | null;
}

interface ReviewTargetIndex {
  graphIndex: GraphIndex;
  filesByModuleId: ReadonlyMap<string, FileReviewViewedTarget>;
  unitsByNodeId: ReadonlyMap<string, UnitReviewViewedTarget>;
  unitGroupsByNodeId: ReadonlyMap<string, UnitGroupReviewViewedTarget>;
  foldersByNodeId: Map<string, CachedFolderTarget>;
}

const TARGET_INDEX_CACHE = new WeakMap<readonly ReviewFileRow[], ReviewTargetIndex>();

export function reviewViewedTargetFor(
  files: readonly ReviewFileRow[],
  scope: ReviewViewedTargetScope,
  nodeId: string,
  folderMemberIds: readonly string[] | undefined,
  folderLabel: string,
  graphIndex: GraphIndex,
): ReviewViewedTarget | null {
  const index = reviewTargetIndex(files, graphIndex);
  if (scope === "source") {
    return index.filesByModuleId.get(nodeId)
      ?? index.unitGroupsByNodeId.get(nodeId)
      ?? index.unitsByNodeId.get(nodeId)
      ?? null;
  }
  if (scope === "file") {
    return index.filesByModuleId.get(nodeId) ?? null;
  }
  if (scope === "unit") {
    return index.unitGroupsByNodeId.get(nodeId) ?? index.unitsByNodeId.get(nodeId) ?? null;
  }
  return folderTarget(index, nodeId, folderMemberIds, folderLabel);
}

export function reviewViewedTargetState(
  target: ReviewViewedTarget | null,
  unitTicks: Parameters<typeof fileViewState>[1],
  fileTicks: Parameters<typeof fileViewState>[2],
  githubStates: Parameters<typeof fileViewState>[3],
  coordinates: ReviewUnitCoordinates,
): CheckState | null {
  if (target === null) {
    return null;
  }
  if (target.kind === "folder") {
    return filesViewState(target.files, unitTicks, fileTicks, githubStates, coordinates);
  }
  if (target.kind === "unit-group") {
    const states = target.units.map(({ file, unit }) => {
      const githubState = githubStates != null && Object.hasOwn(githubStates, file.path)
        ? githubStates[file.path]
        : undefined;
      return unitViewState(unit, unitTicks, githubState, coordinates);
    });
    if (states.some((state) => state === "stale")) return "stale";
    return states.length > 0 && states.every((state) => state === "done") ? "done" : "todo";
  }
  if (target.kind === "file") {
    return fileViewState(target.file, unitTicks, fileTicks, githubStates, coordinates);
  }
  const githubState = githubStates != null && Object.hasOwn(githubStates, target.file.path)
    ? githubStates[target.file.path]
    : undefined;
  return unitViewState(target.unit, unitTicks, githubState, coordinates);
}

/**
 * Count the reviewable cards in the current PR graph with the same target/state rules as their
 * node-attached viewed controls. The laid React Flow nodes are already the settings- and
 * scope-filtered graph frontier. Only node types that render viewed chrome participate: ghosts,
 * flow steps, service domains, and other structural presentation nodes are context rather than
 * review progress.
 */
export function reviewGraphNodeProgress(
  nodes: readonly ReviewGraphNode[],
  files: readonly ReviewFileRow[],
  folderMembersByNodeId: Readonly<Record<string, readonly string[]>>,
  graphIndex: GraphIndex,
  unitTicks: Parameters<typeof fileViewState>[1],
  fileTicks: Parameters<typeof fileViewState>[2],
  githubStates: Parameters<typeof fileViewState>[3],
  coordinates: ReviewUnitCoordinates,
): ReviewGraphNodeProgress {
  let viewed = 0;
  let total = 0;
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.hidden === true || seen.has(node.id)) {
      continue;
    }
    const scope = graphNodeViewedScope(node.type);
    if (scope === null) {
      continue;
    }
    seen.add(node.id);
    const folderMembers = scope === "folder" && Object.hasOwn(folderMembersByNodeId, node.id)
      ? folderMembersByNodeId[node.id]
      : undefined;
    const target = reviewViewedTargetFor(
      files,
      scope,
      node.id,
      folderMembers,
      graphIndex.nodesById.get(node.id)?.displayName ?? node.id,
      graphIndex,
    );
    const state = reviewViewedTargetState(
      target,
      unitTicks,
      fileTicks,
      githubStates,
      coordinates,
    );
    if (state === null) {
      continue;
    }
    total += 1;
    if (state === "done") {
      viewed += 1;
    }
  }
  return { viewed, total };
}

export function reviewViewedTargetScope(target: ReviewViewedTarget): ReviewViewedScope {
  if (target.kind === "folder") return "folder";
  return target.kind === "file" ? "file" : "unit";
}

function graphNodeViewedScope(type: string | undefined): ReviewViewedScope | null {
  if (type === "package") return "folder";
  if (type === "file") return "file";
  if (type === "unit" || type === "block") return "unit";
  return null;
}

function folderTarget(
  index: ReviewTargetIndex,
  nodeId: string,
  memberIds: readonly string[] | undefined,
  label: string,
): FolderReviewViewedTarget | null {
  const cached = index.foldersByNodeId.get(nodeId);
  if (cached !== undefined && cached.memberIds === memberIds && cached.label === label) {
    return cached.target;
  }
  const memberSet = new Set(memberIds ?? []);
  const files = [...index.filesByModuleId.entries()]
    .filter(([moduleId]) => memberSet.has(moduleId))
    .map(([, target]) => target.file);
  const target = files.length === 0 ? null : { kind: "folder" as const, label, files };
  index.foldersByNodeId.set(nodeId, { memberIds, label, target });
  return target;
}

function reviewTargetIndex(files: readonly ReviewFileRow[], graphIndex: GraphIndex): ReviewTargetIndex {
  const cached = TARGET_INDEX_CACHE.get(files);
  if (cached !== undefined && cached.graphIndex === graphIndex) {
    return cached;
  }
  const filesByModuleId = new Map<string, FileReviewViewedTarget>();
  const unitsByNodeId = new Map<string, UnitReviewViewedTarget>();
  const groupedUnits = new Map<string, ReviewUnitRow[]>();
  for (const file of files) {
    if (file.moduleId !== null) {
      filesByModuleId.set(file.moduleId, { kind: "file", file });
    }
    for (const unit of file.units) {
      unitsByNodeId.set(unit.nodeId, { kind: "unit", file, unit });
      for (const ancestor of graphIndex.ancestorsOf(unit.nodeId)) {
        if (ancestor.id === unit.nodeId || ancestor.kind === "module" || ancestor.kind === "package") {
          continue;
        }
        const group = groupedUnits.get(ancestor.id);
        group ? group.push(unit) : groupedUnits.set(ancestor.id, [unit]);
      }
    }
  }
  const unitGroupsByNodeId = new Map([...groupedUnits].map(([nodeId, descendants]) => {
    const ownUnit = unitsByNodeId.get(nodeId)?.unit;
    const units = ownUnit === undefined ? descendants : [ownUnit, ...descendants];
    return [nodeId, {
      kind: "unit-group" as const,
      label: graphIndex.nodesById.get(nodeId)?.displayName ?? nodeId,
      units: units.map((unit) => unitsByNodeId.get(unit.nodeId)!),
    }];
  }));
  const index = {
    graphIndex,
    filesByModuleId,
    unitsByNodeId,
    unitGroupsByNodeId,
    foldersByNodeId: new Map<string, CachedFolderTarget>(),
  };
  TARGET_INDEX_CACHE.set(files, index);
  return index;
}
