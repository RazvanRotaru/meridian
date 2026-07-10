/**
 * The comment surfaces of the review panel. A row (file or unit) gets a CommentButton that opens
 * one shared inline composer; drafts render under their row and persist (localStorage, per
 * reviewKey) until deleted or submitted. The footer turns the drafts into ONE GitHub review
 * (store.submitReviewComments → POST /api/prs/review); with no PR session the drafts simply stay
 * local notes, and the footer says so instead of offering a submit that cannot work.
 */

import { useState } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { ReviewComment } from "../../state/reviewTicksPref";
import { NO_FOCUS_RING } from "./reviewPanelKit";

/** Shown only while its row is hovered (or already carries drafts / an open composer) — a panel
 * full of identical always-on icons reads as noise. Hidden, not unmounted, so columns never shift. */
export function CommentButton(props: { count: number; active: boolean; visible: boolean; onClick: () => void }) {
  const shown = props.visible || props.active || props.count > 0;
  return (
    <button
      type="button"
      style={{ ...COMMENT_BTN, ...(props.active || props.count > 0 ? COMMENT_BTN_ON : {}), visibility: shown ? "visible" : "hidden" }}
      title={props.count > 0 ? `${props.count} draft ${props.count === 1 ? "comment" : "comments"}` : "Add a comment"}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
    >
      <CommentIcon />
      {props.count > 0 && <span style={COMMENT_COUNT}>{props.count}</span>}
    </button>
  );
}

export function CommentList(props: { comments: readonly ReviewComment[] }) {
  const { deleteReviewComment } = useBlueprintActions();
  if (props.comments.length === 0) {
    return null;
  }
  return (
    <div style={LIST}>
      {props.comments.map((comment) => (
        <div key={comment.id} style={DRAFT}>
          <div style={DRAFT_BODY}>{comment.body}</div>
          <button type="button" style={DRAFT_DELETE} title="Delete draft" onClick={() => deleteReviewComment(comment.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** The one inline composer: textarea + Add/Cancel. ⌘/ctrl-Enter adds, Escape cancels. */
export function CommentComposer(props: { placeholder: string; onAdd: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState("");
  const add = () => {
    if (body.trim().length > 0) {
      props.onAdd(body);
    }
    props.onCancel();
  };
  return (
    <div style={COMPOSER}>
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
            add();
          } else if (event.key === "Escape") {
            props.onCancel();
          }
        }}
      />
      <div style={COMPOSER_ROW}>
        <button type="button" style={ADD_BTN} disabled={body.trim().length === 0} onClick={add}>
          Add comment
        </button>
        <button type="button" style={CANCEL_BTN} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Panel footer: draft count + submit-to-GitHub (web PR sessions), or a "local notes" hint. */
export function SubmitReviewFooter() {
  const count = useBlueprint((state) => state.reviewComments.length);
  const prReviewed = useBlueprint((state) => state.prReviewed);
  const status = useBlueprint((state) => state.reviewSubmitStatus);
  const error = useBlueprint((state) => state.reviewSubmitError);
  const submittedUrl = useBlueprint((state) => state.reviewSubmittedUrl);
  const { submitReviewComments } = useBlueprintActions();
  if (count === 0 && !error && submittedUrl === null) {
    return null;
  }
  return (
    <div style={FOOTER}>
      {count > 0 && (
        <div style={FOOTER_ROW}>
          <span style={FOOTER_COUNT}>
            {count} {count === 1 ? "comment" : "comments"}
            {prReviewed === null ? " (local notes)" : ""}
          </span>
          {prReviewed !== null && (
            <button type="button" style={SUBMIT_BTN} disabled={status === "submitting"} onClick={() => void submitReviewComments()}>
              {status === "submitting" ? "Submitting…" : "Submit review"}
            </button>
          )}
        </div>
      )}
      {error && <div style={FOOTER_ERROR}>{error}</div>}
      {/* "" means submitted but GitHub returned no usable link — still confirm, just without one. */}
      {count === 0 && submittedUrl !== null && (
        <div style={FOOTER_DONE}>
          Review submitted
          {submittedUrl !== "" && (
            <>
              {" · "}
              <a style={FOOTER_LINK} href={submittedUrl} target="_blank" rel="noreferrer">
                view on GitHub
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CommentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.75.75 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
    </svg>
  );
}

const COMMENT_BTN: React.CSSProperties = { font: "inherit", display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "transparent", cursor: "pointer", color: "#5A6472", padding: "2px 4px", borderRadius: 5, flexShrink: 0, ...NO_FOCUS_RING };
const COMMENT_BTN_ON: React.CSSProperties = { color: "#7DD3FC" , ...NO_FOCUS_RING };
const COMMENT_COUNT: React.CSSProperties = { fontSize: 10, fontWeight: 700 };
const LIST: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, padding: "2px 6px 4px 26px" };
const DRAFT: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 6, border: "1px solid #253041", background: "rgba(56,139,253,0.07)", borderRadius: 7, padding: "6px 8px" };
const DRAFT_BODY: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: "15px", color: "#C9D1D9", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const DRAFT_DELETE: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", color: "#5A6472", fontSize: 10, padding: 2, flexShrink: 0 , ...NO_FOCUS_RING };
const COMPOSER: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "2px 6px 6px 26px" };
const TEXTAREA: React.CSSProperties = { width: "100%", boxSizing: "border-box", resize: "vertical", background: "#0D1117", border: "1px solid #2A2F37", borderRadius: 7, color: "#E6EDF3", font: "inherit", fontSize: 12, padding: "6px 8px", outline: "none" };
const COMPOSER_ROW: React.CSSProperties = { display: "flex", gap: 6 };
const ADD_BTN: React.CSSProperties = { font: "inherit", border: "1px solid #2F5C3B", background: "rgba(86,194,113,0.16)", color: "#6BE38A", borderRadius: 6, padding: "3px 10px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", ...NO_FOCUS_RING };
const CANCEL_BTN: React.CSSProperties = { font: "inherit", border: "1px solid #2A2F37", background: "transparent", color: "#9AA4B2", borderRadius: 6, padding: "3px 10px", fontSize: 11.5, cursor: "pointer", ...NO_FOCUS_RING };
const FOOTER: React.CSSProperties = { borderTop: "1px solid #20262F", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6, background: "#0B0E13" };
const FOOTER_ROW: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const FOOTER_COUNT: React.CSSProperties = { fontSize: 12, color: "#9AA4B2" };
const SUBMIT_BTN: React.CSSProperties = { font: "inherit", border: "1px solid #2F5C3B", background: "rgba(86,194,113,0.16)", color: "#6BE38A", borderRadius: 7, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", ...NO_FOCUS_RING };
const FOOTER_ERROR: React.CSSProperties = { fontSize: 11, color: "#F85149", background: "rgba(248,81,73,0.08)", borderRadius: 5, padding: "4px 8px" };
const FOOTER_DONE: React.CSSProperties = { fontSize: 12, color: "#6BE38A" };
const FOOTER_LINK: React.CSSProperties = { color: "#7DD3FC" };
