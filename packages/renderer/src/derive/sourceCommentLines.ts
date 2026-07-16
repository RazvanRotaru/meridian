import type { ChangedDiffLine } from "@meridian/core";

const JAVASCRIPT_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
]);
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);

interface LineFlags {
  code: boolean;
  comment: boolean;
}

/**
 * Return absolute source lines that are provably comment-only rows. Documentation comments and
 * compiler/linter directives are comments too; strings, mixed code/comment rows, and languages we
 * do not parse stay in the diff.
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

/** Remove added comment-only rows from the canonical diff projection. */
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
  const flags: LineFlags[] = lines.map(() => ({ code: false, comment: false }));
  let quote: "'" | '"' | "`" | null = null;
  let inBlock = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    let index = 0;
    while (index < line.length || inBlock) {
      if (inBlock) {
        flags[lineIndex].comment = true;
        const close = line.indexOf("*/", index);
        if (close < 0) break;
        inBlock = false;
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
        break;
      }
      if (char === "/" && line[index + 1] === "*") {
        inBlock = true;
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

  return collectCommentOnlyLines(flags, startLine);
}

function pythonCommentOnlyLines(code: string, startLine: number): ReadonlySet<number> {
  const lines = sourceLines(code);
  const flags: LineFlags[] = lines.map(() => ({ code: false, comment: false }));
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

function collectCommentOnlyLines(flags: readonly LineFlags[], startLine: number): ReadonlySet<number> {
  const result = new Set<number>();
  for (let index = 0; index < flags.length; index += 1) {
    const line = flags[index];
    if (line.comment && !line.code) result.add(startLine + index);
  }
  return result;
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
