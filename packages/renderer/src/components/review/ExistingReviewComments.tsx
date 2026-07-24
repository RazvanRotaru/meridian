import { useState } from "react";
import type { PrGitHubComment } from "../../state/prTypes";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { CommentComposer } from "./ReviewComments";
import { GitHubMarkdown } from "./GitHubMarkdown";
import { NO_FOCUS_RING } from "./reviewPanelKit";

type ActiveComposer = { commentId: number; mode: "edit" | "reply" };

/** Existing GitHub comments, shared by inline source rows and the small side-panel fallback for
 * comments that cannot be placed safely on current HEAD code. */
export function ExistingCommentList(props: {
  comments: readonly PrGitHubComment[];
  showLocation?: boolean;
}) {
  const [activeComposer, setActiveComposer] = useState<ActiveComposer | null>(null);
  const mutationStatus = useBlueprint((state) => state.prCommentMutationStatus);
  const mutationError = useBlueprint((state) => state.prCommentMutationError);
  const reviewStale = useBlueprint((state) => state.prReviewStale);
  const reviewRefreshing = useBlueprint((state) => state.prReviewRefreshing);
  const reviewPreparing = useBlueprint((state) => state.prReviewStatus === "preparing");
  const { editPrReviewComment, replyToPrReviewComment } = useBlueprintActions();
  if (props.comments.length === 0) {
    return null;
  }
  const orderedComments = reviewCommentThreadOrder(props.comments);
  return (
    <div style={LIST} data-existing-review-comments="true">
      {orderedComments.map((comment) => {
        const composer = activeComposer?.commentId === comment.id ? activeComposer.mode : null;
        const replyTargetId = comment.inReplyToId ?? comment.id;
        const busy = mutationStatus === "submitting" || reviewStale || reviewRefreshing || reviewPreparing;
        const blockedTitle = reviewStale || reviewRefreshing
          ? "Refresh the pull request before updating comments"
          : reviewPreparing
            ? "Wait for head preparation to finish"
            : undefined;
        return (
          <div
            key={comment.id}
            style={comment.inReplyToId === null ? COMMENT : { ...COMMENT, ...REPLY_COMMENT }}
            data-existing-review-comment-id={comment.id}
            data-review-comment-reply={comment.inReplyToId === null ? undefined : "true"}
          >
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
            {composer === "edit" ? null : <div style={BODY}><GitHubMarkdown source={comment.body} /></div>}
            {composer === null ? (
              <div style={ACTIONS}>
                {comment.viewerCanEdit ? (
                  <button
                    type="button"
                    style={busy ? { ...ACTION, ...ACTION_DISABLED } : ACTION}
                    disabled={busy}
                    title={blockedTitle ?? "Edit comment"}
                    onClick={() => setActiveComposer({ commentId: comment.id, mode: "edit" })}
                  >
                    Edit
                  </button>
                ) : null}
                <button
                  type="button"
                  style={busy ? { ...ACTION, ...ACTION_DISABLED } : ACTION}
                  disabled={busy}
                  title={blockedTitle ?? "Reply to comment"}
                  onClick={() => setActiveComposer({ commentId: comment.id, mode: "reply" })}
                >
                  Reply
                </button>
              </div>
            ) : (
              <CommentComposer
                key={`${composer}-${comment.id}`}
                compact
                stopEscape
                initialBody={composer === "edit" ? comment.body : ""}
                placeholder={composer === "edit" ? "Edit comment…" : `Reply to ${comment.author}…`}
                submitLabel={composer === "edit" ? "Save changes" : "Add reply"}
                error={mutationError}
                onAdd={(body) => composer === "edit"
                  ? editPrReviewComment(comment.id, body)
                  : replyToPrReviewComment(replyTargetId, body)}
                onCancel={() => setActiveComposer(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** GitHub returns comments chronologically; keep each thread together so replies remain legible. */
export function reviewCommentThreadOrder(comments: readonly PrGitHubComment[]): PrGitHubComment[] {
  const roots = comments.filter((comment) => comment.inReplyToId === null);
  const rootIds = new Set(roots.map((comment) => comment.id));
  const replies = new Map<number, PrGitHubComment[]>();
  const orphans: PrGitHubComment[] = [];
  for (const comment of comments) {
    if (comment.inReplyToId === null) continue;
    if (!rootIds.has(comment.inReplyToId)) {
      orphans.push(comment);
      continue;
    }
    const bucket = replies.get(comment.inReplyToId);
    bucket ? bucket.push(comment) : replies.set(comment.inReplyToId, [comment]);
  }
  return roots.flatMap((root) => [root, ...(replies.get(root.id) ?? [])]).concat(orphans);
}

/** Compact rail index for comments whose bodies moved into canvas code. The GitHub links remain as
 * a lossless escape hatch when a source response is truncated before the anchored line. */
export function ExistingCommentLinks(props: { comments: readonly PrGitHubComment[] }) {
  if (props.comments.length === 0) {
    return null;
  }
  return (
    <div style={LINK_LIST} data-existing-review-comment-links="true">
      {props.comments.map((comment) => {
        const location = comment.line === null
          ? "Comment"
          : `L${comment.line}${comment.side === "LEFT" ? " · base" : ""}`;
        const label = `${location} · ${comment.author}`;
        return comment.url ? (
          <a
            key={comment.id}
            style={COMMENT_LINK}
            href={comment.url}
            target="_blank"
            rel="noreferrer"
            title="Open comment on GitHub"
          >
            {label}
          </a>
        ) : (
          <span key={comment.id} style={COMMENT_LINK}>{label}</span>
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
const REPLY_COMMENT: React.CSSProperties = { marginLeft: 18, borderLeftColor: "rgba(154,164,178,0.5)", background: "#0F151C" };
const META: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginBottom: 4, minWidth: 0 };
const AUTHOR: React.CSSProperties = { color: "#E6EDF3", fontSize: 11, fontWeight: 650, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const TIME: React.CSSProperties = { color: "#5A6472", fontSize: 9.5, flexShrink: 0 };
const LINE_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(125,211,252,0.35)", borderRadius: 4, padding: "0 4px", color: "#7DD3FC", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 9.5, fontWeight: 700, lineHeight: "14px" };
const SIDE_CHIP: React.CSSProperties = { flexShrink: 0, border: "1px solid rgba(210,153,34,0.42)", borderRadius: 4, padding: "0 4px", color: "#D29922", background: "rgba(210,153,34,0.08)", fontSize: 9, fontWeight: 650, lineHeight: "14px" };
const BODY: React.CSSProperties = { color: "#C9D1D9", fontSize: 11.5, lineHeight: "15px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const ACTIONS: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 5 };
const ACTION: React.CSSProperties = { border: "none", background: "transparent", color: "#7DD3FC", font: "inherit", fontSize: 10.5, padding: "1px 2px", cursor: "pointer", ...NO_FOCUS_RING };
const ACTION_DISABLED: React.CSSProperties = { color: "#5A6472", cursor: "not-allowed", opacity: 0.7 };
const LINK_LIST: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4 };
const COMMENT_LINK: React.CSSProperties = { border: "1px solid #2A3442", borderRadius: 5, background: "#111820", color: "#7DD3FC", padding: "2px 6px", fontSize: 9.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", textDecoration: "none" };
