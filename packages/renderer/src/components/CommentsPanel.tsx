/**
 * The PR-comments modal: a centered overlay listing every review comment on one file, opened by
 * a node card's 💬 badge. Mirrors CodePanel's interaction contract exactly — its whole state is
 * the store's `commentsFile`, and it offers the same three ways out (close button, Escape,
 * backdrop click). Author/body text renders as plain children (React-escaped); the only link is
 * the server-whitelisted https://github.com comment URL.
 */

import { useEffect } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { PullComment } from "../comments/types";

export function CommentsPanel() {
  const commentsFile = useBlueprint((state) => state.commentsFile);
  const comments = useBlueprint((state) => state.comments);
  const { closeComments } = useBlueprintActions();
  const open = commentsFile !== null;

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeComments();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeComments]);

  if (commentsFile === null) {
    return null;
  }
  const items = sortedByLine(comments?.[commentsFile] ?? []);
  return (
    <div style={BACKDROP_STYLE} onClick={closeComments}>
      <div
        style={PANEL_STYLE}
        role="dialog"
        aria-modal
        aria-label="PR review comments"
        onClick={(event) => event.stopPropagation()}
      >
        <header style={HEADER_STYLE}>
          <div style={HEADER_TEXT_STYLE}>
            <div style={TITLE_STYLE}>PR review comments ({items.length})</div>
            <div style={FILE_STYLE} title={commentsFile}>{commentsFile}</div>
          </div>
          <button type="button" style={CLOSE_STYLE} onClick={closeComments} aria-label="Close comments">
            ×
          </button>
        </header>
        <div style={BODY_STYLE}>
          {items.length === 0 ? <div style={EMPTY_STYLE}>No comments on this file.</div> : null}
          {items.map((comment, index) => (
            <CommentCard key={index} comment={comment} />
          ))}
        </div>
      </div>
    </div>
  );
}

function CommentCard({ comment }: { comment: PullComment }) {
  return (
    <article style={CARD_STYLE}>
      <div style={CARD_TOP_STYLE}>
        <span style={AUTHOR_STYLE}>{comment.author}</span>
        {comment.line !== null ? <span style={LINE_STYLE}>line {comment.line}</span> : null}
        {comment.createdAt ? <span style={DATE_STYLE}>{shortDate(comment.createdAt)}</span> : null}
        <PrLink comment={comment} />
      </div>
      <p style={COMMENT_BODY_STYLE}>{comment.body}</p>
    </article>
  );
}

// The href is already whitelisted server-side to https://github.com; a PR without a surviving
// url still shows its number as plain text so the reader can find it by hand.
function PrLink({ comment }: { comment: PullComment }) {
  const label = comment.prNumber !== null ? `PR #${comment.prNumber}` : "open on GitHub";
  if (comment.url === null) {
    return comment.prNumber !== null ? <span style={PR_PLAIN_STYLE}>{label}</span> : null;
  }
  return (
    <a href={comment.url} target="_blank" rel="noopener noreferrer" style={PR_LINK_STYLE}>
      {label} ↗
    </a>
  );
}

// Commented lines order the reading top-to-bottom like the file; line-less (outdated) ones sink.
function sortedByLine(items: PullComment[]): PullComment[] {
  return [...items].sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
}

function shortDate(createdAt: string): string {
  const time = Date.parse(createdAt);
  return Number.isNaN(time) ? "" : new Date(time).toLocaleDateString();
}

const BACKDROP_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(8,10,14,0.6)",
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const PANEL_STYLE: React.CSSProperties = {
  width: "60vw",
  maxWidth: 720,
  maxHeight: "75vh",
  display: "flex",
  flexDirection: "column",
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 12,
  overflow: "hidden",
  boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
};
const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "12px 14px",
  borderBottom: "1px solid #2A2F37",
  background: "#161B22",
};
const HEADER_TEXT_STYLE: React.CSSProperties = { flex: 1, minWidth: 0 };
const TITLE_STYLE: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: "#E6EDF3" };
const FILE_STYLE: React.CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  color: "#7B8695",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const CLOSE_STYLE: React.CSSProperties = {
  flexShrink: 0,
  background: "#1A1F27",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  width: 26,
  height: 26,
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
};
const BODY_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const EMPTY_STYLE: React.CSSProperties = { fontSize: 12, color: "#7B8695" };
const CARD_STYLE: React.CSSProperties = {
  border: "1px solid #232935",
  borderRadius: 8,
  background: "#12171E",
  padding: "10px 12px",
};
const CARD_TOP_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  marginBottom: 6,
};
const AUTHOR_STYLE: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#E6EDF3" };
const LINE_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: "#8FB6E3",
  border: "1px solid #2F4A66",
  borderRadius: 999,
  padding: "0 6px",
};
const DATE_STYLE: React.CSSProperties = { fontSize: 11, color: "#7B8695" };
const PR_LINK_STYLE: React.CSSProperties = { marginLeft: "auto", fontSize: 11, color: "#56C271" };
const PR_PLAIN_STYLE: React.CSSProperties = { marginLeft: "auto", fontSize: 11, color: "#7B8695" };
const COMMENT_BODY_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: "18px",
  color: "#C9D3E0",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};
