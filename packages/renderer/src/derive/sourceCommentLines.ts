import type { ChangedDiffLine } from "@meridian/core";

const JAVASCRIPT_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
]);
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);

interface LineFlags {
  code: boolean;
  comment: boolean;
  protectedComment: boolean;
}

interface BlockComment {
  lines: number[];
  protected: boolean;
}

/**
 * Return absolute source lines that are provably ordinary, comment-only rows. This deliberately
 * fails open: documentation comments, compiler/linter directives, strings, mixed code/comment
 * rows, and languages we do not parse stay in the diff.
 */
export function sourceCommentOnlyLines(
  file: string,
  code: string,
  startLine = 1,
): ReadonlySet<number> {
  const extension = fileExtension(file);
  if (JAVASCRIPT_EXTENSIONS.has(extension)) return javascriptCommentOnlyLines(code, startLine);
  if (PYTHON_EXTENSIONS.has(extension)) return pythonCommentOnlyLines(code, startLine);
  return new Set<number>();
}

/** Remove diff treatment from added rows that are provably ordinary source comments. */
export function withoutAddedSourceCommentDiffLines(
  lines: readonly ChangedDiffLine[],
  commentOnlyLines: ReadonlySet<number>,
): readonly ChangedDiffLine[] {
  if (lines.length === 0 || commentOnlyLines.size === 0) return lines;

  const kept = lines.filter((line) => !(
    line.kind === "added"
    && line.newLine !== null
    && commentOnlyLines.has(line.newLine)
  ));
  const changed = kept.length !== lines.length;
  return changed ? kept : lines;
}

function javascriptCommentOnlyLines(code: string, startLine: number): ReadonlySet<number> {
  const lines = sourceLines(code);
  const flags: LineFlags[] = lines.map(() => ({ code: false, comment: false, protectedComment: false }));
  let quote: "'" | '"' | "`" | null = null;
  let block: BlockComment | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    let index = 0;
    while (index < line.length || block !== null) {
      if (block !== null) {
        flags[lineIndex].comment = true;
        if (block.lines.at(-1) !== lineIndex) block.lines.push(lineIndex);
        const close = line.indexOf("*/", index);
        const commentText = close < 0 ? line.slice(index) : line.slice(index, close);
        if (isJavaScriptDirective(commentText)) block.protected = true;
        if (close < 0) break;
        if (block.protected) markProtected(flags, block.lines);
        block = null;
        index = close + 2;
        continue;
      }

      if (quote !== null) {
        flags[lineIndex].code = true;
        const consumed = consumeQuoted(line, index, quote);
        index = consumed.next;
        if (consumed.closed) quote = null;
        else break;
        continue;
      }

      const char = line[index];
      if (char === " " || char === "\t" || char === "\r") {
        index += 1;
        continue;
      }
      if (char === "/" && line[index + 1] === "/") {
        flags[lineIndex].comment = true;
        if (isJavaScriptDirective(line.slice(index + 2), true)) flags[lineIndex].protectedComment = true;
        break;
      }
      if (char === "/" && line[index + 1] === "*") {
        const body = line.slice(index + 2);
        block = {
          lines: [],
          protected: line[index + 2] === "*" || line[index + 2] === "!" || isJavaScriptDirective(body),
        };
        index += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        flags[lineIndex].code = true;
        quote = char;
        index += 1;
        continue;
      }
      flags[lineIndex].code = true;
      index += 1;
    }
  }

  // Unterminated blocks are ambiguous source, so retain their complete diff treatment.
  markUnterminatedBlockProtected(flags, block);
  return collectCommentOnlyLines(flags, startLine);
}

function pythonCommentOnlyLines(code: string, startLine: number): ReadonlySet<number> {
  const lines = sourceLines(code);
  const flags: LineFlags[] = lines.map(() => ({ code: false, comment: false, protectedComment: false }));
  let quote: "'" | '"' | "'''" | '"""' | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    let index = 0;
    while (index < line.length) {
      if (quote !== null) {
        flags[lineIndex].code = true;
        const consumed = consumeQuoted(line, index, quote);
        index = consumed.next;
        if (consumed.closed) quote = null;
        else break;
        continue;
      }

      const char = line[index];
      if (char === " " || char === "\t" || char === "\r") {
        index += 1;
        continue;
      }
      if (char === "#") {
        flags[lineIndex].comment = true;
        const absoluteLine = startLine + lineIndex;
        if (isPythonDirective(line.slice(index + 1), absoluteLine)) {
          flags[lineIndex].protectedComment = true;
        }
        break;
      }
      if (char === "'" || char === '"') {
        flags[lineIndex].code = true;
        const triple = line.slice(index, index + 3) === char.repeat(3);
        quote = triple ? char.repeat(3) as "'''" | '"""' : char;
        index += triple ? 3 : 1;
        continue;
      }
      flags[lineIndex].code = true;
      index += 1;
    }
  }
  return collectCommentOnlyLines(flags, startLine);
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

function isJavaScriptDirective(raw: string, lineComment = false): boolean {
  const text = raw.trim().replace(/^\*+\s*/, "");
  if ((lineComment && text.startsWith("/")) || text.startsWith("!")) return true;
  return /^(?:@?(?:ts-(?:ignore|expect-error|nocheck|check)|jsx(?:ImportSource|Runtime)?|flow|license|preserve|copyright|generated)|[#@]__PURE__|eslint(?:-|\s)|prettier-ignore|biome-ignore|deno-lint-ignore|istanbul\s+ignore|c8\s+ignore|v8\s+ignore|webpack\w*|rollup\w*|sourceMappingURL=|sourceURL=|global\s|exported\s|jshint\s)/i.test(text);
}

function isPythonDirective(raw: string, absoluteLine: number): boolean {
  const text = raw.trim();
  if (absoluteLine === 1 && text.startsWith("!")) return true;
  if (absoluteLine <= 2 && /(?:^|[-*])\s*coding\s*[:=]/i.test(text)) return true;
  return /^(?:type\s*:|noqa\b|fmt\s*:|isort\s*:|pylint\s*:|pyright\s*:|mypy\s*:|pyre\s*:|ruff\s*:|pragma\s*:|nosec\b|coverage\s*:|cython\s*:|flake8\s*:|region\b|endregion\b|%%|<editor-fold\b|@?generated\b)/i.test(text);
}

function collectCommentOnlyLines(flags: readonly LineFlags[], startLine: number): ReadonlySet<number> {
  const result = new Set<number>();
  for (let index = 0; index < flags.length; index += 1) {
    const line = flags[index];
    if (line.comment && !line.code && !line.protectedComment) result.add(startLine + index);
  }
  return result;
}

function markProtected(flags: LineFlags[], lines: readonly number[]): void {
  for (const line of lines) flags[line].protectedComment = true;
}

function markUnterminatedBlockProtected(flags: LineFlags[], block: BlockComment | null): void {
  if (block !== null) markProtected(flags, block.lines);
}

function sourceLines(code: string): string[] {
  if (code.length === 0) return [];
  return code.split("\n");
}

function fileExtension(file: string): string {
  const path = file.split(/[?#]/, 1)[0].toLowerCase();
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot);
}
