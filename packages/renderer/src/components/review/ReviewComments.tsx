/**
 * The comment surfaces of the review panel. A row (file or unit) gets a CommentButton that opens
 * one shared inline composer; drafts render under their row and persist (localStorage, per
 * reviewKey) until deleted or submitted. With no PR session the drafts simply stay local notes.
 */

import { useMemo, useState } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { ReviewComment } from "../../state/reviewTicksPref";
import { buildReviewSubmission } from "../../derive/reviewSubmit";
import { NO_FOCUS_RING } from "./reviewPanelKit";
import { MessageIcon } from "./MessageIcon";

/** Shown only while its row is hovered (or already carries drafts / an open composer) — a panel
 * full of identical always-on icons reads as noise. Hidden, not unmounted, so columns never shift. */
export function CommentButton(props: { count: number; active: boolean; visible: boolean; title?: string; onClick: () => void }) {
  const shown = props.visible || props.active || props.count > 0;
  const defaultTitle = props.count > 0
    ? `${props.count} draft ${props.count === 1 ? "comment" : "comments"}`
    : "Add a comment";
  return (
    <button
      type="button"
      style={{ ...COMMENT_BTN, ...(props.active || props.count > 0 ? COMMENT_BTN_ON : {}), visibility: shown ? "visible" : "hidden" }}
      title={props.title ?? defaultTitle}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
    >
      <MessageIcon />
      {props.count > 0 && <span style={COMMENT_COUNT}>{props.count}</span>}
    </button>
  );
}

export function CommentList(props: { comments: readonly ReviewComment[]; placement?: "panel" | "code" }) {
  const { deleteReviewComment, updateReviewComment } = useBlueprintActions();
  const livePrReview = useBlueprint((state) => state.prReviewed !== null && state.review !== null);
  const review = useBlueprint((state) => state.review);
  const reviewFiles = useBlueprint((state) => state.reviewFiles);
  const commentRanges = useBlueprint((state) => state.reviewCommentRangesByFile);
  const [editingId, setEditingId] = useState<string | null>(null);
  const blockedIds = useMemo(() => {
    if (!livePrReview || review === null) {
      return EMPTY_BLOCKED_IDS;
    }
    return new Set(buildReviewSubmission(props.comments, reviewFiles, review.context, commentRanges).blocked.map((comment) => comment.id));
  }, [commentRanges, livePrReview, props.comments, review, reviewFiles]);
  if (props.comments.length === 0) {
    return null;
  }
  const inCode = props.placement === "code";
  return (
    <div style={inCode ? CODE_LIST : LIST} data-pending-review-comments={inCode ? "true" : undefined}>
      {props.comments.map((comment) => (
        <div
          key={comment.id}
          style={blockedIds.has(comment.id) ? { ...DRAFT, ...DRAFT_BLOCKED } : DRAFT}
          data-pending-review-comment-id={comment.id}
          data-review-comment-blocked={blockedIds.has(comment.id) ? "true" : undefined}
        >
          {comment.line !== null ? (
            <span
              style={blockedIds.has(comment.id) ? { ...LINE_CHIP, ...LINE_CHIP_STALE } : LINE_CHIP}
              title={blockedIds.has(comment.id) ? "This line is not available in GitHub's current pull request diff" : undefined}
            >
              {`L${comment.line}${comment.lineStale ? " · previous revision" : ""}`}
            </span>
          ) : null}
          {inCode ? <span style={PENDING_CHIP}>Pending</span> : null}
          {blockedIds.has(comment.id) ? (
            <span style={BLOCKED_CHIP} title="Delete this draft and add it again on a line shown in the current GitHub diff">
              Needs diff line
            </span>
          ) : null}
          <div style={DRAFT_CONTENT}>
            {editingId === comment.id ? (
              <CommentComposer
                key={`edit-${comment.id}`}
                placeholder="Edit comment…"
                initialBody={comment.body}
                submitLabel="Save changes"
                compact
                stopEscape={inCode}
                onAdd={(body) => {
                  updateReviewComment(comment.id, body);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div style={DRAFT_BODY}>{comment.body}</div>
            )}
          </div>
          {editingId !== comment.id ? (
            <button type="button" style={DRAFT_ACTION} title="Edit draft" onClick={() => setEditingId(comment.id)}>
              Edit
            </button>
          ) : null}
          <button type="button" style={DRAFT_DELETE} title="Delete draft" onClick={() => deleteReviewComment(comment.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** The one inline composer: textarea + Add/Cancel. ⌘/ctrl-Enter adds, Escape cancels. */
export function CommentComposer(props: {
  placeholder: string;
  onAdd: (body: string) => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
  initialBody?: string;
  submitLabel?: string;
  compact?: boolean;
  error?: string | null;
  /** Keep an inline code-panel Escape from reaching the panel's own layer-stack closer. */
  stopEscape?: boolean;
}) {
  const [body, setBody] = useState(props.initialBody ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const add = async () => {
    if (body.trim().length === 0 || submitting) {
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    try {
      const succeeded = await props.onAdd(body);
      if (succeeded !== false) {
        props.onCancel();
      }
    } catch {
      setLocalError("Could not save comment.");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div style={props.compact ? COMPACT_COMPOSER : COMPOSER}>
      <textarea
        style={TEXTAREA}
        rows={3}
        autoFocus
        placeholder={props.placeholder}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void add();
          } else if (event.key === "Escape") {
            if (props.stopEscape) {
              event.stopPropagation();
            }
            props.onCancel();
          }
        }}
      />
      {(props.error || localError) ? <div style={COMPOSER_ERROR}>{props.error || localError}</div> : null}
      <div style={COMPOSER_ROW}>
        <button type="button" style={ADD_BTN} disabled={body.trim().length === 0 || submitting} onClick={() => void add()}>
          {submitting ? "Saving…" : (props.submitLabel ?? "Add comment")}
        </button>
        <button type="button" style={CANCEL_BTN} disabled={submitting} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const COMMENT_BTN: React.CSSProperties = { font: "inherit", display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "transparent", cursor: "pointer", color: "#5A6472", padding: "2px 4px", borderRadius: 5, flexShrink: 0, ...NO_FOCUS_RING };
const COMMENT_BTN_ON: React.CSSProperties = { color: "#7DD3FC" , ...NO_FOCUS_RING };
const COMMENT_COUNT: React.CSSProperties = { fontSize: 10, fontWeight: 700 };
const LIST: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, padding: "2px 6px 4px 26px" };
const CODE_LIST: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };
const DRAFT: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 6, border: "1px solid #253041", background: "rgba(56,139,253,0.07)", borderRadius: 7, padding: "6px 8px" };
const DRAFT_BLOCKED: React.CSSProperties = { borderColor: "rgba(210,153,34,0.52)", background: "rgba(210,153,34,0.07)" };
const DRAFT_CONTENT: React.CSSProperties = { flex: 1, minWidth: 0 };
const LINE_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(125,211,252,0.35)", borderRadius: 4, padding: "0 4px", color: "#7DD3FC", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 9.5, fontWeight: 700, lineHeight: "14px" };
const LINE_CHIP_STALE: React.CSSProperties = { color: "#D29922", borderColor: "rgba(210,153,34,0.42)", background: "rgba(210,153,34,0.10)" };
const PENDING_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(210,153,34,0.42)", borderRadius: 4, padding: "0 4px", color: "#D29922", background: "rgba(210,153,34,0.08)", fontSize: 9, fontWeight: 700, lineHeight: "14px", textTransform: "uppercase", letterSpacing: "0.03em" };
const BLOCKED_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(210,153,34,0.52)", borderRadius: 4, padding: "0 4px", color: "#E3B341", background: "rgba(210,153,34,0.12)", fontSize: 9, fontWeight: 700, lineHeight: "14px", whiteSpace: "nowrap" };
const DRAFT_BODY: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: "15px", color: "#C9D1D9", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const DRAFT_ACTION: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", color: "#7DD3FC", font: "inherit", fontSize: 10.5, padding: "1px 2px", flexShrink: 0, ...NO_FOCUS_RING };
const DRAFT_DELETE: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", color: "#5A6472", fontSize: 10, padding: 2, flexShrink: 0 , ...NO_FOCUS_RING };
const COMPOSER: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "2px 6px 6px 26px" };
const COMPACT_COMPOSER: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: 0 };
const TEXTAREA: React.CSSProperties = { width: "100%", boxSizing: "border-box", resize: "vertical", background: "#0D1117", border: "1px solid #2A2F37", borderRadius: 7, color: "#E6EDF3", font: "inherit", fontSize: 12, padding: "6px 8px", outline: "none" };
const COMPOSER_ERROR: React.CSSProperties = { color: "#F85149", fontSize: 10.5, lineHeight: "14px" };
const COMPOSER_ROW: React.CSSProperties = { display: "flex", gap: 6 };
const ADD_BTN: React.CSSProperties = { font: "inherit", border: "1px solid #2F5C3B", background: "rgba(86,194,113,0.16)", color: "#6BE38A", borderRadius: 6, padding: "3px 10px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", ...NO_FOCUS_RING };
const CANCEL_BTN: React.CSSProperties = { font: "inherit", border: "1px solid #2A2F37", background: "transparent", color: "#9AA4B2", borderRadius: 6, padding: "3px 10px", fontSize: 11.5, cursor: "pointer", ...NO_FOCUS_RING };
const EMPTY_BLOCKED_IDS: ReadonlySet<string> = new Set<string>();
