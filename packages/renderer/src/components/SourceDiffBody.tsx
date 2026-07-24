/**
 * One source-diff adapter and body shared by every source host. Hover cards, inline node panels, and
 * the large modal own only their surrounding chrome and height; this module owns the source slice,
 * diff rows, folding, comments, loading/error states, and deletion fallback. Keeping that projection
 * here prevents a new review affordance from silently inventing a fourth interpretation of the diff.
 */

import { useEffect, useMemo } from "react";
import type { ChangedLineKind, LineRange } from "@meridian/core";
import { nonTextualDiffNotice } from "../derive/nonTextualDiffNotice";
import { anchorableHunks } from "../derive/reviewSubmit";
import { sourceCommentOnlyLines, withoutAddedSourceCommentDiffLines } from "../derive/sourceCommentLines";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { prReviewRevisionKey } from "../state/prReviewFreshness";
import { matchesReviewLineComposerTarget } from "../state/reviewLineComposer";
import type { CodeView } from "../state/store";
import { CodeBlock, type CodeDiffLine, type CodeSourceSide } from "./CodeBlock";
import {
  currentReviewCommentPath,
  useCodeReviewComments,
  useDeletedCodeReviewComments,
  useGitHubCommentableReviewLines,
  usePendingCodeReviewComments,
  usePendingDeletedCodeReviewComments,
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
  /** Current PR/checklist identity. It can differ from `file` while showing a renamed file's BASE. */
  reviewPath: string;
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
  /** Added source-code comment rows omitted by the reader's review preference. */
  hiddenSourceLines: ReadonlySet<number>;
  summary: SourceDiffSummary | null;
  existingComments: ReturnType<typeof useCodeReviewComments>;
  pendingComments: ReturnType<typeof usePendingCodeReviewComments>;
  /** Visible HEAD rows GitHub can anchor inline; every other draftable row attaches to the file. */
  inlineCommentableLines: ReadonlySet<number>;
  /** Every visible HEAD row on which Meridian can preserve a draft. */
  commentableLines: ReadonlySet<number>;
  /** Exact visible BASE lines represented by canonical deletion rows. */
  deletedCommentableLines: ReadonlySet<number>;
  /** Explains which drafts become inline comments versus file-level review comments. */
  reviewCommentScopeNote: string | null;
  removedRows: ReadonlyMap<number, string[]>;
  removedTruncated: boolean;
  /** The manifest proves a file change, but Git supplied no trustworthy line-level body. */
  textualDiffNotice: string | null;
  foldUnchanged: boolean;
}

/** Build the exact presentation model once. Every host must pass this model to SourceDiffBody. */
export function useSourceDiffModel(codeView: CodeView): SourceDiffModel {
  const review = useBlueprint((state) => state.review);
  const reviewFiles = useBlueprint((state) => state.reviewFiles);
  const index = useBlueprint((state) => state.index);
  const hideAddedSourceCommentDiffs = useBlueprint((state) => state.reviewHideAddedSourceCommentDiffs);
  const prReviewed = useBlueprint((state) => state.prReviewed);
  const forceFileComments = useBlueprint((state) => state.prReviewStale
    && (state.prReviewRevision?.headSha ?? null) === null);
  const prReviewRefreshing = useBlueprint((state) => state.prReviewRefreshing);
  const prReviewStatus = useBlueprint((state) => state.prReviewStatus);
  const prReviewFiles = useBlueprint((state) => state.prReviewSource?.files ?? null);
  const file = codeView.node.location.file;
  const reviewPath = useMemo(
    () => currentReviewCommentPath(file, reviewFiles, index.nodesById, codeView.node.id),
    [codeView.node.id, file, index, reviewFiles],
  );
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
  const rawDiffLines = useMemo(
    () => canonicalDiffLines === undefined
      ? undefined
      : diffLinesWithinSlice(canonicalDiffLines, sourceSide, baseLine, shownEnd, diffOldSpan),
    [baseLine, canonicalDiffLines, diffOldSpan, shownEnd, sourceSide],
  );
  const hiddenSourceCommentLines = useMemo(() => {
    if (
      canonicalDiffLines === undefined
      || review === null
      || !hideAddedSourceCommentDiffs
      || sourceSide !== "head"
      || codeView.code === null
    ) {
      return EMPTY_HIDDEN_SOURCE_LINES;
    }
    const commentLines = sourceCommentOnlyLines(file, codeView.code, baseLine);
    return new Set(canonicalDiffLines.flatMap((line) => (
      line.kind === "added"
      && line.newLine !== null
      && commentLines.has(line.newLine)
        ? [line.newLine]
        : []
    )));
  }, [baseLine, canonicalDiffLines, codeView.code, file, hideAddedSourceCommentDiffs, review, sourceSide]);
  const displayCanonicalDiffLines = useMemo(
    () => canonicalDiffLines === undefined
      ? undefined
      : withoutAddedSourceCommentDiffLines(canonicalDiffLines, hiddenSourceCommentLines),
    [canonicalDiffLines, hiddenSourceCommentLines],
  );
  const diffLines = useMemo(
    () => displayCanonicalDiffLines === undefined
      ? undefined
      : diffLinesWithinSlice(displayCanonicalDiffLines, sourceSide, baseLine, shownEnd, diffOldSpan),
    [baseLine, diffOldSpan, displayCanonicalDiffLines, shownEnd, sourceSide],
  );
  const canonicalKinds = useMemo(
    () => diffLines === undefined ? null : canonicalKindsWithinSlice(diffLines, sourceSide),
    [diffLines, sourceSide],
  );
  const changedLineKinds = canonicalKinds ?? codeView.changedLineKinds ?? hookChangedLineKinds;
  const changedLines = useMemo(
    () => {
      const visibleChangedLines = canonicalKinds === null
      ? codeView.changedLines ?? hookChangedLines
        : new Set(canonicalKinds.keys());
      if (hiddenSourceCommentLines.size === 0) return visibleChangedLines;
      return new Set([...visibleChangedLines, ...hiddenSourceCommentLines]);
    },
    [canonicalKinds, codeView.changedLines, hiddenSourceCommentLines, hookChangedLines],
  );
  const rawCanonicalKinds = useMemo(
    () => rawDiffLines === undefined ? null : canonicalKindsWithinSlice(rawDiffLines, sourceSide),
    [rawDiffLines, sourceSide],
  );
  const rawChangedLineKinds = rawCanonicalKinds ?? codeView.changedLineKinds ?? hookChangedLineKinds;
  const rawChangedLines = useMemo(
    () => rawCanonicalKinds === null
      ? codeView.changedLines ?? hookChangedLines
      : new Set(rawCanonicalKinds.keys()),
    [codeView.changedLines, hookChangedLines, rawCanonicalKinds],
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
  const deletedLines = useMemo(() => new Set(
    (diffLines ?? []).flatMap((line) => line.kind === "deleted" && line.oldLine !== null ? [line.oldLine] : []),
  ), [diffLines]);
  const commentCode = sourceSide === "head" ? codeView.code : null;
  const headComments = useCodeReviewComments(file, baseLine, commentCode, sourceLineCount);
  const deletedComments = useDeletedCodeReviewComments(file, deletedLines);
  const existingComments = useMemo(
    () => [...headComments, ...deletedComments],
    [deletedComments, headComments],
  );
  const headDrafts = usePendingCodeReviewComments(file, baseLine, commentCode, sourceLineCount);
  const deletedDrafts = usePendingDeletedCodeReviewComments(file, deletedLines);
  const pendingComments = useMemo(
    () => [...headDrafts, ...deletedDrafts],
    [deletedDrafts, headDrafts],
  );
  const githubCommentableLines = useGitHubCommentableReviewLines(file, baseLine, commentCode, sourceLineCount);
  const githubCommentingReady = prReviewed !== null
    && review !== null
    && !prReviewRefreshing
    && prReviewStatus !== "preparing";
  const textualDiffNotice = review === null ? null : nonTextualDiffNotice(file, prReviewFiles);
  const inlineCommentableLines = useMemo(() => {
    if (review === null || sourceSide === "base") return EMPTY_COMMENTABLE_LINES;
    if (prReviewed !== null && forceFileComments) return EMPTY_COMMENTABLE_LINES;
    if (prReviewed !== null) return githubCommentableLines;
    if (anchorableHunks(file, review.context).length === 0) return EMPTY_COMMENTABLE_LINES;
    // Artifact-only reviews have no GitHub patch headers. These tight raw changed rows remain the
    // inline-safe set even when source-comment-only additions are hidden from the visual diff; all
    // other visible HEAD rows can still attach to the file.
    return rawChangedLineKinds.size > 0
      ? new Set([...rawChangedLineKinds].filter(([, kind]) => kind === "added" || kind === "modified").map(([line]) => line))
      : new Set(rawChangedLines);
  }, [file, forceFileComments, githubCommentableLines, prReviewed, rawChangedLineKinds, rawChangedLines, review, sourceSide]);
  const commentableLines = useMemo(
    () => review === null || sourceSide === "base" || codeView.code === null || sourceLineCount <= 0
      ? EMPTY_COMMENTABLE_LINES
      : visibleSourceLines(baseLine, sourceLineCount),
    [baseLine, codeView.code, review, sourceLineCount, sourceSide],
  );
  const deletedCommentableLines = useMemo(
    () => review === null
      || prReviewRefreshing
      || prReviewStatus === "preparing"
      ? EMPTY_COMMENTABLE_LINES
      : deletedLines,
    [deletedLines, prReviewRefreshing, prReviewStatus, review],
  );
  const reviewCommentScopeNote = useMemo(
    () => githubCommentingReady && sourceSide === "head"
      ? githubLineCommentScopeNote(inlineCommentableLines, sourceLineCount)
      : null,
    [githubCommentingReady, inlineCommentableLines, sourceLineCount, sourceSide],
  );

  return {
    view: codeView,
    reviewPath,
    file,
    baseLine,
    sourceLineCount,
    shownEnd,
    sourceSide,
    diffOldSpan,
    diffLines,
    changedLines,
    changedLineKinds,
    hiddenSourceLines: hiddenSourceCommentLines,
    summary,
    existingComments,
    pendingComments,
    inlineCommentableLines,
    commentableLines,
    deletedCommentableLines,
    reviewCommentScopeNote,
    removedRows,
    removedTruncated: diffLines === undefined && legacyRemovedTruncated,
    textualDiffNotice,
    // unchangedCodeFolds itself requires a focus row, so unchanged review nodes remain fully visible.
    foldUnchanged: review !== null,
  };
}

export function SourceDiffBody({
  model,
  maxHeight,
  evidenceLines = EMPTY_EVIDENCE_LINES,
  focusLines = EMPTY_FOCUS_LINES,
  showGutter,
  onComposerEngage,
}: {
  model: SourceDiffModel;
  maxHeight: number | string;
  evidenceLines?: ReadonlySet<number>;
  /** Presentation-only rows for a hovered structural control. They affect focus/folding, not diffs. */
  focusLines?: ReadonlySet<number>;
  /** Ordinary Logic source may remain gutterless; every active review diff gets the shared gutter. */
  showGutter?: boolean;
  /** Promote a transient host before inserting/focusing the composer can change card geometry. */
  onComposerEngage?: () => void;
}) {
  const reviewKey = useBlueprint((state) => state.review?.context.reviewKey ?? null);
  const lineRevision = useBlueprint((state) => prReviewRevisionKey(state.prReviewRevision));
  const composer = useBlueprint((state) => state.reviewLineComposer);
  const {
    addReviewComment,
    discardReviewLineComposer,
    keepEditingReviewLineComposer,
    openReviewLineComposer,
    requestReviewLineComposerDismiss,
    setReviewLineComposerBody,
  } = useBlueprintActions();
  const activeComposer = composer !== null
    && reviewKey !== null
    && matchesReviewLineComposerTarget(composer, {
      reviewKey,
      lineRevision,
      path: model.file,
      line: composer.line,
      side: composer.side,
    })
    && (composer.side === "LEFT"
      ? model.deletedCommentableLines.has(composer.line)
      : model.commentableLines.has(composer.line))
    ? composer
    : null;
  useEffect(() => {
    if (activeComposer !== null) onComposerEngage?.();
  }, [activeComposer, onComposerEngage]);
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
      {model.reviewCommentScopeNote ? (
        <div
          role="note"
          data-review-comment-scope={model.inlineCommentableLines.size === 0 ? "file-only" : "inline-and-file"}
          title="GitHub accepts inline review comments only on pull-request diff rows; comments on other HEAD lines attach to the file."
          style={COMMENT_SCOPE_NOTE_STYLE}
        >
          {model.reviewCommentScopeNote}
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
          focusLines={focusLines}
          hiddenSourceLines={model.hiddenSourceLines}
          commentableLines={model.commentableLines}
          commentableDeletedLines={model.deletedCommentableLines}
          onLineClick={model.commentableLines.size > 0 || model.deletedCommentableLines.size > 0 ? (line, side) => {
            // Pin synchronously. Waiting for the controlled composer render is late enough for a
            // hover-card leave timer to win when the inserted row moves the pointer outside.
            onComposerEngage?.();
            openReviewLineComposer(model.file, line, side);
          } : undefined}
          lineComposer={activeComposer === null ? null : {
            line: activeComposer.line,
            side: activeComposer.side,
            value: activeComposer.body,
            onValueChange: setReviewLineComposerBody,
            confirmDiscard: activeComposer.confirmDiscard,
            error: activeComposer.error,
            onKeepEditing: keepEditingReviewLineComposer,
            onDiscard: discardReviewLineComposer,
            onAdd: (body) => {
              addReviewComment(model.reviewPath, null, body, activeComposer.line, activeComposer.side);
              discardReviewLineComposer();
            },
            onCancel: () => {
              requestReviewLineComposerDismiss();
            },
          }}
          existingComments={model.existingComments}
          pendingComments={model.pendingComments}
          removedRows={model.removedRows}
          removedTruncated={model.removedTruncated}
          foldUnchanged={model.foldUnchanged}
          diffLines={model.diffLines}
          sourceSide={model.sourceSide}
          language={model.view.node.language}
          sourceFile={model.file}
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

/** Compact the visible GitHub-safe rows into an exact inline-versus-file explanation. */
export function githubLineCommentScopeNote(
  commentableLines: ReadonlySet<number>,
  visibleLineCount: number,
): string | null {
  if (visibleLineCount <= 0 || commentableLines.size >= visibleLineCount) return null;
  if (commentableLines.size === 0) {
    return "Comments on current lines in this preview will attach to the file";
  }
  return `${formatLineRanges(commentableLines)} can be inline on current code · comments on other current lines attach to the file`;
}

function visibleSourceLines(baseLine: number, lineCount: number): ReadonlySet<number> {
  const lines = new Set<number>();
  for (let offset = 0; offset < lineCount; offset += 1) {
    lines.add(baseLine + offset);
  }
  return lines;
}

function formatLineRanges(lines: ReadonlySet<number>): string {
  const sorted = [...lines].sort((left, right) => left - right);
  if (sorted.length === 0) return "";
  const labels: string[] = [];
  let start = sorted[0]!;
  let end = start;
  for (let index = 1; index < sorted.length; index += 1) {
    const line = sorted[index]!;
    if (line === end + 1) {
      end = line;
      continue;
    }
    labels.push(start === end ? `L${start}` : `L${start}–L${end}`);
    start = line;
    end = line;
  }
  labels.push(start === end ? `L${start}` : `L${start}–L${end}`);
  const visible = labels.slice(0, 2);
  const hidden = labels.length - visible.length;
  return hidden > 0 ? `${visible.join(", ")} +${hidden} more` : visible.join(", ");
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
const EMPTY_HIDDEN_SOURCE_LINES: ReadonlySet<number> = new Set<number>();
const EMPTY_FOCUS_LINES: ReadonlySet<number> = new Set<number>();
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
const COMMENT_SCOPE_NOTE_STYLE: React.CSSProperties = {
  boxSizing: "border-box",
  padding: "5px 9px",
  borderBottom: "1px solid rgba(56,139,253,0.18)",
  background: "rgba(56,139,253,0.055)",
  color: "#91A5BC",
  fontSize: 10.5,
  lineHeight: "15px",
  maxHeight: 45,
  overflow: "hidden",
};
const TRUNCATED_STYLE: React.CSSProperties = { padding: "6px 12px", color: "#8B949E", fontSize: 10 };
