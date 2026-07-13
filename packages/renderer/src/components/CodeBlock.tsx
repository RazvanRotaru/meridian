/**
 * A tiny, dependency-free TS/JS syntax highlighter. A real grammar (Prism/Shiki) would pull a
 * package, but the build must work offline — so a single regex splits source into comments,
 * strings, numbers and keywords, and everything else stays the default light colour. It is
 * deliberately approximate (one JS/TS-ish tokenizer for the whole codebase, no per-line-vs-regex
 * disambiguation) yet must NEVER throw: any tokenizing edge case falls back to the raw text, which
 * React still escapes as a plain string child.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ChangedLineKind } from "@meridian/core";
import type { PrGitHubComment } from "../state/prTypes";
import { ExistingCommentList } from "./review/ExistingReviewComments";
import { CommentComposer } from "./review/ReviewComments";

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
  removedRows,
  removedTruncated = false,
}: {
  code: string;
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
  /** Removed patch text, grouped by the absolute new-side line emitted immediately before it. */
  removedRows?: ReadonlyMap<number, string[]>;
  /** The patch parser hit its per-file removed-line cap. */
  removedTruncated?: boolean;
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
  const highlightedLines = useMemo(() => splitHighlightedLines(pieces), [pieces]);
  const existingCommentsByLine = useMemo(() => {
    const byLine = new Map<number, PrGitHubComment[]>();
    for (const comment of existingComments) {
      if (comment.line === null) continue;
      const bucket = byLine.get(comment.line);
      bucket ? bucket.push(comment) : byLine.set(comment.line, [comment]);
    }
    return byLine;
  }, [existingComments]);
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
  }, [code, startLine, changedLines, changedLineKinds, evidenceLines, existingCommentsByLine]);
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
  const showReviewGutter = hasCommentableLines || (removedRows?.size ?? 0) > 0 || removedTruncated;
  const gutterVisible = showGutter || showReviewGutter;
  return (
    <div ref={listingRef} style={{ ...LISTING_STYLE, maxHeight }}>
      <table style={CODE_TABLE_STYLE}>
        <tbody>
          {removedRows?.get(0)?.map((line, index) => (
            <GhostRow key={`removed-0-${index}`} text={line} showGutter={gutterVisible} />
          ))}
          {highlightedLines.map((line, index) => {
            const lineNo = startLine + index;
            const kind = changedLineKinds?.get(lineNo);
            const changed = changedLines?.has(lineNo) ?? false;
            const evidence = evidenceLines?.has(lineNo) ?? false;
            const commentable = onLineClick !== undefined && (commentableLines?.has(lineNo) ?? false);
            const composerOpen = lineComposer?.line === lineNo;
            const lineComments = existingCommentsByLine.get(lineNo) ?? EMPTY_EXISTING_COMMENTS;
            return (
              <Fragment key={`line-${lineNo}`}>
                <tr
                  data-source-line={lineNo}
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
                {lineComments.length > 0 ? (
                  <tr data-existing-review-comments-line={lineNo}>
                    <td colSpan={gutterVisible ? 2 : 1} style={EXISTING_COMMENT_CELL_STYLE}>
                      <ExistingCommentList comments={lineComments} />
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
                {removedRows?.get(lineNo)?.map((removedLine, removedIndex) => (
                  <GhostRow
                    key={`removed-${lineNo}-${removedIndex}`}
                    text={removedLine}
                    showGutter={gutterVisible}
                  />
                ))}
              </Fragment>
            );
          })}
          {removedTruncated ? (
            <GhostRow text="… removed lines truncated" showGutter={gutterVisible} marker />
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function GhostRow(props: { text: string; showGutter: boolean; marker?: boolean }) {
  return (
    <tr style={GHOST_ROW_STYLE}>
      {props.showGutter ? (
        <td style={{ ...GUTTER_CELL_STYLE, ...GHOST_GUTTER_STYLE }} aria-hidden="true">
          <div style={GUTTER_CONTENT_STYLE}>
            <span>{"− "}</span>
          </div>
        </td>
      ) : null}
      <td style={{ ...CODE_CELL_STYLE, ...GHOST_CODE_STYLE, ...(props.marker ? GHOST_MARKER_STYLE : {}) }}>
        {props.text.length > 0 ? props.text : " "}
      </td>
    </tr>
  );
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
  width: "max-content",
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
const GHOST_ROW_STYLE: React.CSSProperties = { background: "rgba(240,120,124,0.14)" };
const GHOST_GUTTER_STYLE: React.CSSProperties = { color: "#F0787C", background: "rgba(50,22,27,0.96)", fontWeight: 700 };
const GHOST_CODE_STYLE: React.CSSProperties = { color: "#E98A8E", textDecoration: "line-through" };
const GHOST_MARKER_STYLE: React.CSSProperties = { color: "#A66B70", textDecoration: "none", fontStyle: "italic" };
