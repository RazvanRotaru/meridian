import type { PrGitHubComment } from "../../state/prTypes";
import { GitHubMarkdown } from "./GitHubMarkdown";

/** Existing GitHub comments, shared by inline source rows and the small side-panel fallback for
 * comments that cannot be placed safely on current HEAD code. */
export function ExistingCommentList(props: {
  comments: readonly PrGitHubComment[];
  showLocation?: boolean;
}) {
  if (props.comments.length === 0) {
    return null;
  }
  return (
    <div style={LIST} data-existing-review-comments="true">
      {props.comments.map((comment, index) => (
        <div key={`${comment.url}:${comment.updatedAt}:${index}`} style={COMMENT}>
          <div style={META}>
            {props.showLocation && comment.line !== null ? <span style={LINE_CHIP}>L{comment.line}</span> : null}
            {props.showLocation && comment.side === "LEFT" ? <span style={SIDE_CHIP}>base side</span> : null}
            {props.showLocation && comment.line === null ? <span style={SIDE_CHIP}>no current line</span> : null}
            {comment.url ? (
              <a style={AUTHOR} href={comment.url} target="_blank" rel="noreferrer" title="Open comment on GitHub">
                {comment.author}
              </a>
            ) : (
              <span style={AUTHOR}>{comment.author}</span>
            )}
            <span style={TIME} title={comment.updatedAt}>{relativeTime(comment.updatedAt)}</span>
          </div>
          <div style={BODY}><GitHubMarkdown source={comment.body} /></div>
        </div>
      ))}
    </div>
  );
}

/** Compact rail index for comments whose bodies moved into canvas code. The GitHub links remain as
 * a lossless escape hatch when a source response is truncated before the anchored line. */
export function ExistingCommentLinks(props: { comments: readonly PrGitHubComment[] }) {
  if (props.comments.length === 0) {
    return null;
  }
  return (
    <div style={LINK_LIST} data-existing-review-comment-links="true">
      {props.comments.map((comment, index) => {
        const label = `${comment.line === null ? "Comment" : `L${comment.line}`} · ${comment.author}`;
        return comment.url ? (
          <a
            key={`${comment.url}:${index}`}
            style={COMMENT_LINK}
            href={comment.url}
            target="_blank"
            rel="noreferrer"
            title="Open comment on GitHub"
          >
            {label}
          </a>
        ) : (
          <span key={`${comment.updatedAt}:${index}`} style={COMMENT_LINK}>{label}</span>
        );
      })}
    </div>
  );
}

function relativeTime(updatedAt: string): string {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

const LIST: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };
const COMMENT: React.CSSProperties = { border: "1px solid #2A3442", borderLeft: "2px solid rgba(125,211,252,0.62)", background: "#111820", borderRadius: 7, padding: "7px 8px" };
const META: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginBottom: 4, minWidth: 0 };
const AUTHOR: React.CSSProperties = { color: "#E6EDF3", fontSize: 11, fontWeight: 650, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const TIME: React.CSSProperties = { color: "#5A6472", fontSize: 9.5, flexShrink: 0 };
const LINE_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(125,211,252,0.35)", borderRadius: 4, padding: "0 4px", color: "#7DD3FC", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 9.5, fontWeight: 700, lineHeight: "14px" };
const SIDE_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(210,153,34,0.42)", borderRadius: 4, padding: "0 4px", color: "#D29922", background: "rgba(210,153,34,0.08)", fontSize: 9, fontWeight: 650, lineHeight: "14px" };
const BODY: React.CSSProperties = { color: "#C9D1D9", fontSize: 11.5, lineHeight: "15px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const LINK_LIST: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4 };
const COMMENT_LINK: React.CSSProperties = { border: "1px solid #2A3442", borderRadius: 5, background: "#111820", color: "#7DD3FC", padding: "2px 6px", fontSize: 9.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", textDecoration: "none" };
