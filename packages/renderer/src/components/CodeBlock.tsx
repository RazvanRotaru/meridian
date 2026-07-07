/**
 * A tiny, dependency-free TS/JS syntax highlighter. A real grammar (Prism/Shiki) would pull a
 * package, but the build must work offline — so a single regex splits source into comments,
 * strings, numbers and keywords, and everything else stays the default light colour. It is
 * deliberately approximate (one JS/TS-ish tokenizer for the whole codebase, no per-line-vs-regex
 * disambiguation) yet must NEVER throw: any tokenizing edge case falls back to the raw text, which
 * React still escapes as a plain string child.
 */

import { useEffect, useMemo, useRef } from "react";

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
  changedLines,
}: {
  code: string;
  maxHeight?: number | string;
  /** When set, a right-aligned line-number gutter is rendered alongside the code, numbering from
   * this line. Omitted → no gutter (the plain highlighted listing). Highlighting is kept either way. */
  startLine?: number;
  /** Absolute line numbers the diff touched — their gutter numbers go amber (needs the gutter). */
  changedLines?: ReadonlySet<number>;
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
  const highlighted = pieces.map((piece, index) => (
    <span key={index} style={{ color: piece.color }}>{piece.text}</span>
  ));
  const listingRef = useRef<HTMLDivElement>(null);
  // Land on the diff: when the listing knows its changed lines, open scrolled to the first one
  // (minus a little context) instead of the top of the span.
  useEffect(() => {
    const container = listingRef.current;
    if (!container || startLine === undefined || !changedLines || changedLines.size === 0) {
      return;
    }
    const firstChanged = Math.min(...changedLines);
    container.scrollTop = Math.max(0, (firstChanged - startLine - 3) * LINE_HEIGHT_PX);
  }, [code, startLine, changedLines]);
  if (startLine === undefined) {
    return <pre style={{ ...PRE_STYLE, maxHeight }}>{highlighted}</pre>;
  }
  // Gutter mode: the row owns the vertical scroll (numbers and code scroll together, always the
  // same height); the code column owns horizontal scroll (min-width:0 lets it shrink and scroll
  // inside itself) so the fixed-width gutter never slides out of view.
  return (
    <div ref={listingRef} style={{ ...LISTING_STYLE, maxHeight }}>
      <pre style={GUTTER_STYLE} aria-hidden>{lineNumbers(code, startLine, changedLines)}</pre>
      <pre style={CODE_COLUMN_STYLE}>{highlighted}</pre>
    </div>
  );
}

// A right-aligned column of consecutive line numbers, one per line of `code`, starting at
// `startLine`. A line the diff touched renders its number amber + a leading ● (the VS-Code-style
// modified-gutter read); untouched lines keep the muted grey.
function lineNumbers(code: string, startLine: number, changedLines?: ReadonlySet<number>): React.ReactNode {
  const lines = code.split("\n");
  if (!changedLines || changedLines.size === 0) {
    return lines.map((_line, index) => startLine + index).join("\n");
  }
  return lines.map((_line, index) => {
    const lineNo = startLine + index;
    const changed = changedLines.has(lineNo);
    return (
      <span key={lineNo} style={changed ? CHANGED_LINE_STYLE : undefined}>
        {changed ? "● " : ""}
        {lineNo}
        {"\n"}
      </span>
    );
  });
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
const CODE_COLUMN_STYLE: React.CSSProperties = {
  margin: 0,
  flex: 1,
  minWidth: 0,
  color: COLOR.plain,
  whiteSpace: "pre",
  overflowX: "auto",
  overflowY: "hidden",
};
