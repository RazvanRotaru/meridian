/**
 * A tiny, dependency-free TS/JS syntax highlighter. A real grammar (Prism/Shiki) would pull a
 * package, but the build must work offline — so a single regex splits source into comments,
 * strings, numbers and keywords, and everything else stays the default light colour. It is
 * deliberately approximate (one JS/TS-ish tokenizer for the whole codebase, no per-line-vs-regex
 * disambiguation) yet must NEVER throw: any tokenizing edge case falls back to the raw text, which
 * React still escapes as a plain string child.
 */

import { useEffect, useMemo, useRef } from "react";
import type { ChangedLineKind } from "@meridian/core";

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
  const listingRef = useRef<HTMLDivElement>(null);
  // Land on the diff: when the listing knows its changed lines, open scrolled to the first one
  // (minus a little context) instead of the top of the span.
  useEffect(() => {
    const container = listingRef.current;
    if (!container || startLine === undefined) {
      return;
    }
    const firstChanged = firstChangedLine(changedLineKinds, changedLines);
    if (firstChanged === null) {
      return;
    }
    container.scrollTop = Math.max(0, (firstChanged - startLine - 3) * LINE_HEIGHT_PX);
  }, [code, startLine, changedLines, changedLineKinds]);
  if (startLine === undefined) {
    return <pre style={{ ...PRE_STYLE, maxHeight }}>{renderHighlightedLines(highlightedLines)}</pre>;
  }
  // A known startLine maps the diff kinds onto ROWS (coloured backgrounds + inset bar) regardless of
  // the gutter — so a logic-flow panel with no line numbers still paints its added/deleted lines.
  // The row owns vertical scroll (numbers + code scroll together); the code column owns horizontal
  // scroll (min-width:0 lets it shrink) so the fixed-width gutter never slides out of view.
  return (
    <div ref={listingRef} style={{ ...LISTING_STYLE, maxHeight }}>
      {showGutter ? <pre style={GUTTER_STYLE} aria-hidden>{lineNumbers(code, startLine, changedLines, changedLineKinds)}</pre> : null}
      <pre style={CODE_COLUMN_STYLE}>{renderHighlightedLines(highlightedLines, startLine, changedLineKinds)}</pre>
    </div>
  );
}

function firstChangedLine(
  changedLineKinds?: ReadonlyMap<number, ChangedLineKind>,
  changedLines?: ReadonlySet<number>,
): number | null {
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

// A right-aligned column of consecutive line numbers, one per line of `code`, starting at
// `startLine`. A line the diff touched renders its number amber + a leading ● (the VS-Code-style
// modified-gutter read); untouched lines keep the muted grey.
function lineNumbers(
  code: string,
  startLine: number,
  changedLines?: ReadonlySet<number>,
  changedLineKinds?: ReadonlyMap<number, ChangedLineKind>,
): React.ReactNode {
  const lines = code.split("\n");
  if ((!changedLines || changedLines.size === 0) && (!changedLineKinds || changedLineKinds.size === 0)) {
    return lines.map((_line, index) => startLine + index).join("\n");
  }
  return lines.map((_line, index) => {
    const lineNo = startLine + index;
    const kind = changedLineKinds?.get(lineNo);
    const changed = changedLines?.has(lineNo) ?? false;
    const marker = kind === "added" ? "+ " : kind === "deleted" ? "- " : kind === "modified" ? "~ " : changed ? "● " : "";
    return (
      <span key={lineNo} style={kind ? kindGutterStyle(kind) : changed ? CHANGED_LINE_STYLE : undefined}>
        {marker}
        {lineNo}
        {"\n"}
      </span>
    );
  });
}

function lineRowStyle(kind: ChangedLineKind | undefined): React.CSSProperties | undefined {
  if (!kind) {
    return undefined;
  }
  if (kind === "added") {
    return ADDED_ROW_STYLE;
  }
  if (kind === "deleted") {
    return DELETED_ROW_STYLE;
  }
  return MODIFIED_ROW_STYLE;
}

function kindGutterStyle(kind: ChangedLineKind): React.CSSProperties {
  if (kind === "added") {
    return ADDED_GUTTER_STYLE;
  }
  if (kind === "deleted") {
    return DELETED_GUTTER_STYLE;
  }
  return MODIFIED_GUTTER_STYLE;
}

// Shared by the styles below and the scroll-to-diff math — keep the three in sync.
const LINE_HEIGHT_PX = 17;

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
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  overflowY: "auto",
  overflowX: "hidden",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11.5,
  lineHeight: `${LINE_HEIGHT_PX}px`,
  tabSize: 2,
};
const GUTTER_STYLE: React.CSSProperties = {
  margin: 0,
  flexShrink: 0,
  textAlign: "right",
  color: "#4A525F",
  userSelect: "none",
  whiteSpace: "pre",
};
const CHANGED_LINE_STYLE: React.CSSProperties = { color: "#E2A33C", fontWeight: 700 };
const CODE_LINE_STYLE: React.CSSProperties = { display: "block", width: "100%" };
const ADDED_GUTTER_STYLE: React.CSSProperties = { color: "#56C271", fontWeight: 700 };
const MODIFIED_GUTTER_STYLE: React.CSSProperties = { color: "#E6B84D", fontWeight: 700 };
const DELETED_GUTTER_STYLE: React.CSSProperties = { color: "#F0787C", fontWeight: 700 };
const ADDED_ROW_STYLE: React.CSSProperties = {
  background: "rgba(86,194,113,0.20)",
  boxShadow: "inset 3px 0 0 #56C271",
};
const MODIFIED_ROW_STYLE: React.CSSProperties = {
  background: "rgba(230,184,77,0.18)",
  boxShadow: "inset 3px 0 0 #E6B84D",
};
const DELETED_ROW_STYLE: React.CSSProperties = {
  background: "rgba(240,120,124,0.20)",
  boxShadow: "inset 3px 0 0 #F0787C",
};
const CODE_COLUMN_STYLE: React.CSSProperties = {
  margin: 0,
  flex: 1,
  minWidth: 0,
  color: COLOR.plain,
  whiteSpace: "pre",
  overflowX: "auto",
  overflowY: "hidden",
};
