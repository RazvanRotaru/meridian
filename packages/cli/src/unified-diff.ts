import { sourceLineCommentProjections } from "@meridian/core";
import type {
  ChangedDiffLine,
  ChangedLineSpan,
  LineRange,
  SourceLineCommentProjection,
} from "@meridian/core";
import { classifyChangedLineRun } from "./changed-line-kinds";

const JAVASCRIPT_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
]);
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);
const SOURCE_COMMENT_MAX_CHARS = 2 * 1024 * 1024;
const SOURCE_COMMENT_MAX_LINES = 50_000;

/**
 * One contiguous edit run in next-row cursor coordinates. For an empty side, `oldStart`/
 * `newStart` is the 1-based line immediately after that empty range (never the header's preceding
 * line coordinate). This makes base→HEAD mapping unambiguous at file start and deletion seams.
 */
export interface UnifiedDiffEdit {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** Canonical, body-derived representation shared by local git and GitHub patches. */
export interface ParsedUnifiedDiffBody {
  /** Tight HEAD-side additions, plus a one-line graph seam for a pure deletion. */
  ranges: LineRange[];
  /** Tight base-side deletions, plus a one-line graph seam for a pure insertion. */
  oldRanges: LineRange[];
  /** One entry per contiguous +/- edit run, never a context-padded hunk header. */
  edits: UnifiedDiffEdit[];
  /** Paintable rows that still exist in HEAD. Pure deletions deliberately emit no kind span. */
  kinds: ChangedLineSpan[];
  /** Exact +/- rows in patch order, with both base and HEAD coordinates. */
  diffLines: ChangedDiffLine[];
  added: number;
  deleted: number;
  /** False when a hunk body does not consume exactly the line counts declared by its header. */
  complete: boolean;
}

export type TypeScriptCommentProjector = (
  file: string,
  code: string,
  startLine: number,
) => readonly SourceLineCommentProjection[];

interface ActiveHunk {
  oldLines: number;
  newLines: number;
  oldStart: number;
  newStart: number;
  oldCursor: number;
  newCursor: number;
  oldConsumed: number;
  newConsumed: number;
  oldSource: string[];
  newSource: string[];
  runs: SourceCommentRun[];
}

interface ActiveRun {
  oldCursor: number;
  newCursor: number;
  addedLines: number[];
  deletedLines: number[];
  rows: ChangedDiffLine[];
}

interface SourceCommentRun {
  rows: ChangedDiffLine[];
}

/**
 * Parse the body of one file's unified diff.
 *
 * Hunk headers are used only to seed/validate coordinates. Every renderable row, tight range,
 * line kind and edit mapping is derived from the +/- body, preventing U3 context from being
 * mistaken for changed code and keeping local `git diff -U0` and GitHub patches identical.
 */
export function parseUnifiedDiffBody(
  patch: string,
  file?: string,
  typescriptProjector?: TypeScriptCommentProjector,
): ParsedUnifiedDiffBody {
  const ranges: LineRange[] = [];
  const oldRanges: LineRange[] = [];
  const edits: UnifiedDiffEdit[] = [];
  const kinds: ChangedLineSpan[] = [];
  const diffLines: ChangedDiffLine[] = [];
  let added = 0;
  let deleted = 0;
  let complete = true;
  let sawHunk = false;
  let hunk: ActiveHunk | null = null;
  let run: ActiveRun | null = null;
  let lastChangedRow: ChangedDiffLine | null = null;
  let markerCanAttach = false;

  const flushRun = () => {
    if (run === null) {
      return;
    }
    const addedLines = run.addedLines;
    const deletedLines = run.deletedLines;
    if (addedLines.length > 0) {
      ranges.push({ start: addedLines[0], end: addedLines[addedLines.length - 1] });
    } else if (deletedLines.length > 0) {
      const seam = Math.max(1, run.newCursor);
      ranges.push({ start: seam, end: seam });
    }
    if (deletedLines.length > 0) {
      oldRanges.push({ start: deletedLines[0], end: deletedLines[deletedLines.length - 1] });
    } else if (addedLines.length > 0) {
      // The base graph has no inserted rows. Anchor their impact to the next base line instead.
      const seam = Math.max(1, run.oldCursor);
      oldRanges.push({ start: seam, end: seam });
    }

    kinds.push(...classifyChangedLineRun(addedLines, deletedLines.length));

    edits.push({
      oldStart: deletedLines[0] ?? Math.max(1, run.oldCursor),
      oldLines: deletedLines.length,
      newStart: addedLines[0] ?? Math.max(1, run.newCursor),
      newLines: addedLines.length,
    });
    hunk?.runs.push({ rows: run.rows });
    run = null;
  };

  const finishHunk = () => {
    flushRun();
    if (hunk !== null && file !== undefined) {
      annotateSourceCommentRuns(file, hunk, typescriptProjector);
    }
    if (hunk !== null && (hunk.oldConsumed !== hunk.oldLines || hunk.newConsumed !== hunk.newLines)) {
      complete = false;
    }
    hunk = null;
  };

  const lines = patch.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.startsWith("@@")) {
      finishHunk();
      lastChangedRow = null;
      markerCanAttach = false;
      sawHunk = true;
      const parsed = parseHunkHeader(raw);
      if (parsed === null) {
        complete = false;
        continue;
      }
      hunk = {
        oldLines: parsed.oldLines,
        newLines: parsed.newLines,
        // In an empty unified range, the header coordinate names the preceding line. The body
        // cursor is therefore one line later (`-0,0` / `+0,0` correctly start at line 1).
        oldStart: parsed.oldStart + (parsed.oldLines === 0 ? 1 : 0),
        newStart: parsed.newStart + (parsed.newLines === 0 ? 1 : 0),
        oldCursor: parsed.oldStart + (parsed.oldLines === 0 ? 1 : 0),
        newCursor: parsed.newStart + (parsed.newLines === 0 ? 1 : 0),
        oldConsumed: 0,
        newConsumed: 0,
        oldSource: [],
        newSource: [],
        runs: [],
      };
      continue;
    }
    if (hunk === null) {
      continue;
    }
    if (raw.startsWith("\\")) {
      if (raw === "\\ No newline at end of file" && markerCanAttach && lastChangedRow !== null) {
        lastChangedRow.noNewline = true;
      } else {
        // This is the only backslash-prefixed row in Git's unified-diff grammar, and it must attach
        // immediately to a changed row. Unknown or detached markers make the transaction partial.
        complete = false;
      }
      markerCanAttach = false;
      continue;
    }
    const marker = raw[0];
    if (marker === "+") {
      run ??= {
        oldCursor: hunk.oldCursor,
        newCursor: hunk.newCursor,
        addedLines: [],
        deletedLines: [],
        rows: [],
      };
      const line = hunk.newCursor;
      run.addedLines.push(line);
      const row: ChangedDiffLine = { kind: "added", oldLine: null, newLine: line, beforeNewLine: line, text: raw.slice(1) };
      diffLines.push(row);
      run.rows.push(row);
      hunk.newSource.push(row.text);
      lastChangedRow = row;
      markerCanAttach = true;
      hunk.newCursor += 1;
      hunk.newConsumed += 1;
      added += 1;
    } else if (marker === "-") {
      run ??= {
        oldCursor: hunk.oldCursor,
        newCursor: hunk.newCursor,
        addedLines: [],
        deletedLines: [],
        rows: [],
      };
      const line = hunk.oldCursor;
      run.deletedLines.push(line);
      const row: ChangedDiffLine = {
        kind: "deleted",
        oldLine: line,
        newLine: null,
        beforeNewLine: Math.max(1, hunk.newCursor),
        text: raw.slice(1),
      };
      diffLines.push(row);
      run.rows.push(row);
      hunk.oldSource.push(row.text);
      lastChangedRow = row;
      markerCanAttach = true;
      hunk.oldCursor += 1;
      hunk.oldConsumed += 1;
      deleted += 1;
    } else if (marker === " ") {
      flushRun();
      lastChangedRow = null;
      markerCanAttach = false;
      hunk.oldSource.push(raw.slice(1));
      hunk.newSource.push(raw.slice(1));
      hunk.oldCursor += 1;
      hunk.newCursor += 1;
      hunk.oldConsumed += 1;
      hunk.newConsumed += 1;
    } else if (!(raw === "" && index === lines.length - 1)) {
      // Unified body rows always carry a marker. A non-final bare line means the patch was cut or
      // malformed; retain any rows already parsed but prevent consumers from trusting completeness.
      complete = false;
      lastChangedRow = null;
      markerCanAttach = false;
    }
    if (hunk.oldConsumed > hunk.oldLines || hunk.newConsumed > hunk.newLines) {
      complete = false;
    }
  }
  finishHunk();
  if (patch.trim().length > 0 && !sawHunk) {
    complete = false;
  }
  if (!complete) {
    // Proof is optional, but completeness is all-or-nothing. Never let rows classified before a
    // later malformed/cut body authorize hiding executable changes from an untrusted patch.
    diffLines.forEach((row) => {
      delete row.sourceCommentOnly;
      delete row.sourceCommentLineOnly;
    });
  }
  return { ranges, oldRanges, edits, kinds, diffLines, added, deleted, complete };
}

function annotateSourceCommentRuns(
  file: string,
  hunk: ActiveHunk,
  typescriptProjector: TypeScriptCommentProjector | undefined,
): void {
  let oldProjection: readonly SourceLineCommentProjection[] | null;
  let newProjection: readonly SourceLineCommentProjection[] | null;
  try {
    oldProjection = commentProjection(file, hunk.oldSource, hunk.oldStart, typescriptProjector);
    newProjection = commentProjection(file, hunk.newSource, hunk.newStart, typescriptProjector);
  } catch {
    // Comment facts are optional enrichment. Parser limits or malformed source must never abort
    // authoritative diff-row extraction; leave the rows visible and otherwise untouched.
    return;
  }

  const oldByLine = new Map((oldProjection ?? []).map((line) => [line.line, line]));
  const newByLine = new Map((newProjection ?? []).map((line) => [line.line, line]));
  const oldSemanticPythonMetadataLines = semanticPythonMetadataLines(
    file,
    hunk.oldSource,
    hunk.oldStart,
  );
  const newSemanticPythonMetadataLines = semanticPythonMetadataLines(
    file,
    hunk.newSource,
    hunk.newStart,
  );
  const wholeHunkSourceUnchanged = (
    oldProjection !== null
    && newProjection !== null
    && sourceCodeSignature(oldProjection) === sourceCodeSignature(newProjection)
  );
  const requiresWholeHunkProof = JAVASCRIPT_EXTENSIONS.has(fileExtension(file));
  for (const run of hunk.runs) {
    const oldRows = run.rows.filter(
      (row): row is ChangedDiffLine & { oldLine: number } =>
        row.kind === "deleted" && row.oldLine !== null,
    );
    const newRows = run.rows.filter(
      (row): row is ChangedDiffLine & { newLine: number } =>
        row.kind === "added" && row.newLine !== null,
    );
    if ((oldRows.length > 0 && oldProjection === null) || (newRows.length > 0 && newProjection === null)) {
      continue;
    }
    const oldLines = oldRows.map((row) => oldByLine.get(row.oldLine));
    const newLines = newRows.map((row) => newByLine.get(row.newLine));
    if (oldLines.some((line) => line === undefined) || newLines.some((line) => line === undefined)) {
      continue;
    }
    const oldChanged = oldLines as SourceLineCommentProjection[];
    const newChanged = newLines as SourceLineCommentProjection[];
    const hasComment = [...oldChanged, ...newChanged].some((line) => line.comment);
    const eofNewlineChanged = oldRows.some((row) => row.noNewline === true)
      !== newRows.some((row) => row.noNewline === true);
    const hasSemanticDirective = [...oldChanged, ...newChanged]
      .some((line) => line.semanticDirective === true)
      || hasSemanticPythonDirective(
        file,
        run.rows,
        oldSemanticPythonMetadataLines,
        newSemanticPythonMetadataLines,
      );
    if (
      !hasComment
      || eofNewlineChanged
      || hasSemanticDirective
    ) {
      continue;
    }
    if (requiresWholeHunkProof && !wholeHunkSourceUnchanged) {
      // A `//` row with no block-comment terminator cannot change lexical ownership beyond its
      // physical line. Preserve that narrow fact even when the same run also adds executable code
      // (notably a newly added source file), while block-comment boundaries still fail open.
      oldRows.forEach((row, index) => {
        if (
          isCommentOnlyProjection(oldChanged[index])
          && isBoundaryIndependentJavaScriptComment(row.text)
        ) {
          row.sourceCommentOnly = true;
          row.sourceCommentLineOnly = true;
        }
      });
      newRows.forEach((row, index) => {
        if (
          isCommentOnlyProjection(newChanged[index])
          && isBoundaryIndependentJavaScriptComment(row.text)
        ) {
          row.sourceCommentOnly = true;
          row.sourceCommentLineOnly = true;
        }
      });
      continue;
    }
    oldRows.forEach((row, index) => {
      if (isCommentOnlyProjection(oldChanged[index])) row.sourceCommentLineOnly = true;
    });
    newRows.forEach((row, index) => {
      if (isCommentOnlyProjection(newChanged[index])) row.sourceCommentLineOnly = true;
    });
    if (sourceCodeSignature(oldChanged) === sourceCodeSignature(newChanged)) {
      run.rows.forEach((row) => {
        row.sourceCommentOnly = true;
      });
      continue;
    }
    oldRows.forEach((row, index) => {
      if (isCommentOnlyProjection(oldChanged[index])) row.sourceCommentOnly = true;
    });
    newRows.forEach((row, index) => {
      if (isCommentOnlyProjection(newChanged[index])) row.sourceCommentOnly = true;
    });
  }
}

function isCommentOnlyProjection(line: SourceLineCommentProjection): boolean {
  return line.comment && line.code.trim().length === 0;
}

function isBoundaryIndependentJavaScriptComment(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("//") && !trimmed.includes("*/");
}

function commentProjection(
  file: string,
  sourceLines: readonly string[],
  startLine: number,
  typescriptProjector: TypeScriptCommentProjector | undefined,
): readonly SourceLineCommentProjection[] | null {
  if (sourceLines.length === 0) return [];
  if (
    sourceLines.length > SOURCE_COMMENT_MAX_LINES
    || sourceLines.reduce((total, line) => total + line.length + 1, 0) > SOURCE_COMMENT_MAX_CHARS
  ) {
    return null;
  }
  const extension = fileExtension(file);
  const source = sourceLines.join("\n");
  if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    // The web parent parses attacker-controlled GitHub patches and deliberately does not load the
    // TypeScript AST stack. JavaScript-family proof is available only when the repository-analysis
    // path injects its bounded parser; otherwise fail open.
    return startLine === 1 && typescriptProjector !== undefined
      ? typescriptProjector(file, source, startLine)
      : null;
  }
  if (PYTHON_EXTENSIONS.has(extension)) {
    // Python indentation and triple-quoted strings make an arbitrary partial fragment ambiguous.
    return startLine === 1 ? sourceLineCommentProjections(file, source, startLine) : null;
  }
  return null;
}

function sourceCodeSignature(lines: readonly SourceLineCommentProjection[]): string {
  return lines
    // Ignore only rows proven to contain comments and no non-whitespace source. Whitespace inside
    // template/triple-quoted strings is executable data even when it occupies a whole physical
    // row, and Python indentation is semantic, so preserve every other code projection exactly.
    .map((line) => line.code)
    .filter((code, index) => !(lines[index].comment && code.trim().length === 0))
    .join("\n");
}

/**
 * Some comment-shaped text controls compilers, bundlers, linters, formatters, or interpreters.
 * Those edits are semantically reviewable even when ordinary source tokens are unchanged, so
 * deliberately fail open instead of allowing them to remove a file from the review graph.
 */
function hasSemanticPythonDirective(
  file: string,
  rows: readonly ChangedDiffLine[],
  oldSemanticMetadataLines: ReadonlySet<number>,
  newSemanticMetadataLines: ReadonlySet<number>,
): boolean {
  const extension = fileExtension(file);
  return PYTHON_EXTENSIONS.has(extension)
    && rows.some((row) => {
      const line = row.kind === "added" ? row.newLine : row.oldLine;
      const { text } = row;
      return (
        line !== null
        && (
          row.kind === "added"
            ? newSemanticMetadataLines.has(line)
            : oldSemanticMetadataLines.has(line)
        )
      )
        || (line === 1 && /^\s*#!/.test(text))
        || ((line ?? Number.POSITIVE_INFINITY) <= 2 && /^\s*#.*?coding\s*[:=]/i.test(text))
        || /#\s*(?:type:|noqa\b|nosec\b|fmt:|isort:)/i.test(text)
        || /#\s*(?:pragma|pyright|pytype|mypy|ruff|flake8|pylint|bandit|coverage|cython|distutils)\s*[:=]/i.test(text)
        || /#\s*pyre(?:-(?:strict|unsafe|ignore(?:-all-errors)?|fixme)\b|\s*[:=])/i.test(text)
        || /#\s*pythran\b/i.test(text)
        || /#\s*(?:yapf\s*:|nosemgrep\b|NOSONAR\b)/i.test(text);
    });
}

/**
 * Mark comment-owned Python ranges whose surrounding context gives them executable/tooling meaning.
 * PEP 723 embeds packaging/runtime input in otherwise comment-only rows. Pythran signatures can
 * continue across several `#` rows, so a changed continuation inherits the opening directive.
 */
function semanticPythonMetadataLines(
  file: string,
  sourceLines: readonly string[],
  startLine: number,
): ReadonlySet<number> {
  if (!PYTHON_EXTENSIONS.has(fileExtension(file))) return new Set<number>();
  const semantic = new Set<number>();
  for (let index = 0; index < sourceLines.length; index += 1) {
    if (sourceLines[index] === "# /// script") {
      let end = index;
      while (end + 1 < sourceLines.length && sourceLines[end + 1] !== "# ///") end += 1;
      if (end + 1 < sourceLines.length) end += 1;
      for (let line = index; line <= end; line += 1) {
        semantic.add(startLine + line);
      }
      index = end;
      continue;
    }
    if (/^\s*#\s*pythran\b/i.test(sourceLines[index])) {
      semantic.add(startLine + index);
      let balance = pythranDelimiterBalance(sourceLines[index]);
      let continued = balance > 0 || /\\\s*$/.test(sourceLines[index]);
      while (
        continued
        && index + 1 < sourceLines.length
        && /^\s*#/.test(sourceLines[index + 1])
      ) {
        index += 1;
        semantic.add(startLine + index);
        balance += pythranDelimiterBalance(sourceLines[index]);
        continued = balance > 0 || /\\\s*$/.test(sourceLines[index]);
      }
    }
  }
  return semantic;
}

function pythranDelimiterBalance(line: string): number {
  let balance = 0;
  for (const character of line) {
    if (character === "(" || character === "[" || character === "{") balance += 1;
    if (character === ")" || character === "]" || character === "}") balance -= 1;
  }
  return balance;
}

function fileExtension(file: string): string {
  const path = file.toLowerCase();
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot);
}

interface HunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

function parseHunkHeader(line: string): HunkHeader | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }
  const parsed = {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
  if (
    !Object.values(parsed).every(Number.isSafeInteger)
    || parsed.oldStart < 0
    || parsed.newStart < 0
    || parsed.oldLines < 0
    || parsed.newLines < 0
    || (parsed.oldLines > 0 && parsed.oldStart === 0)
    || (parsed.newLines > 0 && parsed.newStart === 0)
  ) {
    return null;
  }
  return parsed;
}
