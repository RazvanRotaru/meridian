import {
  PR_REVIEW_PROGRESS_MODEL,
  prReviewProgressStatusText,
  type PrReviewProgressSnapshot,
  type PrReviewProgressStepState,
} from "@meridian/core";
import type { CSSProperties, ReactNode } from "react";

export interface PrReviewProgressViewProps {
  progress: PrReviewProgressSnapshot;
  variant?: "card" | "inline" | "boot";
  actions?: ReactNode;
  style?: CSSProperties;
}

/**
 * The one renderer presentation of canonical PR-review progress. Boot, the PR page, and compact
 * review controls share the same model, status formatter, independent revision states, and
 * terminal semantics.
 */
export function PrReviewProgressView({
  progress,
  variant = "card",
  actions,
  style,
}: PrReviewProgressViewProps) {
  const statusText = prReviewProgressStatusText(progress);
  const liveRole = progress.status === "error" ? "alert" : "status";
  const liveMode = progress.status === "error" ? "assertive" : "polite";
  const currentStep = progress.activeStage === null
    ? null
    : PR_REVIEW_PROGRESS_MODEL.stages[progress.activeStage].step;
  if (variant === "inline") {
    const reservedLines = 2;
    return (
      <div
        role={liveRole}
        aria-live={liveMode}
        aria-atomic="true"
        data-progress-model-version={PR_REVIEW_PROGRESS_MODEL.version}
        data-reserved-lines={reservedLines}
        data-state={progress.status}
        style={{
          ...INLINE_ROW,
          minHeight: STATUS_LINE_HEIGHT_PX * reservedLines,
          ...(progress.status === "running" ? { height: STATUS_LINE_HEIGHT_PX * reservedLines } : {}),
          ...style,
        }}
      >
        <span aria-hidden="true" style={stepDot(statusState(progress))} />
        <span
          title={progress.status === "running" ? statusText : undefined}
          style={{
            ...INLINE_LABEL,
            ...STATUS_TEXT,
            ...(progress.status === "running" ? runningStatusText(reservedLines) : {}),
          }}
        >
          <span style={SCREEN_READER_ONLY}>{PR_REVIEW_PROGRESS_MODEL.title}: </span>
          {statusText}
        </span>
      </div>
    );
  }

  const reservedLines = variant === "boot" ? 5 : 7;
  return (
    <section
      data-progress-model-version={PR_REVIEW_PROGRESS_MODEL.version}
      data-state={progress.status}
      style={{ ...(variant === "boot" ? BOOT : CARD), ...style }}
    >
      <div style={CARD_TITLE}>{PR_REVIEW_PROGRESS_MODEL.title}</div>
      <div
        role={liveRole}
        aria-live={liveMode}
        aria-atomic="true"
        data-reserved-lines={reservedLines}
        style={{
          ...STATUS,
          minHeight: STATUS_LINE_HEIGHT_PX * reservedLines,
          ...(progress.status === "running" ? { height: STATUS_LINE_HEIGHT_PX * reservedLines } : {}),
        }}
      >
        <span aria-hidden="true" style={stepDot(statusState(progress))} />
        <span
          title={progress.status === "running" ? statusText : undefined}
          style={{
            ...STATUS_TEXT,
            ...(progress.status === "running" ? runningStatusText(reservedLines) : {}),
          }}
        >
          {statusText}
        </span>
      </div>
      <ol aria-label="PR review preparation progress" style={STEP_LIST}>
        {PR_REVIEW_PROGRESS_MODEL.steps.map((entry) => {
          const state = progress.steps[entry.id];
          return (
            <li
              key={entry.id}
              data-step-id={entry.id}
              data-state={state}
              aria-current={state === "active" && entry.id === currentStep ? "step" : undefined}
              style={STEP_ROW}
            >
              <span aria-hidden="true" style={stepDot(state)} />
              <span style={STEP_CONTENT}>
                <span style={stepLabel(state)}>
                  {entry.label}
                  {stateBadge(state)}
                </span>
                {entry.id === "graphs" ? (
                  <ul aria-label="Exact revision graphs" data-reserved-rows="2" style={REVISION_LIST}>
                    {PR_REVIEW_PROGRESS_MODEL.revisions.map((revision) => {
                      const revisionState = progress.revisions[revision.id];
                      return (
                        <li
                          key={revision.id}
                          data-revision-id={revision.id}
                          data-state={revisionState}
                          style={REVISION_ROW}
                        >
                          <span aria-hidden="true" style={revisionDot(revisionState)} />
                          <span style={revisionLabel(revisionState)}>
                            {revision.label}
                            {stateBadge(revisionState)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      {actions}
    </section>
  );
}

function statusState(progress: PrReviewProgressSnapshot): PrReviewProgressStepState {
  if (progress.status === "success") return "done";
  if (progress.status === "error") return "error";
  if (progress.status === "canceled") return "canceled";
  return progress.status === "running" ? "active" : "pending";
}

function stateBadge(state: PrReviewProgressStepState): ReactNode {
  if (state !== "reused" && state !== "skipped" && state !== "error" && state !== "canceled") {
    return null;
  }
  const labels: Record<"reused" | "skipped" | "error" | "canceled", string> = {
    reused: "reused",
    skipped: "skipped",
    error: "failed",
    canceled: "canceled",
  };
  return <span style={STATE_BADGE}> · {labels[state]}</span>;
}

function stepDot(state: PrReviewProgressStepState): CSSProperties {
  const colors: Record<PrReviewProgressStepState, string> = {
    pending: "#2A2F37",
    active: "#388BFD",
    done: "#56C271",
    reused: "#2DD4BF",
    skipped: "#6E7681",
    error: "#F85149",
    canceled: "#8B949E",
  };
  return {
    width: 10,
    height: 10,
    borderRadius: 999,
    flexShrink: 0,
    background: colors[state],
    boxShadow: state === "active" ? "0 0 0 4px rgba(56,139,253,0.2)" : "none",
  };
}

function revisionDot(state: PrReviewProgressStepState): CSSProperties {
  return { ...stepDot(state), width: 7, height: 7 };
}

function stepLabel(state: PrReviewProgressStepState): CSSProperties {
  return {
    color: state === "pending" || state === "skipped" ? "#8B949E" : "#E6EDF3",
    fontSize: 13.5,
    fontWeight: state === "active" ? 650 : 500,
  };
}

function revisionLabel(state: PrReviewProgressStepState): CSSProperties {
  return {
    color: state === "pending" || state === "skipped" ? "#6E7681" : "#AAB4C0",
    fontSize: 11.5,
    fontWeight: state === "active" ? 650 : 500,
  };
}

function runningStatusText(lines: number): CSSProperties {
  return {
    display: "-webkit-box",
    maxHeight: STATUS_LINE_HEIGHT_PX * lines,
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: lines,
  };
}

const STATUS_LINE_HEIGHT_PX = 18;
const CARD: CSSProperties = {
  border: "1px solid #2A2F37",
  borderRadius: 10,
  background: "#0B0F14",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};
const BOOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
};
const CARD_TITLE: CSSProperties = { color: "#F0F6FC", fontSize: 13.5, fontWeight: 650 };
const STATUS: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  color: "#E6EDF3",
  fontSize: 12.5,
  lineHeight: `${STATUS_LINE_HEIGHT_PX}px`,
};
const STATUS_TEXT: CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };
const INLINE_ROW: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 8 };
const INLINE_LABEL: CSSProperties = {
  fontSize: 12,
  lineHeight: `${STATUS_LINE_HEIGHT_PX}px`,
  color: "#E6EDF3",
  fontWeight: 550,
};
const STEP_LIST: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};
const STEP_ROW: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 12 };
const STEP_CONTENT: CSSProperties = { minWidth: 0, display: "flex", flexDirection: "column", gap: 7 };
const REVISION_LIST: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  alignContent: "flex-start",
  gap: "6px 14px",
  minHeight: 32,
};
const REVISION_ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const STATE_BADGE: CSSProperties = { fontSize: "0.86em", fontWeight: 500, textTransform: "uppercase" };
const SCREEN_READER_ONLY: CSSProperties = {
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
