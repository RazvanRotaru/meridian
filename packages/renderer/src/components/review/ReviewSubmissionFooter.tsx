import { useState } from "react";
import { isReviewTestPath } from "../../derive/reviewFiles";
import type { PrReviewSubmissionEvent } from "../../state/prTypes";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { NO_FOCUS_RING } from "./reviewPanelKit";
import { preparedReviewTestVerdicts } from "../../state/preparedReviewProjection";

const SUMMARY_LIMIT = 10_000;

export function ReviewSubmissionFooter() {
  const count = useBlueprint((state) => {
    if (state.showTests) return state.reviewComments.length;
    const testVerdicts = preparedReviewTestVerdicts(
      state.prPreparedTestClassifications,
      state.prPreparedChangedFiles,
    );
    return state.reviewComments.filter((comment) => !isReviewTestPath(
        comment.path,
        state.index,
        state.prReviewComparison?.index ?? null,
        testVerdicts,
      )).length;
  });
  const live = useBlueprint((state) => state.prReviewed !== null);
  const status = useBlueprint((state) => state.reviewSubmitStatus);
  const stale = useBlueprint((state) => state.prReviewStale);
  const refreshing = useBlueprint((state) => state.prReviewRefreshing);
  const preparing = useBlueprint((state) => state.prReviewStatus === "preparing");
  const error = useBlueprint((state) => state.reviewSubmitError);
  const notice = useBlueprint((state) => state.reviewSubmitNotice);
  const submittedUrl = useBlueprint((state) => state.reviewSubmittedUrl);
  const { submitReview } = useBlueprintActions();
  const [summary, setSummary] = useState("");
  const [submittingEvent, setSubmittingEvent] = useState<PrReviewSubmissionEvent | null>(null);
  const [submittedEvent, setSubmittedEvent] = useState<PrReviewSubmissionEvent | null>(null);

  if (!live) {
    return count > 0 ? <div style={LOCAL_FOOTER}>{count} {count === 1 ? "comment" : "comments"} (local notes)</div> : null;
  }

  const submitting = status === "submitting";
  const busy = submitting || refreshing || preparing;
  const blocked = (event: PrReviewSubmissionEvent) => reviewSubmissionBlocked(event, submitting, stale, refreshing, preparing);
  const submit = async (event: PrReviewSubmissionEvent) => {
    if (blocked(event) || reviewActionDisabled(event, count, summary)) return;
    setSubmittingEvent(event);
    const succeeded = await submitReview(event, event === "COMMENT" ? "" : summary);
    setSubmittingEvent(null);
    if (succeeded) {
      setSubmittedEvent(event);
      if (event !== "COMMENT") setSummary("");
    }
  };

  return (
    <div style={FOOTER}>
      <div style={HEADING_ROW}>
        <span style={TITLE}>Submit review</span>
        {count > 0 ? <span style={COUNT}>{count} pending {count === 1 ? "comment" : "comments"}</span> : null}
      </div>
      <textarea
        style={SUMMARY}
        rows={2}
        maxLength={SUMMARY_LIMIT}
        placeholder="Review summary (required for request changes)"
        value={summary}
        disabled={busy}
        onChange={(event) => {
          setSummary(event.target.value);
          setSubmittedEvent(null);
        }}
      />
      <div style={ACTIONS}>
        <ReviewButton event="COMMENT" label="Submit comments" tone="neutral" count={count} summary={summary} blocked={blocked("COMMENT")} submittingEvent={submittingEvent} onSubmit={submit} />
        <ReviewButton event="APPROVE" label="Approve" tone="approve" count={count} summary={summary} blocked={blocked("APPROVE")} submittingEvent={submittingEvent} onSubmit={submit} />
        <ReviewButton event="REQUEST_CHANGES" label="Request changes" tone="changes" count={count} summary={summary} blocked={blocked("REQUEST_CHANGES")} submittingEvent={submittingEvent} onSubmit={submit} />
      </div>
      {stale && !refreshing ? (
        <div style={WARNING}>Comments can still be submitted against the reviewed revision. Refresh before approving or requesting changes.</div>
      ) : null}
      {error ? <div style={ERROR}>{error}</div> : null}
      {submittedEvent !== null && submittedUrl !== null ? (
        <div style={DONE}>
          <div>
            {reviewSuccessLabel(submittedEvent)}
            {submittedUrl ? <> · <a style={LINK} href={submittedUrl} target="_blank" rel="noreferrer">view on GitHub</a></> : null}
          </div>
          {notice ? <div style={DONE_DETAIL}>{notice}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function ReviewButton(props: {
  event: PrReviewSubmissionEvent;
  label: string;
  tone: "neutral" | "approve" | "changes";
  count: number;
  summary: string;
  blocked: boolean;
  submittingEvent: PrReviewSubmissionEvent | null;
  onSubmit(event: PrReviewSubmissionEvent): Promise<void>;
}) {
  const disabled = props.blocked || reviewActionDisabled(props.event, props.count, props.summary);
  return (
    <button
      type="button"
      style={{ ...BUTTON, ...BUTTON_TONES[props.tone], ...(disabled ? DISABLED : {}) }}
      disabled={disabled}
      onClick={() => void props.onSubmit(props.event)}
    >
      {props.submittingEvent === props.event ? "Submitting…" : props.label}
    </button>
  );
}

export function reviewActionDisabled(event: PrReviewSubmissionEvent, count: number, summary: string): boolean {
  return event === "COMMENT" ? count === 0 : event === "REQUEST_CHANGES" ? summary.trim().length === 0 : false;
}

/** New prose may target the reviewed revision; decisions must describe the latest known head. */
export function reviewSubmissionBlocked(
  event: PrReviewSubmissionEvent,
  submitting: boolean,
  stale: boolean,
  refreshing: boolean,
  preparing: boolean,
): boolean {
  return submitting || refreshing || preparing || (stale && event !== "COMMENT");
}

export function reviewSuccessLabel(event: PrReviewSubmissionEvent): string {
  return event === "APPROVE" ? "Pull request approved" : event === "REQUEST_CHANGES" ? "Changes requested" : "Comments submitted";
}

const FOOTER: React.CSSProperties = { width: "100%", height: "100%", minHeight: 0, boxSizing: "border-box", overflowY: "auto", padding: "11px 14px", display: "flex", flexDirection: "column", gap: 8, background: "#0B0E13" };
const LOCAL_FOOTER: React.CSSProperties = { ...FOOTER, color: "#9AA4B2", fontSize: 12 };
const HEADING_ROW: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const TITLE: React.CSSProperties = { color: "#E6EDF3", fontSize: 12, fontWeight: 700 };
const COUNT: React.CSSProperties = { color: "#9AA4B2", fontSize: 10.5 };
const SUMMARY: React.CSSProperties = { width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 48, maxHeight: 120, border: "1px solid #2A2F37", borderRadius: 7, padding: "7px 8px", background: "#0D1117", color: "#E6EDF3", font: "inherit", fontSize: 11.5, lineHeight: "16px", outline: "none" };
const ACTIONS: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 0.8fr 1.15fr", gap: 6 };
const BUTTON: React.CSSProperties = { minWidth: 0, border: "1px solid", borderRadius: 7, padding: "6px 7px", cursor: "pointer", font: "inherit", fontSize: 10.5, fontWeight: 700, whiteSpace: "nowrap", ...NO_FOCUS_RING };
const BUTTON_TONES = {
  neutral: { borderColor: "#3B4656", background: "#161B22", color: "#C9D1D9" },
  approve: { borderColor: "#2F5C3B", background: "rgba(86,194,113,0.16)", color: "#6BE38A" },
  changes: { borderColor: "#7F3B3B", background: "rgba(248,81,73,0.12)", color: "#FF9A9A" },
} satisfies Record<string, React.CSSProperties>;
const DISABLED: React.CSSProperties = { cursor: "not-allowed", opacity: 0.48 };
const WARNING: React.CSSProperties = { color: "#D29922", fontSize: 11 };
const ERROR: React.CSSProperties = { color: "#F85149", background: "rgba(248,81,73,0.08)", borderRadius: 5, padding: "4px 8px", fontSize: 11 };
const DONE: React.CSSProperties = { color: "#6BE38A", fontSize: 11.5, display: "flex", flexDirection: "column", gap: 3 };
const DONE_DETAIL: React.CSSProperties = { color: "#9AA4B2", fontSize: 10.5, lineHeight: "14px" };
const LINK: React.CSSProperties = { color: "#7DD3FC" };
