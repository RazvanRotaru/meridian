/**
 * Viewed-state chrome rendered inside Map nodes. Because it sits beneath React Flow's node
 * transform, the outline and attached check scale with the graph instead of becoming a fixed-size
 * screen overlay. Declaration controls retain per-node progress; structural controls aggregate all
 * represented descendants, while file/folder completion synchronizes GitHub's atomic checkbox.
 */

import { CheckIcon, CircleIcon, ReloadIcon } from "@radix-ui/react-icons";
import { useMemo, type ReactNode } from "react";
import type { CheckState } from "../../derive/reviewFiles";
import {
  reviewViewedTargetFor,
  reviewViewedTargetScope,
  reviewViewedTargetState,
  type ReviewViewedScope,
  type ReviewViewedTarget,
  type ReviewViewedTargetScope,
} from "../../derive/reviewNodeViewed";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { reviewViewedGestureBlockReason } from "../../state/store";
import { useSurfaceReviewProgressEnabled } from "../canvas/SurfaceInteractionContext";
import { REVIEW_VIEWED_ACCENT, REVIEW_VIEWED_STALE } from "./reviewPanelKit";

export type { ReviewViewedScope } from "../../derive/reviewNodeViewed";

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
  const control = useReviewViewedControl(nodeId, scope);
  if (control === null) {
    return children;
  }
  const { color, state } = control;
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
        data-review-view-state={state}
        style={indicatorStyle(color, state)}
      >
        <ViewedIcon state={state} />
        <ReviewViewedButton
          nodeId={nodeId}
          scope={scope}
          state={state}
          label={control.label}
          onToggle={control.onToggle}
          blocked={control.blocked}
        />
      </div>
    </div>
  );
}

/** The preview counterpart of the node-attached control. `source` resolution deliberately checks
 * the review index instead of guessing from an open-vocabulary graph kind, so module aliases and
 * grouped declaration nodes retain the exact same aggregate semantics as their Map nodes. */
export function ReviewPreviewViewedControl({
  nodeId,
}: {
  nodeId: string;
}) {
  const control = useReviewViewedControl(nodeId, "source");
  if (control === null) {
    return null;
  }
  return (
    <>
      {control.state === "todo" ? null : (
        <div
          aria-hidden="true"
          className="review-node-viewed-outline"
          style={outlineStyle(control.color, 10, control.state)}
        />
      )}
      <div
        className="review-node-viewed-indicator"
        data-review-view-state={control.state}
        style={indicatorStyle(control.color, control.state)}
      >
        <ViewedIcon state={control.state} />
        <ReviewViewedButton
          nodeId={nodeId}
          scope={control.scope}
          state={control.state}
          label={control.label}
          onToggle={control.onToggle}
          blocked={control.blocked}
        />
      </div>
    </>
  );
}

/** Header-sized counterpart of the node-attached viewed control. Prefer the exact source node so
 * declarations and containers retain the Map's unit semantics; fall back to the review path only
 * for unmatched or synthetic whole-file source surfaces. */
export function ReviewSourceViewedControl({
  nodeId,
  fallbackPath,
  compact = false,
}: {
  nodeId: string;
  fallbackPath?: string;
  compact?: boolean;
}) {
  const nodeControl = useReviewViewedControl(nodeId, "source");
  const fileControl = useReviewFileViewedControl(fallbackPath);
  const control = nodeControl ?? fileControl;
  if (control === null) {
    return null;
  }
  return (
    <button
      type="button"
      className="review-source-viewed-button"
      title={control.label}
      aria-label={control.label}
      aria-pressed={control.state === "done"}
      disabled={control.blocked}
      data-review-source-viewed="true"
      data-review-source-viewed-compact={compact || undefined}
      data-review-source-viewed-fallback={nodeControl === null || undefined}
      data-review-node-id={nodeId}
      data-review-viewed-scope={control.scope}
      data-review-view-state={control.state}
      style={{
        ...SOURCE_VIEWED_BUTTON,
        ...(compact ? SOURCE_VIEWED_BUTTON_COMPACT : {}),
        color: control.color,
        ...(control.blocked ? SOURCE_VIEWED_BUTTON_BLOCKED : {}),
      }}
      onClick={control.onToggle}
    >
      <ViewedIcon state={control.state} />
      <span style={compact ? VISUALLY_HIDDEN_TEXT : undefined}>{sourceViewedText(control.state)}</span>
    </button>
  );
}

/** Transparent semantic hit target layered over the icon, kept pure for gesture-contract tests. */
export function ReviewViewedButton({
  nodeId,
  scope,
  state,
  label,
  onToggle,
  blocked = false,
}: {
  nodeId: string;
  scope: ReviewViewedScope;
  state: CheckState;
  label: string;
  onToggle: () => void;
  blocked?: boolean;
}) {
  return (
    <button
      type="button"
      className="review-node-viewed-button nodrag nopan"
      title={label}
      aria-label={label}
      aria-pressed={state === "done"}
      disabled={blocked}
      data-review-node-id={nodeId}
      data-review-viewed-scope={scope}
      data-review-view-state={state}
      style={{ ...BUTTON_HIT_TARGET, ...(blocked ? BLOCKED_HIT_TARGET : {}) }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

interface ReviewViewedControl {
  blocked: boolean;
  color: string;
  label: string;
  onToggle: () => void;
  scope: ReviewViewedScope;
  state: CheckState;
}

function useReviewViewedControl(nodeId: string, scope: ReviewViewedTargetScope): ReviewViewedControl | null {
  const target = useBlueprint((state) => reviewViewedTargetFor(
    state.reviewFiles,
    scope,
    nodeId,
    state.minimalRollups[nodeId],
    state.index.nodesById.get(nodeId)?.displayName ?? nodeId,
    state.index,
  ));
  return useReviewViewedTargetControl(target);
}

function useReviewFileViewedControl(path: string | undefined): ReviewViewedControl | null {
  const file = useBlueprint((state) => path === undefined
    ? undefined
    : state.reviewFiles.find((candidate) => candidate.path === path));
  const target = useMemo<ReviewViewedTarget | null>(
    () => file === undefined ? null : { kind: "file", file },
    [file],
  );
  return useReviewViewedTargetControl(target);
}

function useReviewViewedTargetControl(target: ReviewViewedTarget | null): ReviewViewedControl | null {
  const state = useBlueprint((blueprint) => reviewViewedTargetState(
    target,
    blueprint.reviewUnitTicks,
    blueprint.reviewFileTicks,
    blueprint.reviewFileViewedStates,
    {
      viewerId: blueprint.reviewViewedFilesViewerId,
      headSha: blueprint.prReviewRevision?.headSha,
    },
  ));
  const blockedReason = useBlueprint(reviewViewedGestureBlockReason);
  const {
    toggleReviewFilesViewed,
    toggleReviewFileViewed,
    toggleReviewUnitTick,
    toggleReviewUnitsViewed,
  } = useBlueprintActions();
  if (target === null || state === null) {
    return null;
  }
  return {
    blocked: blockedReason !== null,
    color: stateColor(state),
    label: blockedReason ?? viewedLabel(target, state),
    scope: reviewViewedTargetScope(target),
    state,
    onToggle: () => {
      if (target.kind === "folder") {
        toggleReviewFilesViewed(target.files.map((file) => file.path));
      } else if (target.kind === "file") {
        toggleReviewFileViewed(target.file.path);
      } else if (target.kind === "unit-group") {
        toggleReviewUnitsViewed(target.units.map(({ unit }) => unit.nodeId));
      } else {
        toggleReviewUnitTick(target.unit.nodeId);
      }
    },
  };
}

function sourceViewedText(state: CheckState): string {
  if (state === "done") return "Viewed";
  return state === "stale" ? "Mark again" : "Mark viewed";
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
const BLOCKED_HIT_TARGET: React.CSSProperties = { cursor: "wait" };
const SOURCE_VIEWED_BUTTON: React.CSSProperties = {
  minHeight: 28,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
  boxSizing: "border-box",
  border: "1px solid #3A4554",
  borderRadius: 6,
  padding: "4px 8px",
  background: "#1D2530",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1,
  whiteSpace: "nowrap",
  cursor: "pointer",
};
const SOURCE_VIEWED_BUTTON_BLOCKED: React.CSSProperties = {
  opacity: 0.62,
  cursor: "wait",
};
const SOURCE_VIEWED_BUTTON_COMPACT: React.CSSProperties = {
  width: 28,
  padding: 4,
  justifyContent: "center",
};
const VISUALLY_HIDDEN_TEXT: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
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
.review-node-viewed-indicator[data-review-view-state="todo"] {
  opacity: 0.28;
}
.review-node-viewed-shell[data-review-view-state="todo"]:hover .review-node-viewed-indicator,
.review-node-viewed-shell[data-review-view-state="todo"]:focus-within .review-node-viewed-indicator,
.review-node-diff-preview:hover .review-node-viewed-indicator[data-review-view-state="todo"],
.review-node-diff-preview:focus-within .review-node-viewed-indicator[data-review-view-state="todo"] {
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
