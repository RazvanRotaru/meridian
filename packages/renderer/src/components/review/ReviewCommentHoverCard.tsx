import { useState } from "react";
import type { ReviewCommentNodePreview } from "../../derive/reviewCommentPreview";
import { GitHubMarkdown } from "./GitHubMarkdown";
import { MessageIcon } from "./MessageIcon";

export function ReviewCommentIndicator({
  label,
  count,
  comments,
}: {
  label: string;
  count: number;
  comments: readonly ReviewCommentNodePreview[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="nodrag nopan nowheel"
      style={INDICATOR_HOST}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        style={INDICATOR}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <MessageIcon size={16} />
        <span style={COUNT_BADGE}>{count}</span>
      </button>
      {open ? (
        <div style={POPOVER_BRIDGE}>
          <CommentPreviewCard label={label} comments={comments} />
        </div>
      ) : null}
    </div>
  );
}

export function CommentPreviewCard({ label, comments }: { label: string; comments: readonly ReviewCommentNodePreview[] }) {
  return (
    <div role="tooltip" style={POPOVER} data-review-comment-scroll="true" onClick={(event) => event.stopPropagation()}>
      <div style={POPOVER_TITLE}>{label}</div>
      <div style={COMMENT_LIST}>
        {comments.map((comment) => (
          <article key={comment.key} style={COMMENT} data-review-comment-card="true">
            <div style={COMMENT_META}>
              <span style={AUTHOR}>{comment.author}</span>
              {comment.line !== null ? (
                <span style={comment.lineStale ? STALE_LINE : LINE}>
                  {`L${comment.line}${comment.side === "LEFT" ? " · base" : ""}${comment.lineStale ? " · previous revision" : ""}`}
                </span>
              ) : null}
              <span style={{ flex: 1 }} />
              {comment.url ? <a href={comment.url} target="_blank" rel="noreferrer" style={GITHUB_LINK}>GitHub ↗</a> : null}
            </div>
            <div style={COMMENT_BODY} data-review-comment-body="true"><GitHubMarkdown source={comment.body} /></div>
          </article>
        ))}
      </div>
    </div>
  );
}

const INDICATOR_HOST: React.CSSProperties = { position: "relative", width: "100%", height: "100%" };
const INDICATOR: React.CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  transform: "translateX(-4px)",
  width: 26,
  height: 26,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
  border: "1.5px solid rgba(125,211,252,0.9)",
  borderRadius: 999,
  background: "#102235",
  color: "#9DDEFF",
  boxShadow: "0 2px 10px rgba(0,0,0,0.58)",
  cursor: "default",
  padding: 0,
};
const COUNT_BADGE: React.CSSProperties = { position: "absolute", top: -4, right: -4, minWidth: 13, height: 13, padding: "0 3px", boxSizing: "border-box", display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 999, background: "#388BFD", color: "white", fontSize: 7.5, fontWeight: 800, lineHeight: "13px" };
const POPOVER_BRIDGE: React.CSSProperties = { position: "absolute", zIndex: 20, top: "100%", right: 0, paddingTop: 6 };
const POPOVER: React.CSSProperties = { width: 310, height: 300, overflowX: "auto", overflowY: "auto", overscrollBehavior: "contain", boxSizing: "border-box", padding: 10, border: "1px solid #334155", borderRadius: 9, background: "#0D131B", color: "#DCE6F2", boxShadow: "0 14px 36px rgba(0,0,0,0.65)", fontFamily: "ui-sans-serif, system-ui, sans-serif" };
const POPOVER_TITLE: React.CSSProperties = { marginBottom: 8, color: "#9AA4B2", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" };
const COMMENT_LIST: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 7, width: "100%", minWidth: 0 };
const COMMENT: React.CSSProperties = { width: "100%", minWidth: 0, boxSizing: "border-box", padding: "8px 9px", border: "1px solid #253041", borderRadius: 7, background: "#111923" };
const COMMENT_META: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginBottom: 5, minWidth: 0 };
const AUTHOR: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#E6EDF3", fontSize: 11, fontWeight: 700 };
const LINE: React.CSSProperties = { flexShrink: 0, color: "#7DD3FC", fontSize: 9.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const STALE_LINE: React.CSSProperties = { ...LINE, color: "#D29922" };
const GITHUB_LINK: React.CSSProperties = { flexShrink: 0, color: "#7DD3FC", fontSize: 10, textDecoration: "none" };
// Keep every comment inside its card. Prose wraps at spaces and long URL/code-like tokens may
// break at any point onto the next line instead of widening or escaping the fixed overlay.
const COMMENT_BODY: React.CSSProperties = { minWidth: 0, maxWidth: "100%", color: "#C9D1D9", fontSize: 11.5, lineHeight: "16px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "normal" };
