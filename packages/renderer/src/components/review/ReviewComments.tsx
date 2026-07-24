/**
 * The comment surfaces of the review panel. A row (file or unit) gets a CommentButton that opens
 * one shared inline composer; drafts render under their row and persist (localStorage, per
 * reviewKey) until deleted or submitted. With no PR session the drafts simply stay local notes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
  const diffLinesByFile = useBlueprint((state) => state.reviewDiffLinesByFile);
  const forceFileComments = useBlueprint((state) => state.prReviewStale
    && (state.prReviewRevision?.headSha ?? null) === null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const fileCommentIds = useMemo(() => {
    if (!livePrReview || review === null) {
      return EMPTY_FILE_COMMENT_IDS;
    }
    const fileComments = new Set<string>();
    // File comments intentionally do not carry local draft ids in the transport contract. Classify each
    // draft independently so duplicate bodies/paths cannot cause the wrong row to be labelled.
    for (const comment of props.comments) {
      const submission = buildReviewSubmission(
        [comment],
        reviewFiles,
        review.context,
        commentRanges,
        { forceFileComments, diffLinesByFile },
      );
      if (submission.fileComments.length > 0) {
        fileComments.add(comment.id);
      }
    }
    return fileComments;
  }, [commentRanges, diffLinesByFile, forceFileComments, livePrReview, props.comments, review, reviewFiles]);
  if (props.comments.length === 0) {
    return null;
  }
  const inCode = props.placement === "code";
  return (
    <div style={inCode ? CODE_LIST : LIST} data-pending-review-comments={inCode ? "true" : undefined}>
      {props.comments.map((comment) => {
        const fileComment = fileCommentIds.has(comment.id);
        return (
          <div
            key={comment.id}
            style={DRAFT}
            data-pending-review-comment-id={comment.id}
            data-review-comment-file={fileComment ? "true" : undefined}
          >
            {comment.line !== null ? (
              <span
                style={comment.lineStale ? { ...LINE_CHIP, ...LINE_CHIP_STALE } : LINE_CHIP}
                title={fileComment
                  ? "GitHub will attach this review comment to the file because its line cannot be anchored inline"
                  : undefined}
              >
                {`L${comment.line}${comment.side === "LEFT" ? " · base" : ""}${comment.lineStale ? " · previous revision" : ""}`}
              </span>
            ) : null}
            {inCode ? <span style={PENDING_CHIP}>Pending</span> : null}
            {fileComment ? (
              <span style={FILE_COMMENT_CHIP} title="Submitted as a real GitHub file-level review comment">
                File comment
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
        );
      })}
    </div>
  );
}

/** The one inline composer: textarea + Add/Cancel. ⌘/ctrl-Enter adds, Escape cancels. */
export function CommentComposer(props: {
  placeholder: string;
  onAdd: (body: string) => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
  initialBody?: string;
  /** Optional owner-controlled draft. Omit to retain the composer's original local state. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Keep the draft visible while asking for an explicit destructive dismissal. */
  confirmDiscard?: boolean;
  onKeepEditing?: () => void;
  onDiscard?: () => void;
  submitLabel?: string;
  compact?: boolean;
  error?: string | null;
  /** Keep an inline code-panel Escape from reaching the panel's own layer-stack closer. */
  stopEscape?: boolean;
}) {
  const [localBody, setLocalBody] = useState(props.initialBody ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wasConfirmingDiscard = useRef(props.confirmDiscard ?? false);
  const body = props.value === undefined ? localBody : props.value;
  const setBody = (value: string) => {
    if (props.value === undefined) {
      setLocalBody(value);
    }
    props.onValueChange?.(value);
  };
  const keepEditing = () => props.onKeepEditing?.();
  const discard = () => (props.onDiscard ?? props.onCancel)();
  useEffect(() => {
    const wasConfirming = wasConfirmingDiscard.current;
    wasConfirmingDiscard.current = props.confirmDiscard ?? false;
    if (wasConfirming && !props.confirmDiscard) {
      textareaRef.current?.focus();
    }
  }, [props.confirmDiscard]);
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
    <div
      style={props.compact ? COMPACT_COMPOSER : COMPOSER}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !props.confirmDiscard) {
          return;
        }
        event.preventDefault();
        if (props.stopEscape) {
          event.stopPropagation();
        }
        keepEditing();
      }}
    >
      <textarea
        ref={textareaRef}
        style={TEXTAREA}
        rows={3}
        autoFocus={!props.confirmDiscard}
        placeholder={props.placeholder}
        value={body}
        readOnly={props.confirmDiscard}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (!props.confirmDiscard && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void add();
          } else if (event.key === "Escape" && !props.confirmDiscard) {
            if (props.stopEscape) {
              event.stopPropagation();
            }
            props.onCancel();
          }
        }}
      />
      {(props.error || localError) ? <div style={COMPOSER_ERROR}>{props.error || localError}</div> : null}
      {props.confirmDiscard ? (
        <div role="alert" style={DISCARD_ALERT}>
          <span style={DISCARD_PROMPT}>Discard this comment?</span>
          <div style={COMPOSER_ROW}>
            <button type="button" style={CANCEL_BTN} autoFocus onClick={keepEditing}>
              Keep editing
            </button>
            <button type="button" style={DISCARD_BTN} onClick={discard}>
              Discard comment
            </button>
          </div>
        </div>
      ) : (
        <div style={COMPOSER_ROW}>
          <button type="button" style={ADD_BTN} disabled={body.trim().length === 0 || submitting} onClick={() => void add()}>
            {submitting ? "Saving…" : (props.submitLabel ?? "Add comment")}
          </button>
          <button type="button" style={CANCEL_BTN} disabled={submitting} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

const COMMENT_BTN: React.CSSProperties = { font: "inherit", display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "transparent", cursor: "pointer", color: "#5A6472", padding: "2px 4px", borderRadius: 5, flexShrink: 0, ...NO_FOCUS_RING };
const COMMENT_BTN_ON: React.CSSProperties = { color: "#7DD3FC" , ...NO_FOCUS_RING };
const COMMENT_COUNT: React.CSSProperties = { fontSize: 10, fontWeight: 700 };
const LIST: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, padding: "2px 6px 4px 26px" };
const CODE_LIST: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };
const DRAFT: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 6, border: "1px solid #253041", background: "rgba(56,139,253,0.07)", borderRadius: 7, padding: "6px 8px" };
const DRAFT_CONTENT: React.CSSProperties = { flex: 1, minWidth: 0 };
const LINE_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(125,211,252,0.35)", borderRadius: 4, padding: "0 4px", color: "#7DD3FC", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 9.5, fontWeight: 700, lineHeight: "14px" };
const LINE_CHIP_STALE: React.CSSProperties = { color: "#D29922", borderColor: "rgba(210,153,34,0.42)", background: "rgba(210,153,34,0.10)" };
const PENDING_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(210,153,34,0.42)", borderRadius: 4, padding: "0 4px", color: "#D29922", background: "rgba(210,153,34,0.08)", fontSize: 9, fontWeight: 700, lineHeight: "14px", textTransform: "uppercase", letterSpacing: "0.03em" };
const FILE_COMMENT_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(125,211,252,0.38)", borderRadius: 4, padding: "0 4px", color: "#7DD3FC", background: "rgba(56,139,253,0.09)", fontSize: 9, fontWeight: 700, lineHeight: "14px", whiteSpace: "nowrap" };
const DRAFT_BODY: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: "15px", color: "#C9D1D9", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const DRAFT_ACTION: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", color: "#7DD3FC", font: "inherit", fontSize: 10.5, padding: "1px 2px", flexShrink: 0, ...NO_FOCUS_RING };
const DRAFT_DELETE: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", color: "#5A6472", fontSize: 10, padding: 2, flexShrink: 0 , ...NO_FOCUS_RING };
const COMPOSER: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "2px 6px 6px 26px" };
const COMPACT_COMPOSER: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: 0 };
const TEXTAREA: React.CSSProperties = { width: "100%", boxSizing: "border-box", resize: "vertical", background: "#0D1117", border: "1px solid #2A2F37", borderRadius: 7, color: "#E6EDF3", font: "inherit", fontSize: 12, padding: "6px 8px", outline: "none" };
const COMPOSER_ERROR: React.CSSProperties = { color: "#F85149", fontSize: 10.5, lineHeight: "14px" };
const COMPOSER_ROW: React.CSSProperties = { display: "flex", gap: 6 };
const DISCARD_ALERT: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", border: "1px solid rgba(240,120,124,0.42)", background: "rgba(240,120,124,0.08)", borderRadius: 6, padding: "5px 7px" };
const DISCARD_PROMPT: React.CSSProperties = { color: "#E6EDF3", fontSize: 11.5 };
const ADD_BTN: React.CSSProperties = { font: "inherit", border: "1px solid #2F5C3B", background: "rgba(86,194,113,0.16)", color: "#6BE38A", borderRadius: 6, padding: "3px 10px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", ...NO_FOCUS_RING };
const CANCEL_BTN: React.CSSProperties = { font: "inherit", border: "1px solid #2A2F37", background: "transparent", color: "#9AA4B2", borderRadius: 6, padding: "3px 10px", fontSize: 11.5, cursor: "pointer", ...NO_FOCUS_RING };
const DISCARD_BTN: React.CSSProperties = { ...CANCEL_BTN, borderColor: "rgba(240,120,124,0.48)", background: "rgba(240,120,124,0.12)", color: "#F0787C" };
const EMPTY_FILE_COMMENT_IDS: ReadonlySet<string> = new Set<string>();
