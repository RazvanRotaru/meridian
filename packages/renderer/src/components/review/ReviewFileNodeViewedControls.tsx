/**
 * Viewed-state chrome rendered inside Map nodes. Because it sits beneath React Flow's node
 * transform, the outline and attached check scale with the graph instead of becoming a fixed-size
 * screen overlay. Unit controls toggle only that declaration; file and folder controls are
 * aggregate bulk actions and retain the existing cascade semantics.
 */

import { CheckIcon, CircleIcon, ReloadIcon } from "@radix-ui/react-icons";
import type { ReactNode } from "react";
import {
  checkStateOf,
  filesViewState,
  fileViewState,
  unitsViewState,
  type CheckState,
  type ReviewFileRow,
  type ReviewUnitRow,
} from "../../derive/reviewFiles";
import type { GraphIndex } from "../../graph/graphIndex";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { useSurfaceReviewProgressEnabled } from "../canvas/SurfaceInteractionContext";
import { REVIEW_VIEWED_ACCENT, REVIEW_VIEWED_STALE } from "./reviewPanelKit";

export type ReviewViewedScope = "folder" | "file" | "unit";

interface FolderTarget {
  kind: "folder";
  label: string;
  files: readonly ReviewFileRow[];
}

interface FileTarget {
  kind: "file";
  file: ReviewFileRow;
}

interface UnitTarget {
  kind: "unit";
  file: ReviewFileRow;
  unit: ReviewUnitRow;
}

interface UnitGroupTarget {
  kind: "unit-group";
  label: string;
  units: readonly ReviewUnitRow[];
}

type ReviewViewedTarget = FolderTarget | FileTarget | UnitTarget | UnitGroupTarget;

interface CachedFolderTarget {
  memberIds: readonly string[] | undefined;
  label: string;
  target: FolderTarget | null;
}

interface ReviewTargetIndex {
  graphIndex: GraphIndex;
  filesByModuleId: ReadonlyMap<string, FileTarget>;
  unitsByNodeId: ReadonlyMap<string, UnitTarget>;
  unitGroupsByNodeId: ReadonlyMap<string, UnitGroupTarget>;
  foldersByNodeId: Map<string, CachedFolderTarget>;
}

const TARGET_INDEX_CACHE = new WeakMap<readonly ReviewFileRow[], ReviewTargetIndex>();

/** Wrap one graph node in the selected outlined-row treatment when it belongs to the active review. */
export function ReviewNodeViewedChrome({
  nodeId,
  scope,
  borderRadius,
  children,
}: {
  nodeId: string;
  scope: ReviewViewedScope;
  borderRadius: number;
  children: ReactNode;
}) {
  const enabled = useSurfaceReviewProgressEnabled();
  if (!enabled) {
    return children;
  }
  return (
    <EnabledReviewNodeViewedChrome nodeId={nodeId} scope={scope} borderRadius={borderRadius}>
      {children}
    </EnabledReviewNodeViewedChrome>
  );
}

function EnabledReviewNodeViewedChrome({
  nodeId,
  scope,
  borderRadius,
  children,
}: {
  nodeId: string;
  scope: ReviewViewedScope;
  borderRadius: number;
  children: ReactNode;
}) {
  const target = useBlueprint((state) => targetFor(
    state.reviewFiles,
    scope,
    nodeId,
    state.minimalRollups[nodeId],
    state.index.nodesById.get(nodeId)?.displayName ?? nodeId,
    state.index,
  ));
  const state = useBlueprint((blueprint) => viewStateFor(target, blueprint.reviewUnitTicks, blueprint.reviewFileTicks));
  const { toggleReviewFilesViewed, toggleReviewFileViewed, toggleReviewUnitTick, toggleReviewUnitsViewed } = useBlueprintActions();
  if (target === null || state === null) {
    return children;
  }
  const label = viewedLabel(target, state);
  const color = stateColor(state);
  return (
    <div
      className="review-node-viewed-shell"
      data-review-node-id={nodeId}
      data-review-viewed-scope={scope}
      data-review-view-state={state}
      style={SHELL}
    >
      {children}
      {state === "todo" ? null : (
        <div
          aria-hidden="true"
          className="review-node-viewed-outline"
          style={outlineStyle(color, borderRadius, state)}
        />
      )}
      <div
        className="review-node-viewed-indicator"
        style={indicatorStyle(color, state)}
      >
        <ViewedIcon state={state} />
        <ReviewViewedButton
          nodeId={nodeId}
          scope={scope}
          state={state}
          label={label}
          onToggle={() => {
            if (target.kind === "folder") {
              toggleReviewFilesViewed(target.files.map((file) => file.path));
            } else if (target.kind === "file") {
              toggleReviewFileViewed(target.file.path);
            } else if (target.kind === "unit-group") {
              toggleReviewUnitsViewed(target.units.map((unit) => unit.nodeId));
            } else {
              toggleReviewUnitTick(target.unit.nodeId);
            }
          }}
        />
      </div>
    </div>
  );
}

/** Transparent semantic hit target layered over the icon, kept pure for gesture-contract tests. */
export function ReviewViewedButton({
  nodeId,
  scope,
  state,
  label,
  onToggle,
}: {
  nodeId: string;
  scope: ReviewViewedScope;
  state: CheckState;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="review-node-viewed-button nodrag nopan"
      title={label}
      aria-label={label}
      aria-pressed={state === "done"}
      data-review-node-id={nodeId}
      data-review-viewed-scope={scope}
      data-review-view-state={state}
      style={BUTTON_HIT_TARGET}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

function ViewedIcon({ state }: { state: CheckState }) {
  if (state === "done") {
    return <CheckIcon width={13} height={13} aria-hidden="true" />;
  }
  if (state === "stale") {
    return <ReloadIcon width={11} height={11} aria-hidden="true" />;
  }
  return <CircleIcon width={10} height={10} aria-hidden="true" />;
}

function targetFor(
  files: readonly ReviewFileRow[],
  scope: ReviewViewedScope,
  nodeId: string,
  folderMemberIds: readonly string[] | undefined,
  folderLabel: string,
  graphIndex: GraphIndex,
): ReviewViewedTarget | null {
  const index = reviewTargetIndex(files, graphIndex);
  if (scope === "file") {
    return index.filesByModuleId.get(nodeId) ?? null;
  }
  if (scope === "unit") {
    return index.unitGroupsByNodeId.get(nodeId) ?? index.unitsByNodeId.get(nodeId) ?? null;
  }
  return folderTarget(index, nodeId, folderMemberIds, folderLabel);
}

/** A review folder is the exact large-review rollup, not every source file in its displayed
 * subtree. That keeps the marker scoped to the changed files represented by this graph node. */
function folderTarget(
  index: ReviewTargetIndex,
  nodeId: string,
  memberIds: readonly string[] | undefined,
  label: string,
): FolderTarget | null {
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
  const filesByModuleId = new Map<string, FileTarget>();
  const unitsByNodeId = new Map<string, UnitTarget>();
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
    return [nodeId, {
      kind: "unit-group" as const,
      label: graphIndex.nodesById.get(nodeId)?.displayName ?? nodeId,
      units: ownUnit === undefined ? descendants : [ownUnit, ...descendants],
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

function viewStateFor(
  target: ReviewViewedTarget | null,
  unitTicks: Parameters<typeof fileViewState>[1],
  fileTicks: Parameters<typeof fileViewState>[2],
): CheckState | null {
  if (target === null) {
    return null;
  }
  if (target.kind === "folder") {
    return filesViewState(target.files, unitTicks, fileTicks);
  }
  if (target.kind === "unit-group") {
    return unitsViewState(target.units, unitTicks);
  }
  return target.kind === "file"
    ? fileViewState(target.file, unitTicks, fileTicks)
    : checkStateOf(target.unit.fingerprint, unitTicks[target.unit.nodeId]);
}

function viewedLabel(target: ReviewViewedTarget, state: CheckState): string {
  const subject = target.kind === "folder"
    ? `${target.label} folder`
    : target.kind === "file" ? target.file.path
      : target.kind === "unit-group" ? target.label : target.unit.displayName;
  if (state === "done") {
    return `Viewed ${subject} — click to unmark`;
  }
  if (state === "stale") {
    return `${subject} changed since viewed — click to mark again`;
  }
  return `Mark ${subject} as viewed`;
}

function stateColor(state: CheckState): string {
  return state === "done" ? REVIEW_VIEWED_ACCENT : state === "stale" ? REVIEW_VIEWED_STALE : "#8B95A5";
}

function outlineStyle(color: string, borderRadius: number, state: CheckState): React.CSSProperties {
  return {
    position: "absolute",
    inset: 2,
    zIndex: 2,
    boxSizing: "border-box",
    border: `2px ${state === "stale" ? "dashed" : "solid"} ${color}`,
    borderRadius: Math.max(0, borderRadius - 2),
    // Area encoding remains visible at overview zoom after the graph-scaled outline/check become
    // sub-pixel. The low alpha lets green/amber/red PR status remain the stronger outer signal.
    backgroundColor: `${color}${state === "stale" ? "12" : "1A"}`,
    pointerEvents: "none",
  };
}

function indicatorStyle(color: string, state: CheckState): React.CSSProperties {
  return {
    position: "absolute",
    // Sit outside the card's action row: the attached check must not steal source/expand clicks.
    top: -10,
    right: -10,
    zIndex: 3,
    width: 18,
    height: 18,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    border: `1.5px ${state === "stale" ? "dashed" : "solid"} ${color}`,
    borderRadius: 999,
    background: "#171D26",
    color,
    boxShadow: "0 2px 6px rgba(0,0,0,0.42)",
  };
}

const SHELL: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "visible",
};

const BUTTON_HIT_TARGET: React.CSSProperties = {
  position: "absolute",
  inset: -1,
  boxSizing: "border-box",
  border: "none",
  borderRadius: 999,
  padding: 0,
  background: "transparent",
  cursor: "pointer",
};

/** One stylesheet for hover/focus emphasis; every state remains discoverable and interactive. */
export const REVIEW_NODE_VIEWED_CSS = `
.review-node-viewed-indicator {
  opacity: 1;
  transition: opacity 120ms ease, border-color 120ms ease, color 120ms ease;
}
.review-node-viewed-shell[data-review-view-state="todo"] .review-node-viewed-indicator {
  opacity: 0.28;
}
.review-node-viewed-shell[data-review-view-state="todo"]:hover .review-node-viewed-indicator,
.review-node-viewed-shell[data-review-view-state="todo"]:focus-within .review-node-viewed-indicator {
  opacity: 0.9;
}
.review-node-viewed-button:focus-visible {
  outline: 2px solid #DCE6F2;
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .review-node-viewed-indicator {
    transition: none !important;
  }
}
`;
