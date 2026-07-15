/**
 * A tiny, dependency-free TS/JS syntax highlighter. A real grammar (Prism/Shiki) would pull a
 * package, but the build must work offline — so a single regex splits source into comments,
 * strings, numbers and keywords, and everything else stays the default light colour. It is
 * deliberately approximate (one JS/TS-ish tokenizer for the whole codebase, no per-line-vs-regex
 * disambiguation) yet must NEVER throw: any tokenizing edge case falls back to the raw text, which
 * React still escapes as a plain string child.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ChangedDiffLine, ChangedLineKind } from "@meridian/core";
import type { PrGitHubComment } from "../state/prTypes";
import type { ReviewComment } from "../state/reviewTicksPref";
import { ExistingCommentList } from "./review/ExistingReviewComments";
import { CommentComposer, CommentList } from "./review/ReviewComments";
import { unchangedCodeFoldKey, unchangedCodeFolds } from "./codeFolding";
import { UnchangedCodeFoldRow } from "./UnchangedCodeFoldRow";

/** One canonical unified-diff row. Added rows live in the shown HEAD source; deleted rows retain
 * their BASE text and are inserted immediately before `beforeNewLine`. Both line coordinates are
 * explicit so tests and accessibility tooling never have to infer diff semantics from colour. */
export type CodeDiffLine = ChangedDiffLine;

export type CodeSourceSide = "head" | "base";

const COLOR = {
  plain: "#C9D3E0",
  comment: "#6A9955", // muted green — reads as "not code"
  string: "#E5C07B", // amber
  keyword: "#C678DD", // violet
  number: "#56B6C2", // teal
} as const;

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "class", "new",
  "await", "async", "import", "from", "export", "type", "interface", "extends", "implements", "try",
  "catch", "finally", "switch", "case", "default", "throw", "typeof", "instanceof", "this", "super",
  "in", "of", "void", "delete", "yield", "break", "continue", "enum", "namespace", "as", "is",
  "public", "private", "protected", "readonly", "static", "get", "set", "true", "false", "null",
  "undefined", "abstract", "declare", "keyof", "satisfies", "infer",
]);

// One left-to-right pass, longest-construct-first: comments and strings are matched WHOLE before
// numbers/identifiers, so a keyword-like word inside a string or comment is never re-coloured, and
// matching a full identifier stops `constant` from lighting up its `const` prefix.
const TOKEN_RE =
  /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`)|("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)/g;

type Piece = { text: string; color: string };

// Walk the regex matches, emitting the untokenized gaps between them as plain pieces so no
// character is dropped. Group 7 is an identifier — only keyword when it is in the reserved set.
function tokenize(code: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (let m = TOKEN_RE.exec(code); m !== null; m = TOKEN_RE.exec(code)) {
    if (m.index > last) {
      pieces.push({ text: code.slice(last, m.index), color: COLOR.plain });
    }
    pieces.push({ text: m[0], color: colorFor(m) });
    last = TOKEN_RE.lastIndex;
  }
  if (last < code.length) {
    pieces.push({ text: code.slice(last), color: COLOR.plain });
  }
  return pieces;
}

function colorFor(m: RegExpExecArray): string {
  if (m[1] !== undefined || m[2] !== undefined) return COLOR.comment;
  if (m[3] !== undefined || m[4] !== undefined || m[5] !== undefined) return COLOR.string;
  if (m[6] !== undefined) return COLOR.number;
  if (m[7] !== undefined) return KEYWORDS.has(m[7]) ? COLOR.keyword : COLOR.plain;
  return COLOR.plain;
}

export function CodeBlock({
  code,
  lineCount,
  maxHeight = 220,
  startLine,
  showGutter = false,
  changedLines,
  changedLineKinds,
  evidenceLines,
  onLineClick,
  commentableLines,
  lineComposer,
  existingComments = EMPTY_EXISTING_COMMENTS,
  pendingComments = EMPTY_PENDING_COMMENTS,
  removedRows,
  removedTruncated = false,
  foldUnchanged = false,
  diffLines,
  sourceSide = "head",
}: {
  code: string;
  /** Exact source rows represented by `code`; zero prevents an empty string becoming a fake line 1. */
  lineCount?: number;
  maxHeight?: number | string;
  /** The span's absolute first line. Anchors the diff paint (rows map to `changedLineKinds`) and the
   * scroll-to-first-change; independent of the gutter. Omitted → a plain listing, no diff paint. */
  startLine?: number;
  /** Render the right-aligned line-number gutter (needs `startLine`). Off → coloured rows, no numbers. */
  showGutter?: boolean;
  /** Absolute line numbers the diff touched — their gutter numbers go amber (needs the gutter). */
  changedLines?: ReadonlySet<number>;
  /** Per-line change kinds (`added`/`modified`/`deleted`) for colored backgrounds/gutter markers. */
  changedLineKinds?: ReadonlyMap<number, ChangedLineKind>;
  /** Absolute source rows that prove the selected graph edge. Styled independently from PR diffs. */
  evidenceLines?: ReadonlySet<number>;
  /** Opens the controlled line composer. Only the gutter affordance invokes this callback. */
  onLineClick?: (line: number) => void;
  /** Absolute HEAD-side lines allowed to host a RIGHT-side review comment. */
  commentableLines?: ReadonlySet<number>;
  /** The panel-owned composer shown immediately below its absolute source row. */
  lineComposer?: { line: number; onAdd: (body: string) => void; onCancel: () => void } | null;
  /** Existing GitHub RIGHT-side comments already filtered to this visible file slice. */
  existingComments?: readonly PrGitHubComment[];
  /** Fresh local line drafts already filtered to this visible file slice. */
  pendingComments?: readonly ReviewComment[];
  /** Removed patch text, grouped by the absolute new-side line emitted immediately before it. */
  removedRows?: ReadonlyMap<number, string[]>;
  /** The patch parser hit its per-file removed-line cap. */
  removedTruncated?: boolean;
  /** Collapse large unchanged gaps around review changes, preserving three context rows. */
  foldUnchanged?: boolean;
  /** Canonical display rows from the merge-base diff. Presence wins over legacy changed-kind and
   * removed-row projections, including when the array is empty. */
  diffLines?: readonly CodeDiffLine[];
  /** Which revision `code` belongs to. Removed-file fallbacks show BASE rows directly as deletes. */
  sourceSide?: CodeSourceSide;
}) {
  // Reset the shared regex's lastIndex per run (it is stateful with the `g` flag) and never let a
  // tokenizing surprise blank the panel — fall back to the raw, still-escaped source.
  const pieces = useMemo(() => {
    try {
      TOKEN_RE.lastIndex = 0;
      return tokenize(code);
    } catch {
      return [{ text: code, color: COLOR.plain }];
    }
  }, [code]);
  const highlightedLines = useMemo(
    () => lineCount === 0 ? [] : splitHighlightedLines(pieces),
    [lineCount, pieces],
  );
  const existingCommentsByLine = useMemo(() => {
    const byLine = new Map<number, PrGitHubComment[]>();
    for (const comment of existingComments) {
      if (comment.line === null) continue;
      const bucket = byLine.get(comment.line);
      bucket ? bucket.push(comment) : byLine.set(comment.line, [comment]);
    }
    return byLine;
  }, [existingComments]);
  const pendingCommentsByLine = useMemo(() => {
    const byLine = new Map<number, ReviewComment[]>();
    for (const comment of pendingComments) {
      if (comment.line === null) continue;
      const bucket = byLine.get(comment.line);
      bucket ? bucket.push(comment) : byLine.set(comment.line, [comment]);
    }
    return byLine;
  }, [pendingComments]);
  const canonicalRows = useMemo(
    () => diffLines === undefined || startLine === undefined
      ? null
      : canonicalRowsForSource(diffLines, sourceSide, startLine, highlightedLines.length),
    [diffLines, highlightedLines.length, sourceSide, startLine],
  );
  const effectiveRemovedRows = diffLines === undefined ? removedRows : undefined;
  const effectiveRemovedTruncated = diffLines === undefined ? removedTruncated : false;
  const unchangedFolds = useMemo(() => {
    if (!foldUnchanged || startLine === undefined) return [];
    const focus = foldFocus({
      changedLines,
      changedLineKinds,
      evidenceLines,
      existingCommentsByLine,
      pendingCommentsByLine,
      composerLine: lineComposer?.line,
      removedRows: effectiveRemovedRows,
      diffLines,
      sourceSide,
    });
    return unchangedCodeFolds({
      startLine,
      lineCount: highlightedLines.length,
      focusLines: focus.lines,
      focusGaps: focus.gaps,
    });
  }, [
    changedLines,
    changedLineKinds,
    evidenceLines,
    existingCommentsByLine,
    foldUnchanged,
    highlightedLines.length,
    lineComposer?.line,
    pendingCommentsByLine,
    effectiveRemovedRows,
    diffLines,
    sourceSide,
    startLine,
  ]);
  const foldSignature = unchangedFolds.map(unchangedCodeFoldKey).join(",");
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(new Set());
  useEffect(() => setExpandedFolds(new Set()), [code, foldSignature]);
  const foldsByStart = new Map(unchangedFolds.map((fold) => [fold.startLine, fold]));
  const collapsedLines = new Set<number>();
  for (const fold of unchangedFolds) {
    if (expandedFolds.has(unchangedCodeFoldKey(fold))) continue;
    for (let line = fold.startLine; line <= fold.endLine; line += 1) collapsedLines.add(line);
  }
  const listingRef = useRef<HTMLDivElement>(null);
  // Edge evidence is the reader's explicit target, so it wins the initial scroll position. A
  // regular source panel still lands on its first diff as before.
  useEffect(() => {
    const container = listingRef.current;
    if (!container || startLine === undefined) {
      return;
    }
    const firstFocus = firstFocusedLine(evidenceLines, changedLineKinds, changedLines);
    if (firstFocus === null) {
      return;
    }
    const row = container.querySelector<HTMLTableRowElement>(`tr[data-source-line="${firstFocus}"]`);
    container.scrollTop = Math.max(0, (row?.offsetTop ?? (firstFocus - startLine) * LINE_HEIGHT_PX) - 3 * LINE_HEIGHT_PX);
  }, [code, startLine, changedLines, changedLineKinds, evidenceLines, existingCommentsByLine, pendingCommentsByLine]);
  // GitHub reveals its line-comment affordance when the pointer is anywhere on the source row.
  // Restricting this to the narrow gutter made the control effectively undiscoverable while
  // reading/selecting code, especially in the modal and compact hover preview.
  const [hoveredLine, setHoveredLine] = useState<number | null>(null);
  if (startLine === undefined) {
    return <pre style={{ ...PRE_STYLE, maxHeight }}>{renderHighlightedLines(highlightedLines)}</pre>;
  }
  // A known startLine maps the diff kinds onto ROWS (coloured backgrounds + inset bar) regardless of
  // the gutter — so a logic-flow panel with no line numbers still paints its added/deleted lines.
  // The row table owns both scroll axes, while sticky gutter cells keep line numbers in view. Each
  // source row and its optional composer share one table, so inserting a composer or ghost row can
  // never desynchronise independently-rendered code and gutter columns.
  const hasCommentableLines = (commentableLines?.size ?? 0) > 0 && onLineClick !== undefined;
  const showReviewGutter = hasCommentableLines
    || (effectiveRemovedRows?.size ?? 0) > 0
    || effectiveRemovedTruncated
    || (canonicalRows?.deletedByBeforeLine.size ?? 0) > 0
    || (sourceSide === "base" && (canonicalRows?.sourceRows.size ?? 0) > 0);
  const gutterVisible = showGutter || showReviewGutter;
  const firstLine = startLine;
  const lastLine = startLine + highlightedLines.length - 1;
  return (
    <div ref={listingRef} style={{ ...LISTING_STYLE, maxHeight }}>
      <table style={CODE_TABLE_STYLE}>
        <tbody>
          {canonicalRows?.deletedByBeforeLine.get(firstLine)?.map((line) => (
            <GhostRow key={diffRowKey(line)} line={line} showGutter={gutterVisible} />
          ))}
          {effectiveRemovedRows?.get(firstLine - 1)?.map((line, index) => (
            <GhostRow key={`removed-${firstLine - 1}-${index}`} text={line} showGutter={gutterVisible} />
          ))}
          {highlightedLines.map((line, index) => {
            const lineNo = startLine + index;
            const fold = foldsByStart.get(lineNo);
            const foldKey = fold === undefined ? null : unchangedCodeFoldKey(fold);
            const foldExpanded = foldKey !== null && expandedFolds.has(foldKey);
            if (collapsedLines.has(lineNo)) {
              return fold === undefined ? null : (
                <UnchangedCodeFoldRow
                  key={`fold-${unchangedCodeFoldKey(fold)}`}
                  fold={fold}
                  expanded={false}
                  gutterVisible={gutterVisible}
                  onToggle={() => setExpandedFolds((current) => new Set(current).add(unchangedCodeFoldKey(fold)))}
                />
              );
            }
            const canonicalRow = canonicalRows?.sourceRows.get(lineNo);
            const kind = canonicalRow
              ? canonicalRow.kind === "added" ? "added" : "deleted"
              : diffLines === undefined ? changedLineKinds?.get(lineNo) : undefined;
            const changed = diffLines === undefined && (changedLines?.has(lineNo) ?? false);
            const evidence = evidenceLines?.has(lineNo) ?? false;
            const commentable = onLineClick !== undefined && (commentableLines?.has(lineNo) ?? false);
            const composerOpen = lineComposer?.line === lineNo;
            const lineComments = existingCommentsByLine.get(lineNo) ?? EMPTY_EXISTING_COMMENTS;
            const lineDrafts = pendingCommentsByLine.get(lineNo) ?? EMPTY_PENDING_COMMENTS;
            return (
              <Fragment key={`line-${lineNo}`}>
                {fold && foldExpanded ? (
                  <UnchangedCodeFoldRow
                    fold={fold}
                    expanded
                    gutterVisible={gutterVisible}
                    onToggle={() => setExpandedFolds((current) => {
                      const next = new Set(current);
                      next.delete(unchangedCodeFoldKey(fold));
                      return next;
                    })}
                  />
                ) : null}
                <tr
                  data-source-line={lineNo}
                  data-diff-origin={canonicalRow?.kind === "added" ? "add" : canonicalRow?.kind === "deleted" ? "delete" : undefined}
                  data-old-line={canonicalRow?.kind === "deleted" ? canonicalRow.oldLine ?? undefined : undefined}
                  data-new-line={canonicalRow?.kind === "added" ? canonicalRow.newLine ?? undefined : undefined}
                  data-before-new-line={canonicalRow?.beforeNewLine}
                  data-no-newline={canonicalRow?.noNewline ? "true" : undefined}
                  aria-label={canonicalDiffAriaLabel(canonicalRow)}
                  data-edge-evidence-line={evidence ? "true" : undefined}
                  data-review-comment-line={commentable ? lineNo : undefined}
                  onMouseEnter={() => setHoveredLine(lineNo)}
                  onMouseLeave={() => setHoveredLine((current) => current === lineNo ? null : current)}
                >
                  {gutterVisible ? (
                    <td style={GUTTER_CELL_STYLE}>
                      <div style={GUTTER_CONTENT_STYLE}>
                        {commentable ? (
                          <button
                            type="button"
                            style={{
                              ...LINE_COMMENT_BUTTON_STYLE,
                              visibility: hoveredLine === lineNo || composerOpen ? "visible" : "hidden",
                            }}
                            aria-label={`Comment on line ${lineNo}`}
                            title={`Comment on line ${lineNo}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onLineClick(lineNo);
                            }}
                          >
                            +
                          </button>
                        ) : null}
                        <span
                          aria-hidden="true"
                          style={kind ? kindGutterStyle(kind) : evidence ? EVIDENCE_GUTTER_STYLE : changed ? CHANGED_LINE_STYLE : undefined}
                        >
                          {lineMarker(kind, changed, evidence)}
                          {lineNo}
                        </span>
                      </div>
                    </td>
                  ) : null}
                  <td style={{ ...CODE_CELL_STYLE, ...(lineRowStyle(kind) ?? {}), ...(evidence ? EVIDENCE_ROW_STYLE : {}) }}>
                    {line.length > 0 ? line : " "}
                  </td>
                </tr>
                {canonicalRow?.noNewline ? (
                  <NoNewlineMarkerRow side={canonicalRow.kind === "added" ? "new" : "old"} showGutter={gutterVisible} />
                ) : null}
                {lineComments.length > 0 ? (
                  <tr data-existing-review-comments-line={lineNo}>
                    <td colSpan={gutterVisible ? 2 : 1} style={EXISTING_COMMENT_CELL_STYLE}>
                      <ExistingCommentList comments={lineComments} />
                    </td>
                  </tr>
                ) : null}
                {lineDrafts.length > 0 ? (
                  <tr data-pending-review-comments-line={lineNo}>
                    <td colSpan={gutterVisible ? 2 : 1} style={PENDING_COMMENT_CELL_STYLE}>
                      <CommentList comments={lineDrafts} placement="code" />
                    </td>
                  </tr>
                ) : null}
                {composerOpen ? (
                  <tr>
                    <td colSpan={gutterVisible ? 2 : 1} style={COMPOSER_CELL_STYLE}>
                      <CommentComposer
                        key={lineNo}
                        placeholder={`Comment on line ${lineNo}…`}
                        onAdd={lineComposer.onAdd}
                        onCancel={lineComposer.onCancel}
                        stopEscape
                      />
                    </td>
                  </tr>
                ) : null}
                {effectiveRemovedRows?.get(lineNo)?.map((removedLine, removedIndex) => (
                  <GhostRow
                    key={`removed-${lineNo}-${removedIndex}`}
                    text={removedLine}
                    showGutter={gutterVisible}
                  />
                ))}
                {lineNo < lastLine ? canonicalRows?.deletedByBeforeLine.get(lineNo + 1)?.map((deletedLine) => (
                  <GhostRow key={diffRowKey(deletedLine)} line={deletedLine} showGutter={gutterVisible} />
                )) : null}
              </Fragment>
            );
          })}
          {highlightedLines.length > 0 ? canonicalRows?.deletedByBeforeLine.get(lastLine + 1)?.map((line) => (
            <GhostRow key={diffRowKey(line)} line={line} showGutter={gutterVisible} />
          )) : null}
          {effectiveRemovedTruncated ? (
            <GhostRow text="… removed lines truncated" showGutter={gutterVisible} marker />
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function foldFocus(options: {
  changedLines?: ReadonlySet<number>;
  changedLineKinds?: ReadonlyMap<number, ChangedLineKind>;
  evidenceLines?: ReadonlySet<number>;
  existingCommentsByLine: ReadonlyMap<number, readonly PrGitHubComment[]>;
  pendingCommentsByLine: ReadonlyMap<number, readonly ReviewComment[]>;
  composerLine?: number;
  removedRows?: ReadonlyMap<number, string[]>;
  diffLines?: readonly CodeDiffLine[];
  sourceSide: CodeSourceSide;
}): { lines: Set<number>; gaps: Set<number> } {
  const lines = new Set<number>();
  const gaps = new Set<number>();
  options.changedLines?.forEach((line) => lines.add(line));
  options.changedLineKinds?.forEach((_kind, line) => lines.add(line));
  options.evidenceLines?.forEach((line) => lines.add(line));
  // GitHub commentability already covers the patch's U3 context. Treating every commentable row as
  // a change focus would add another three rows around that context and silently widen U3 to U6.
  // Canonical +/- rows define the fold; existing comments/drafts below can still pin their rows.
  options.existingCommentsByLine.forEach((_comments, line) => lines.add(line));
  options.pendingCommentsByLine.forEach((_comments, line) => lines.add(line));
  if (options.composerLine !== undefined) lines.add(options.composerLine);
  options.removedRows?.forEach((_rows, line) => gaps.add(line + 1));
  for (const row of options.diffLines ?? []) {
    if (options.sourceSide === "base") {
      if (row.oldLine !== null) lines.add(row.oldLine);
    } else if (row.kind === "added") {
      if (row.newLine !== null) lines.add(row.newLine);
    } else {
      gaps.add(row.beforeNewLine);
    }
  }
  return { lines, gaps };
}

function GhostRow(props: { text?: string; line?: CodeDiffLine; showGutter: boolean; marker?: boolean }) {
  const text = props.line?.text ?? props.text ?? "";
  return (
    <>
      <tr
        style={GHOST_ROW_STYLE}
        data-diff-origin={props.line ? "delete" : undefined}
        data-old-line={props.line?.oldLine ?? undefined}
        data-before-new-line={props.line?.beforeNewLine}
        data-no-newline={props.line?.noNewline ? "true" : undefined}
        aria-label={canonicalDiffAriaLabel(props.line)}
      >
        {props.showGutter ? (
          <td style={{ ...GUTTER_CELL_STYLE, ...GHOST_GUTTER_STYLE }} aria-hidden="true">
            <div style={GUTTER_CONTENT_STYLE}>
              <span>{props.line?.oldLine === null || props.line?.oldLine === undefined ? "− " : `− ${props.line.oldLine}`}</span>
            </div>
          </td>
        ) : null}
        <td style={{ ...CODE_CELL_STYLE, ...GHOST_CODE_STYLE, ...(props.marker ? GHOST_MARKER_STYLE : {}) }}>
          {text.length > 0 ? text : " "}
        </td>
      </tr>
      {props.line?.noNewline ? <NoNewlineMarkerRow side="old" showGutter={props.showGutter} /> : null}
    </>
  );
}

function NoNewlineMarkerRow({ side, showGutter }: { side: "old" | "new"; showGutter: boolean }) {
  return (
    <tr data-no-newline-marker={side} aria-label={`No newline at end of ${side} file`}>
      {showGutter ? <td style={{ ...GUTTER_CELL_STYLE, ...NO_NEWLINE_GUTTER_STYLE }} aria-hidden="true" /> : null}
      <td style={{ ...CODE_CELL_STYLE, ...NO_NEWLINE_CODE_STYLE }}>\ No newline at end of file</td>
    </tr>
  );
}

function canonicalDiffAriaLabel(line: CodeDiffLine | undefined): string | undefined {
  const suffix = line?.noNewline ? "; no newline at end of file" : "";
  if (line?.kind === "added" && line.newLine !== null) return `Added new line ${line.newLine}${suffix}`;
  if (line?.kind === "deleted" && line.oldLine !== null) return `Deleted old line ${line.oldLine}${suffix}`;
  return undefined;
}

interface CanonicalRows {
  sourceRows: ReadonlyMap<number, CodeDiffLine>;
  deletedByBeforeLine: ReadonlyMap<number, readonly CodeDiffLine[]>;
}

function canonicalRowsForSource(
  diffLines: readonly CodeDiffLine[],
  sourceSide: CodeSourceSide,
  startLine: number,
  lineCount: number,
): CanonicalRows {
  const sourceRows = new Map<number, CodeDiffLine>();
  const deletedByBeforeLine = new Map<number, CodeDiffLine[]>();
  const endLine = startLine + lineCount - 1;
  for (const line of diffLines) {
    if (sourceSide === "base") {
      if (line.kind === "deleted" && line.oldLine !== null && line.oldLine >= startLine && line.oldLine <= endLine) {
        sourceRows.set(line.oldLine, line);
      }
      continue;
    }
    if (line.kind === "added" && line.newLine !== null && line.newLine >= startLine && line.newLine <= endLine) {
      sourceRows.set(line.newLine, line);
      continue;
    }
    if (line.kind === "deleted" && line.beforeNewLine >= startLine && line.beforeNewLine <= endLine + 1) {
      const bucket = deletedByBeforeLine.get(line.beforeNewLine);
      bucket ? bucket.push(line) : deletedByBeforeLine.set(line.beforeNewLine, [line]);
    }
  }
  return { sourceRows, deletedByBeforeLine };
}

function diffRowKey(line: CodeDiffLine): string {
  return `diff-delete-${line.oldLine ?? "unknown"}-${line.beforeNewLine}`;
}

function firstFocusedLine(
  evidenceLines?: ReadonlySet<number>,
  changedLineKinds?: ReadonlyMap<number, ChangedLineKind>,
  changedLines?: ReadonlySet<number>,
): number | null {
  if (evidenceLines && evidenceLines.size > 0) {
    return Math.min(...evidenceLines);
  }
  if (changedLineKinds && changedLineKinds.size > 0) {
    return Math.min(...changedLineKinds.keys());
  }
  if (changedLines && changedLines.size > 0) {
    return Math.min(...changedLines);
  }
  return null;
}

/** Split tokenized pieces into explicit visual rows so code/gutter never desync on wrapped token streams. */
function splitHighlightedLines(pieces: Piece[]): React.ReactNode[][] {
  const lines: React.ReactNode[][] = [[]];
  let key = 0;
  for (const piece of pieces) {
    const fragments = piece.text.split("\n");
    for (let index = 0; index < fragments.length; index += 1) {
      const text = fragments[index];
      if (text.length > 0) {
        lines[lines.length - 1].push(
          <span key={`tok-${key++}`} style={{ color: piece.color }}>
            {text}
          </span>,
        );
      }
      if (index < fragments.length - 1) {
        lines.push([]);
      }
    }
  }
  return lines;
}

function renderHighlightedLines(
  lines: React.ReactNode[][],
  startLine?: number,
  changedLineKinds?: ReadonlyMap<number, ChangedLineKind>,
): React.ReactNode {
  return lines.map((line, index) => (
    <span
      key={`line-${index}`}
      style={{
        ...CODE_LINE_STYLE,
        ...(lineRowStyle(startLine === undefined ? undefined : changedLineKinds?.get(startLine + index)) ?? {}),
      }}
    >
      {line.length > 0 ? line : " "}
      {index < lines.length - 1 ? "\n" : ""}
    </span>
  ));
}

// GitHub's diff has no third "modified" colour: a replaced line shows GREEN on the head side, with
// its old text as a RED removed row. So a modified head line paints exactly like an added one — the
// removed counterpart is already rendered as a red ghost row (see removedRows).
function lineMarker(kind: ChangedLineKind | undefined, changed: boolean, evidence: boolean): string {
  return kind === "added" || kind === "modified"
    ? "+ "
    : kind === "deleted"
      ? "- "
      : evidence
        ? "› "
        : changed
          ? "● "
          : "";
}

function lineRowStyle(kind: ChangedLineKind | undefined): React.CSSProperties | undefined {
  if (!kind) {
    return undefined;
  }
  if (kind === "deleted") {
    return DELETED_ROW_STYLE;
  }
  return ADDED_ROW_STYLE; // added and modified are both head-side green
}

function kindGutterStyle(kind: ChangedLineKind): React.CSSProperties {
  return kind === "deleted" ? DELETED_GUTTER_STYLE : ADDED_GUTTER_STYLE;
}

// Shared by the styles below and the scroll-to-diff math — keep the three in sync.
const LINE_HEIGHT_PX = 17;
const EMPTY_EXISTING_COMMENTS: readonly PrGitHubComment[] = [];
const EMPTY_PENDING_COMMENTS: readonly ReviewComment[] = [];

const PRE_STYLE: React.CSSProperties = {
  margin: 0,
  overflow: "auto",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11.5,
  lineHeight: `${LINE_HEIGHT_PX}px`,
  color: COLOR.plain,
  whiteSpace: "pre",
  tabSize: 2,
};

const LISTING_STYLE: React.CSSProperties = {
  overflow: "auto",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11.5,
  lineHeight: `${LINE_HEIGHT_PX}px`,
  tabSize: 2,
};
const CODE_TABLE_STYLE: React.CSSProperties = {
  // Keep wrappable colspan content (comments/composers) from becoming the table's intrinsic width
  // and distributing that excess into the gutter. Preformatted code still grows an auto-layout
  // table past the scrollport when a source line itself is wider than the available space.
  width: "100%",
  minWidth: "100%",
  borderCollapse: "collapse",
  borderSpacing: 0,
};
const GUTTER_CELL_STYLE: React.CSSProperties = {
  position: "sticky",
  left: 0,
  zIndex: 1,
  height: LINE_HEIGHT_PX,
  padding: "0 10px 0 4px",
  verticalAlign: "top",
  textAlign: "right",
  color: "#4A525F",
  userSelect: "none",
  whiteSpace: "pre",
  background: "#0E1116",
};
const GUTTER_CONTENT_STYLE: React.CSSProperties = { minHeight: LINE_HEIGHT_PX, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 };
const LINE_COMMENT_BUTTON_STYLE: React.CSSProperties = {
  width: 15,
  height: 15,
  padding: 0,
  border: "1px solid rgba(125,211,252,0.55)",
  borderRadius: 4,
  background: "rgba(56,139,253,0.15)",
  color: "#7DD3FC",
  font: "inherit",
  fontSize: 12,
  fontWeight: 700,
  lineHeight: "12px",
  cursor: "pointer",
  flexShrink: 0,
};
const CHANGED_LINE_STYLE: React.CSSProperties = { color: "#E2A33C", fontWeight: 700 };
const EVIDENCE_GUTTER_STYLE: React.CSSProperties = { color: "#7DD3FC", fontWeight: 800 };
const CODE_LINE_STYLE: React.CSSProperties = { display: "block", width: "100%" };
const ADDED_GUTTER_STYLE: React.CSSProperties = { color: "#56C271", fontWeight: 700 };
const DELETED_GUTTER_STYLE: React.CSSProperties = { color: "#F0787C", fontWeight: 700 };
const ADDED_ROW_STYLE: React.CSSProperties = {
  background: "rgba(86,194,113,0.20)",
  boxShadow: "inset 3px 0 0 #56C271",
};
const DELETED_ROW_STYLE: React.CSSProperties = {
  background: "rgba(240,120,124,0.20)",
  boxShadow: "inset 3px 0 0 #F0787C",
};
const EVIDENCE_ROW_STYLE: React.CSSProperties = {
  backgroundImage: "linear-gradient(rgba(56,139,253,0.14), rgba(56,139,253,0.14))",
  boxShadow: "inset 3px 0 0 #7DD3FC, inset 0 0 0 1px rgba(125,211,252,0.28)",
};
const CODE_CELL_STYLE: React.CSSProperties = {
  height: LINE_HEIGHT_PX,
  padding: 0,
  verticalAlign: "top",
  color: COLOR.plain,
  whiteSpace: "pre",
};
const COMPOSER_CELL_STYLE: React.CSSProperties = { padding: "6px 0 2px", background: "rgba(56,139,253,0.04)" };
const EXISTING_COMMENT_CELL_STYLE: React.CSSProperties = { padding: "6px 8px 7px 26px", background: "rgba(56,139,253,0.04)" };
const PENDING_COMMENT_CELL_STYLE: React.CSSProperties = { padding: "6px 8px 7px 26px", background: "rgba(210,153,34,0.035)" };
const GHOST_ROW_STYLE: React.CSSProperties = { background: "rgba(240,120,124,0.14)" };
const GHOST_GUTTER_STYLE: React.CSSProperties = { color: "#F0787C", background: "rgba(50,22,27,0.96)", fontWeight: 700 };
// A deleted row is still source that must be read precisely. GitHub distinguishes it with the red
// surface and minus gutter, not strike-through typography (which obscures punctuation and tokens).
const GHOST_CODE_STYLE: React.CSSProperties = { color: "#E6EDF3" };
const GHOST_MARKER_STYLE: React.CSSProperties = { color: "#A66B70", textDecoration: "none", fontStyle: "italic" };
const NO_NEWLINE_GUTTER_STYLE: React.CSSProperties = { background: "rgba(33,28,28,0.96)" };
const NO_NEWLINE_CODE_STYLE: React.CSSProperties = {
  color: "#9AA4B2",
  background: "rgba(88,62,48,0.18)",
  fontStyle: "italic",
};
