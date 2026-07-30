const JAVASCRIPT_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
]);
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);

export interface SourceLineCommentProjection {
  /** One-based absolute source line. */
  line: number;
  /** Source text left after comments are removed. String contents remain source code. */
  code: string;
  /** Whether this row contains any source-comment text. */
  comment: boolean;
  /** A compiler/runtime/tooling directive belongs to this row's enclosing comment range. */
  semanticDirective?: true;
}

interface MutableLineProjection {
  code: string;
  comment: boolean;
}

/**
 * Project supported source into per-line code/comment facts.
 *
 * This is deliberately lexical and conservative: strings remain code, mixed rows retain their code,
 * and unsupported languages return `null`. Callers parsing a partial source fragment therefore fail
 * open whenever the fragment starts inside lexical state that its visible text cannot establish.
 */
export function sourceLineCommentProjections(
  file: string,
  code: string,
  startLine = 1,
): readonly SourceLineCommentProjection[] | null {
  const extension = fileExtension(file);
  const projected = JAVASCRIPT_EXTENSIONS.has(extension)
    ? javascriptLineProjections(code)
    : PYTHON_EXTENSIONS.has(extension)
      ? pythonLineProjections(code)
      : null;
  if (projected === null) return null;
  return projected.map((line, index) => ({
    line: startLine + index,
    code: line.code,
    comment: line.comment,
  }));
}

/** Return absolute source lines that are provably comment-only rows. */
export function sourceCommentOnlyLines(
  file: string,
  code: string,
  startLine = 1,
): ReadonlySet<number> {
  const projected = sourceLineCommentProjections(file, code, startLine);
  if (projected === null) return new Set<number>();
  return new Set(
    projected
      .filter((line) => line.comment && line.code.trim().length === 0)
      .map((line) => line.line),
  );
}

function javascriptLineProjections(code: string): MutableLineProjection[] {
  const lines = sourceLines(code);
  const projected = lines.map((): MutableLineProjection => ({ code: "", comment: false }));
  let quote: "'" | '"' | "`" | null = null;
  let inBlock = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    let index = 0;
    while (index < line.length || inBlock) {
      if (inBlock) {
        projected[lineIndex].comment = true;
        const close = line.indexOf("*/", index);
        if (close < 0) break;
        inBlock = false;
        index = close + 2;
        continue;
      }

      if (quote !== null) {
        const consumed = consumeQuoted(line, index, quote);
        projected[lineIndex].code += line.slice(index, consumed.next);
        index = consumed.next;
        if (consumed.closed) quote = null;
        else break;
        continue;
      }

      const char = line[index];
      if (char === "/" && line[index + 1] === "/") {
        projected[lineIndex].comment = true;
        break;
      }
      if (char === "/" && line[index + 1] === "*") {
        projected[lineIndex].comment = true;
        inBlock = true;
        index += 2;
        continue;
      }
      projected[lineIndex].code += char;
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
      }
      index += 1;
    }
  }

  return projected;
}

function pythonLineProjections(code: string): MutableLineProjection[] | null {
  const lines = sourceLines(code);
  const projected = lines.map((): MutableLineProjection => ({ code: "", comment: false }));
  let quote: "'" | '"' | "'''" | '"""' | null = null;
  let explicitContinuation = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    // A comment-only physical row terminates an explicit `\` continuation instead of behaving
    // like removable trivia. Without a complete Python parser, fail open for the whole projection.
    if (explicitContinuation && /^\s*#/.test(line)) return null;
    explicitContinuation = false;

    let index = 0;
    while (index < line.length) {
      if (quote !== null) {
        const consumed = consumeQuoted(line, index, quote);
        projected[lineIndex].code += line.slice(index, consumed.next);
        index = consumed.next;
        if (consumed.closed) quote = null;
        else break;
        continue;
      }

      const char = line[index];
      if (char === "#") {
        projected[lineIndex].comment = true;
        // Horizontal trivia immediately before a Python comment is not part of the statement.
        // Preserve leading indentation on code-only rows, but normalize `value` and
        // `value  # docs` to the same executable projection.
        projected[lineIndex].code = projected[lineIndex].code.replace(/[ \t]+$/, "");
        break;
      }
      projected[lineIndex].code += char;
      if (char === "'" || char === '"') {
        const triple = line.slice(index, index + 3) === char.repeat(3);
        const delimiter = triple ? char.repeat(3) as "'''" | '"""' : char;
        if (isPythonFStringPrefix(line, index)) {
          const consumed = consumePythonFString(line, index, delimiter);
          if (consumed.closed) {
            projected[lineIndex].code += line.slice(index + 1, consumed.next);
            index = consumed.next;
            continue;
          }
        }
        quote = delimiter;
        if (triple) {
          projected[lineIndex].code += char.repeat(2);
          index += 2;
        }
      }
      index += 1;
    }
    explicitContinuation = quote === null && projected[lineIndex].code.endsWith("\\");
  }

  return projected;
}

function isPythonFStringPrefix(line: string, quoteIndex: number): boolean {
  let prefixStart = quoteIndex;
  while (
    prefixStart > 0
    && quoteIndex - prefixStart < 2
    && /[A-Za-z]/.test(line[prefixStart - 1])
  ) {
    prefixStart -= 1;
  }
  const prefix = line.slice(prefixStart, quoteIndex);
  return /^(?:f|fr|rf)$/i.test(prefix)
    && (prefixStart === 0 || !/[A-Za-z0-9_]/.test(line[prefixStart - 1]));
}

/**
 * Consume a same-line f-string while keeping quotes inside replacement expressions attached to
 * executable source. Python 3.12 permits the outer quote character in those nested expressions.
 */
function consumePythonFString(
  line: string,
  start: number,
  quote: "'" | '"' | "'''" | '"""',
): { next: number; closed: boolean } {
  let index = start + quote.length;
  let replacementDepth = 0;
  while (index < line.length) {
    if (replacementDepth === 0) {
      if (line.startsWith(quote, index)) {
        return { next: index + quote.length, closed: true };
      }
      if (line[index] === "\\") {
        index += 2;
        continue;
      }
      if (line.startsWith("{{", index) || line.startsWith("}}", index)) {
        index += 2;
        continue;
      }
      if (line[index] === "{") replacementDepth = 1;
      index += 1;
      continue;
    }

    const char = line[index];
    if (char === "'" || char === '"') {
      const triple = line.slice(index, index + 3) === char.repeat(3);
      const nestedQuote = triple ? char.repeat(3) as "'''" | '"""' : char;
      const consumed = consumeQuoted(line, index + nestedQuote.length, nestedQuote);
      if (!consumed.closed) return { next: line.length, closed: false };
      index = consumed.next;
      continue;
    }
    if (char === "{") replacementDepth += 1;
    if (char === "}") replacementDepth -= 1;
    index += 1;
  }
  return { next: line.length, closed: false };
}

function consumeQuoted(
  line: string,
  start: number,
  quote: "'" | '"' | "`" | "'''" | '"""',
): { next: number; closed: boolean } {
  let escaped = false;
  for (let index = start; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (line.startsWith(quote, index)) return { next: index + quote.length, closed: true };
  }
  return { next: line.length, closed: false };
}

function sourceLines(code: string): string[] {
  if (code.length === 0) return [];
  return code.split("\n");
}

function fileExtension(file: string): string {
  const path = file.toLowerCase();
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot);
}
