export interface ReviewCommentNodePreview {
  key: string;
  kind: "draft" | "existing";
  body: string;
  author: string;
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  lineStale: boolean;
  url: string | null;
}

type ReviewCommentLine = Pick<ReviewCommentNodePreview, "startLine" | "startSide" | "line" | "side"> & {
  lineStale?: boolean;
};

/** Human-readable range only; terminal `line` remains the anchor used for placement and ownership. */
export function reviewCommentLineRangeLabel(comment: Pick<ReviewCommentLine, "startLine" | "line">): string | null {
  if (comment.line === null) return null;
  return comment.startLine !== undefined && comment.startLine !== comment.line
    ? `L${comment.startLine}–L${comment.line}`
    : `L${comment.line}`;
}

export function reviewCommentLineLabel(comment: ReviewCommentLine): string | null {
  const range = reviewCommentLineRangeLabel(comment);
  if (range === null) return null;
  const crossesSides = comment.startLine !== undefined
    && comment.startSide !== undefined
    && comment.side !== null
    && comment.startSide !== comment.side;
  if (crossesSides) {
    return [
      `${lineAndSideLabel(comment.startLine!, comment.startSide!)} → ${lineAndSideLabel(comment.line!, comment.side!)}`,
      comment.lineStale ? "previous revision" : null,
    ].filter((part): part is string => part !== null).join(" · ");
  }
  return [
    range,
    comment.side === "LEFT" ? "base" : null,
    comment.lineStale ? "previous revision" : null,
  ].filter((part): part is string => part !== null).join(" · ");
}

function lineAndSideLabel(line: number, side: "LEFT" | "RIGHT"): string {
  return `L${line}${side === "LEFT" ? " · base" : ""}`;
}
