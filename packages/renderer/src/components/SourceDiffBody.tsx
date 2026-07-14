/**
 * One source-diff adapter and body shared by every source host. Hover cards, inline node panels, and
 * the large modal own only their surrounding chrome and height; this module owns the source slice,
 * diff rows, folding, comments, loading/error states, and deletion fallback. Keeping that projection
 * here prevents a new review affordance from silently inventing a fourth interpretation of the diff.
 */

import { useEffect, useMemo, useState } from "react";
import type { ChangedLineKind, LineRange } from "@meridian/core";
import { nonTextualDiffNotice } from "../derive/nonTextualDiffNotice";
import { anchorableHunks } from "../derive/reviewSubmit";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { CodeView } from "../state/store";
import { CodeBlock, type CodeDiffLine, type CodeSourceSide } from "./CodeBlock";
import {
  useCodeReviewComments,
  useGitHubCommentableReviewLines,
  usePendingCodeReviewComments,
} from "./review/useCodeReviewComments";
import { summarizeChangeKinds, useChangeSummary, useChangedLines, useLineChangeKinds } from "./useChangedLines";

type DiffCapableCodeView = CodeView & {
  /** Canonical display rows supplied by the merge-base diff pipeline. */
  diffLines?: readonly CodeDiffLine[];
  /** Removed files are fetched from BASE; every matching source row is itself a deletion. */
  sourceSide?: CodeSourceSide;
  /** Exact comparison-side declaration boundary used to attribute deleted rows. */
  diffOldSpan?: LineRange | null;
};

export interface SourceDiffSummary {
  added: number;
  deleted: number;
  touched: number;
}

export interface SourceDiffModel {
  view: CodeView;
  file: string;
  baseLine: number;
  /** Exact visible source rows; zero means the loaded source is truly empty. */
  sourceLineCount: number;
  shownEnd: number;
  sourceSide: CodeSourceSide;
  diffOldSpan: LineRange | null | undefined;
  diffLines: readonly CodeDiffLine[] | undefined;
  changedLines: ReadonlySet<number>;
  changedLineKinds: ReadonlyMap<number, ChangedLineKind>;
  summary: SourceDiffSummary | null;
  existingComments: ReturnType<typeof useCodeReviewComments>;
  pendingComments: ReturnType<typeof usePendingCodeReviewComments>;
  commentableLines: ReadonlySet<number>;
  removedRows: ReadonlyMap<number, string[]>;
  removedTruncated: boolean;
  /** The manifest proves a file change, but Git supplied no trustworthy line-level body. */
  textualDiffNotice: string | null;
  foldUnchanged: boolean;
}

/** Build the exact presentation model once. Every host must pass this model to SourceDiffBody. */
export function useSourceDiffModel(codeView: CodeView): SourceDiffModel {
  const review = useBlueprint((state) => state.review);
  const prReviewed = useBlueprint((state) => state.prReviewed);
  const prReviewFiles = useBlueprint((state) => state.prReviewSource?.files ?? null);
  const file = codeView.node.location.file;
  const legacyRemoved = useBlueprint((state) => state.reviewRemovedByFile[file] ?? EMPTY_REMOVED);
  const legacyRemovedTruncated = useBlueprint((state) => state.reviewRemovedTruncatedByFile[file] === true);
  const wholeFile = codeView.wholeFile ?? false;
  const hookChangedLines = useChangedLines(codeView.node, wholeFile);
  const hookChangedLineKinds = useLineChangeKinds(codeView.node, wholeFile);
  const hookSummary = useChangeSummary(codeView.node, wholeFile);
  const baseLine = codeView.baseLine ?? codeView.node.location.startLine;
  const sourceLineCount = codeView.code === null ? 0 : codeView.lineCount ?? codeView.code.split("\n").length;
  const shownEnd = baseLine + sourceLineCount - 1;
  const diffView = codeView as DiffCapableCodeView;
  // `undefined` means the old projection is in use. An empty canonical array is authoritative and
  // must suppress legacy removed/kind data just as strongly as a non-empty one.
  const canonicalDiffLines = Array.isArray(diffView.diffLines) ? diffView.diffLines : undefined;
  const sourceSide = diffView.sourceSide ?? "head";
  const diffOldSpan = diffView.diffOldSpan;
  const diffLines = useMemo(
    () => canonicalDiffLines === undefined
      ? undefined
      : diffLinesWithinSlice(canonicalDiffLines, sourceSide, baseLine, shownEnd, diffOldSpan),
    [baseLine, canonicalDiffLines, diffOldSpan, shownEnd, sourceSide],
  );
  const canonicalKinds = useMemo(
    () => diffLines === undefined ? null : canonicalKindsWithinSlice(diffLines, sourceSide),
    [diffLines, sourceSide],
  );
  const changedLineKinds = canonicalKinds ?? codeView.changedLineKinds ?? hookChangedLineKinds;
  const changedLines = useMemo(
    () => canonicalKinds === null
      ? codeView.changedLines ?? hookChangedLines
      : new Set(canonicalKinds.keys()),
    [canonicalKinds, codeView.changedLines, hookChangedLines],
  );
  const summary = diffLines === undefined
    ? codeView.changedLineKinds ? summarizeChangeKinds(codeView.changedLineKinds) : hookSummary
    : summarizeDiffLines(diffLines);
  const removedRows = useMemo(() => {
    if (diffLines !== undefined) return EMPTY_REMOVED_ROWS;
    const rows = new Map<number, string[]>();
    for (const entry of legacyRemoved) {
      // Legacy rows are keyed AFTER the previous HEAD line. Include baseLine-1 so a replacement at
      // the first visible source line is emitted before that line instead of disappearing.
      if (entry.afterNewLine < baseLine - 1 || entry.afterNewLine > shownEnd) continue;
      const bucket = rows.get(entry.afterNewLine);
      bucket ? bucket.push(...entry.lines) : rows.set(entry.afterNewLine, [...entry.lines]);
    }
    return rows;
  }, [baseLine, diffLines, legacyRemoved, shownEnd]);
  const commentCode = sourceSide === "head" ? codeView.code : null;
  const existingComments = useCodeReviewComments(file, baseLine, commentCode, sourceLineCount);
  const pendingComments = usePendingCodeReviewComments(file, baseLine, commentCode, sourceLineCount);
  const githubCommentableLines = useGitHubCommentableReviewLines(file, baseLine, commentCode, sourceLineCount);
  const commentableLines = useMemo(() => {
    if (review === null || sourceSide === "base") return EMPTY_COMMENTABLE_LINES;
    if (prReviewed !== null) return githubCommentableLines;
    if (anchorableHunks(file, review.context).length === 0) return EMPTY_COMMENTABLE_LINES;
    // Artifact-only reviews have no GitHub comment range. Offer only actual shown HEAD additions.
    return changedLineKinds.size > 0
      ? new Set([...changedLineKinds].filter(([, kind]) => kind === "added" || kind === "modified").map(([line]) => line))
      : new Set(changedLines);
  }, [changedLineKinds, changedLines, file, githubCommentableLines, prReviewed, review, sourceSide]);

  return {
    view: codeView,
    file,
    baseLine,
    sourceLineCount,
    shownEnd,
    sourceSide,
    diffOldSpan,
    diffLines,
    changedLines,
    changedLineKinds,
    summary,
    existingComments,
    pendingComments,
    commentableLines,
    removedRows,
    removedTruncated: diffLines === undefined && legacyRemovedTruncated,
    textualDiffNotice: review === null ? null : nonTextualDiffNotice(file, prReviewFiles),
    // unchangedCodeFolds itself requires a focus row, so unchanged review nodes remain fully visible.
    foldUnchanged: review !== null,
  };
}

export function SourceDiffBody({
  model,
  maxHeight,
  evidenceLines = EMPTY_EVIDENCE_LINES,
  showGutter,
}: {
  model: SourceDiffModel;
  maxHeight: number | string;
  evidenceLines?: ReadonlySet<number>;
  /** Ordinary Logic source may remain gutterless; every active review diff gets the shared gutter. */
  showGutter?: boolean;
}) {
  const { addReviewComment } = useBlueprintActions();
  const [activeCommentLine, setActiveCommentLine] = useState<number | null>(null);
  useEffect(() => setActiveCommentLine(null), [model.view.node.id, model.baseLine]);
  const { code, error, loading, truncated } = model.view;
  return (
    <div data-source-diff-body="true">
      {loading ? <div style={STATUS_STYLE}>Loading source…</div> : null}
      {error ? <div style={ERROR_STYLE}>{error}</div> : null}
      {model.textualDiffNotice ? (
        <div role="status" data-non-textual-diff="true" style={NON_TEXTUAL_DIFF_STYLE}>
          {model.textualDiffNotice}
        </div>
      ) : null}
      {code !== null ? (
        <CodeBlock
          key={sourceDiffInstanceKey(model)}
          code={code}
          lineCount={model.sourceLineCount}
          maxHeight={maxHeight}
          startLine={model.baseLine}
          showGutter={model.foldUnchanged || showGutter}
          changedLines={model.changedLines}
          changedLineKinds={model.changedLineKinds}
          evidenceLines={evidenceLines}
          commentableLines={model.commentableLines}
          onLineClick={model.commentableLines.size > 0 ? setActiveCommentLine : undefined}
          lineComposer={activeCommentLine === null || !model.commentableLines.has(activeCommentLine) ? null : {
            line: activeCommentLine,
            onAdd: (body) => addReviewComment(model.file, null, body, activeCommentLine),
            onCancel: () => setActiveCommentLine(null),
          }}
          existingComments={model.existingComments}
          pendingComments={model.pendingComments}
          removedRows={model.removedRows}
          removedTruncated={model.removedTruncated}
          foldUnchanged={model.foldUnchanged}
          diffLines={model.diffLines}
          sourceSide={model.sourceSide}
        />
      ) : null}
      {truncated ? <div style={TRUNCATED_STYLE}>Snippet truncated by the server.</div> : null}
    </div>
  );
}

/** A source switch must remount the stateful diff table so an expanded fold from one file, side,
 * or fetched slice cannot survive into another source that happens to have the same fold shape. */
export function sourceDiffInstanceKey(model: {
  view: Pick<CodeView, "node">;
  file: string;
  baseLine: number;
  shownEnd: number;
  sourceSide: CodeSourceSide;
  diffOldSpan?: LineRange | null;
}): string {
  const oldScope = model.diffOldSpan === undefined
    ? "cursor"
    : model.diffOldSpan === null
      ? "no-base-counterpart"
      : `${model.diffOldSpan.start}-${model.diffOldSpan.end}`;
  return [model.view.node.id, model.file, model.baseLine, model.shownEnd, model.sourceSide, oldScope].join(":");
}

/** Clip canonical rows to the shown source while retaining deletes immediately before the first row
 * and immediately after the last row. BASE source can only display its exact deleted old lines. */
export function diffLinesWithinSlice(
  lines: readonly CodeDiffLine[],
  sourceSide: CodeSourceSide,
  startLine: number,
  endLine: number,
  diffOldSpan?: LineRange | null,
): CodeDiffLine[] {
  return lines.filter((line) => {
    if (sourceSide === "base") {
      return line.kind === "deleted"
        && line.oldLine !== null
        && line.oldLine >= startLine
        && line.oldLine <= endLine;
    }
    if (line.kind === "added") {
      return line.newLine !== null && line.newLine >= startLine && line.newLine <= endLine;
    }
    if (line.beforeNewLine < startLine || line.beforeNewLine > endLine + 1) {
      return false;
    }
    // `beforeNewLine === endLine + 1` is necessary for a real EOF deletion, but at an adjacent
    // declaration boundary it also points at the next declaration. When comparison pairing is
    // available, oldLine is the only exact ownership coordinate. A proven added declaration has a
    // null span and must not borrow any old-side row. Undefined retains legacy/file-level behavior.
    return diffOldSpan === undefined
      || (diffOldSpan !== null
        && line.oldLine !== null
        && line.oldLine >= diffOldSpan.start
        && line.oldLine <= diffOldSpan.end);
  });
}

function canonicalKindsWithinSlice(
  lines: readonly CodeDiffLine[],
  sourceSide: CodeSourceSide,
): ReadonlyMap<number, ChangedLineKind> {
  const kinds = new Map<number, ChangedLineKind>();
  for (const line of lines) {
    const sourceLine = sourceSide === "base" ? line.oldLine : line.kind === "added" ? line.newLine : null;
    if (sourceLine !== null) kinds.set(sourceLine, line.kind === "added" ? "added" : "deleted");
  }
  return kinds;
}

function summarizeDiffLines(lines: readonly CodeDiffLine[]): SourceDiffSummary | null {
  let added = 0;
  let deleted = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    else deleted += 1;
  }
  return added === 0 && deleted === 0 ? null : { added, deleted, touched: added + deleted };
}

const EMPTY_COMMENTABLE_LINES: ReadonlySet<number> = new Set<number>();
const EMPTY_EVIDENCE_LINES: ReadonlySet<number> = new Set<number>();
const EMPTY_REMOVED: readonly { afterNewLine: number; lines: string[] }[] = [];
const EMPTY_REMOVED_ROWS: ReadonlyMap<number, string[]> = new Map<number, string[]>();
const STATUS_STYLE: React.CSSProperties = { padding: 16, color: "#8B949E", fontSize: 12 };
const ERROR_STYLE: React.CSSProperties = { ...STATUS_STYLE, color: "#FCA5A5" };
const NON_TEXTUAL_DIFF_STYLE: React.CSSProperties = {
  margin: "0 0 8px",
  padding: "7px 9px",
  border: "1px solid rgba(210,153,34,0.45)",
  borderRadius: 5,
  background: "rgba(210,153,34,0.08)",
  color: "#D7B56D",
  fontSize: 10.5,
  lineHeight: "15px",
};
const TRUNCATED_STYLE: React.CSSProperties = { padding: "6px 12px", color: "#8B949E", fontSize: 10 };
