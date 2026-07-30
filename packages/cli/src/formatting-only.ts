/**
 * Conservative, edit-grained proof that a TypeScript diff run changes layout only.
 *
 * This deliberately does not load a tsconfig, ESLint, Prettier, plugins, or repository code. The
 * trusted CLI parses two in-memory full-file texts with its bundled TypeScript parser: the exact
 * HEAD-side source and a hybrid with one exact diff edit reverted. A proof is emitted only when
 * both parse, their structural syntax trees match after ignoring a trailing comma, and neither
 * side's replaced rows contain comments/directives. Adjacent compiler/tool directives also veto;
 * unchanged whole-line documentation remains eligible (including the Autopilot #4123 example).
 *
 * Python is intentionally fail-open for now. A trustworthy Python proof would need a bounded,
 * timeout-controlled stdlib `ast` + `tokenize` subprocess protocol; silently approximating it in
 * TypeScript would make review filtering less safe.
 */

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  FORMATTING_ONLY_PROOF_VERSION,
  type ChangedDiffLine,
  type ChangedFileManifestEntry,
  type FormattingOnlyEdit,
  type FormattingOnlyProof,
} from "@meridian/core";
import { ts } from "ts-morph";

const MAX_PROOF_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROOF_EDITS_PER_FILE = 64;
const MAX_PROOF_EDITS_TOTAL = 512;
const MAX_PROOF_ROWS_TOTAL = 100_000;
const MAX_PROOF_PARSE_BYTES_PER_FILE = 16 * 1024 * 1024;
const MAX_PROOF_PARSE_BYTES_TOTAL = 32 * 1024 * 1024;

/** Internal lossless input derived from one complete local unified-diff edit run. */
export interface FormattingProofCandidate extends Omit<FormattingOnlyEdit, "oldRows" | "newRows"> {
  addedRows: readonly ChangedDiffLine[];
  deletedRows: readonly ChangedDiffLine[];
}

/**
 * Prove each candidate independently by reverting only that edit in the current file.
 *
 * The result is always a valid v1 proof, including when every candidate fails open. Individual
 * file/read/parser failures omit proof entries; they never fail repository extraction.
 */
export async function proveFormattingOnlyEdits(
  absoluteRoot: string,
  candidates: readonly FormattingProofCandidate[],
  manifest: readonly ChangedFileManifestEntry[],
): Promise<FormattingOnlyProof> {
  if (candidates.length > MAX_PROOF_EDITS_TOTAL) {
    return emptyProof();
  }
  const modifiedPaths = new Set(
    manifest.filter((entry) => entry.status === "modified").map((entry) => entry.path),
  );
  const byPath = new Map<string, FormattingProofCandidate[]>();
  for (const candidate of candidates) {
    if (
      !modifiedPaths.has(candidate.path)
      || !isSafeRelativePath(candidate.path)
      || !isTypeScriptPath(candidate.path)
    ) {
      continue;
    }
    const fileCandidates = byPath.get(candidate.path) ?? [];
    fileCandidates.push(candidate);
    byPath.set(candidate.path, fileCandidates);
  }

  const proven: FormattingOnlyEdit[] = [];
  let estimatedParseBytes = 0;
  let provenRows = 0;
  for (const [path, fileCandidates] of byPath) {
    if (fileCandidates.length > MAX_PROOF_EDITS_PER_FILE) {
      continue;
    }
    const source = await readBoundedRegularUtf8File(absoluteRoot, path);
    if (source === null) {
      continue;
    }
    let fileParseBytes = Buffer.byteLength(source, "utf8");
    if (
      fileParseBytes > MAX_PROOF_PARSE_BYTES_PER_FILE
      || estimatedParseBytes + fileParseBytes > MAX_PROOF_PARSE_BYTES_TOTAL
    ) {
      continue;
    }
    estimatedParseBytes += fileParseBytes;
    const split = splitSource(source);
    const currentText = joinSource(split.lines, split.finalNewline);
    let current: ParsedTypeScript | null;
    let currentSyntax: string[];
    try {
      current = parseTypeScript(path, currentText);
      if (current === null) {
        continue;
      }
      currentSyntax = structuralSyntax(current.sourceFile, currentText);
    } catch {
      continue;
    }
    for (const candidate of fileCandidates) {
      try {
        if (!candidateMatchesCurrentSource(candidate, split)) {
          continue;
        }
        const reverted = revertCandidate(candidate, split);
        if (reverted === null) {
          continue;
        }
        const hybridText = joinSource(reverted.lines, reverted.finalNewline);
        const hybridBytes = Buffer.byteLength(hybridText, "utf8");
        if (
          hybridBytes > MAX_PROOF_FILE_BYTES
          || fileParseBytes + hybridBytes > MAX_PROOF_PARSE_BYTES_PER_FILE
          || estimatedParseBytes + hybridBytes > MAX_PROOF_PARSE_BYTES_TOTAL
        ) {
          continue;
        }
        fileParseBytes += hybridBytes;
        estimatedParseBytes += hybridBytes;
        const hybrid = parseTypeScript(path, hybridText);
        if (
          hybrid === null
          || !sameSyntax(current.diagnostics, hybrid.diagnostics)
          || hasCommentsOrDirectivesInEdit(
            current.sourceFile,
            currentText,
            sensitiveLines(candidate.newStart, candidate.newLines, split.lines.length),
            adjacentLines(candidate.newStart, candidate.newLines, split.lines.length),
          )
          || hasCommentsOrDirectivesInEdit(
            hybrid.sourceFile,
            hybridText,
            sensitiveLines(candidate.newStart, candidate.oldLines, reverted.lines.length),
            adjacentLines(candidate.newStart, candidate.oldLines, reverted.lines.length),
          )
          || !sameSyntax(currentSyntax, structuralSyntax(hybrid.sourceFile, hybridText))
        ) {
          continue;
        }
        const candidateRows = candidate.oldLines + candidate.newLines;
        if (provenRows + candidateRows > MAX_PROOF_ROWS_TOTAL) {
          continue;
        }
        provenRows += candidateRows;
        proven.push(coordinatesOf(candidate));
      } catch {
        // Advisory proof must fail open on any parser/scanner/source-shape surprise.
      }
    }
  }
  proven.sort(compareFormattingOnlyEdits);
  return { version: FORMATTING_ONLY_PROOF_VERSION, edits: proven };
}

function emptyProof(): FormattingOnlyProof {
  return { version: FORMATTING_ONLY_PROOF_VERSION, edits: [] };
}

function coordinatesOf(candidate: FormattingProofCandidate): FormattingOnlyEdit {
  return {
    path: candidate.path,
    oldStart: candidate.oldStart,
    oldLines: candidate.oldLines,
    newStart: candidate.newStart,
    newLines: candidate.newLines,
    oldRows: candidate.deletedRows.map((row) => ({
      text: row.text,
      noNewline: row.noNewline === true,
    })),
    newRows: candidate.addedRows.map((row) => ({
      text: row.text,
      noNewline: row.noNewline === true,
    })),
  };
}

function compareFormattingOnlyEdits(left: FormattingOnlyEdit, right: FormattingOnlyEdit): number {
  return compareStrings(left.path, right.path)
    || left.newStart - right.newStart
    || left.oldStart - right.oldStart
    || left.newLines - right.newLines
    || left.oldLines - right.oldLines;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isTypeScriptPath(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0
    && !path.startsWith("/")
    && !(process.platform === "win32" && (path.includes("\\") || /^[A-Za-z]:/.test(path)))
    && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

async function readBoundedRegularUtf8File(absoluteRoot: string, path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const segments = path.split("/");
    let current = absoluteRoot;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        return null;
      }
      if (index === segments.length - 1 && stat.size > MAX_PROOF_FILE_BYTES) {
        return null;
      }
    }
    const canonicalRoot = await realpath(absoluteRoot);
    const canonicalFile = await realpath(current);
    const containment = relative(canonicalRoot, canonicalFile);
    if (
      containment.length === 0
      || containment === ".."
      || containment.startsWith(`..${sep}`)
      || isAbsolute(containment)
    ) {
      return null;
    }
    handle = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_PROOF_FILE_BYTES) {
      return null;
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength > MAX_PROOF_FILE_BYTES
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      return null;
    }
    const source = bytes.toString("utf8");
    return Buffer.from(source, "utf8").equals(bytes) ? source : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface SplitSource {
  lines: string[];
  finalNewline: boolean;
}

function splitSource(source: string): SplitSource {
  if (source.length === 0) {
    return { lines: [], finalNewline: false };
  }
  const normalized = source.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) {
    lines.pop();
  }
  return { lines, finalNewline };
}

function joinSource(lines: readonly string[], finalNewline: boolean): string {
  return `${lines.join("\n")}${finalNewline && lines.length > 0 ? "\n" : ""}`;
}

function candidateMatchesCurrentSource(
  candidate: FormattingProofCandidate,
  source: SplitSource,
): boolean {
  if (
    !validCoordinate(candidate.oldStart)
    || !validCoordinate(candidate.newStart)
    || !validCount(candidate.oldLines)
    || !validCount(candidate.newLines)
    || (candidate.oldLines === 0 && candidate.newLines === 0)
    || candidate.addedRows.length !== candidate.newLines
    || candidate.deletedRows.length !== candidate.oldLines
  ) {
    return false;
  }
  const startIndex = candidate.newStart - 1;
  if (
    startIndex > source.lines.length
    || (candidate.newLines > 0 && startIndex + candidate.newLines > source.lines.length)
  ) {
    return false;
  }
  for (let index = 0; index < candidate.addedRows.length; index += 1) {
    const row = candidate.addedRows[index];
    const line = candidate.newStart + index;
    if (
      row.kind !== "added"
      || row.oldLine !== null
      || row.newLine !== line
      || row.beforeNewLine !== line
      || row.text !== source.lines[startIndex + index]
      || (row.noNewline === true && (line !== source.lines.length || source.finalNewline))
    ) {
      return false;
    }
  }
  for (let index = 0; index < candidate.deletedRows.length; index += 1) {
    const row = candidate.deletedRows[index];
    if (
      row.kind !== "deleted"
      || row.oldLine !== candidate.oldStart + index
      || row.newLine !== null
      || row.beforeNewLine !== candidate.newStart
      || (row.noNewline === true && index !== candidate.deletedRows.length - 1)
    ) {
      return false;
    }
  }
  if (
    candidate.newLines > 0
    && startIndex + candidate.newLines === source.lines.length
    && !source.finalNewline
    && candidate.addedRows[candidate.addedRows.length - 1]?.noNewline !== true
  ) {
    return false;
  }
  return true;
}

function revertCandidate(
  candidate: FormattingProofCandidate,
  source: SplitSource,
): SplitSource | null {
  const startIndex = candidate.newStart - 1;
  const touchesHeadEnd = startIndex + candidate.newLines === source.lines.length;
  // A pure addition at EOF carries no deleted row from which to recover the old newline state.
  if (touchesHeadEnd && candidate.oldLines === 0) {
    return null;
  }
  const lines = [...source.lines];
  lines.splice(
    startIndex,
    candidate.newLines,
    ...candidate.deletedRows.map((row) => row.text),
  );
  const finalNewline = touchesHeadEnd
    ? candidate.deletedRows[candidate.deletedRows.length - 1]?.noNewline !== true
    : source.finalNewline;
  return { lines, finalNewline };
}

function validCoordinate(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

type ParsedSourceFile = ts.SourceFile & {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
};

interface ParsedTypeScript {
  sourceFile: ParsedSourceFile;
  diagnostics: string[];
}

function parseTypeScript(path: string, source: string): ParsedTypeScript | null {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const virtualPath = path.endsWith(".d.ts")
    ? "/__meridian_format_proof__/source.d.ts"
    : path.endsWith(".tsx")
      ? "/__meridian_format_proof__/source.tsx"
      : "/__meridian_format_proof__/source.ts";
  const parsed = ts.createSourceFile(
    virtualPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind,
  ) as ParsedSourceFile;
  if (!Array.isArray(parsed.parseDiagnostics) || parsed.parseDiagnostics.length > 0) {
    return null;
  }
  const options: ts.CompilerOptions = {
    experimentalDecorators: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => fileName === virtualPath,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "/",
    getDefaultLibFileName: () => "/__meridian_format_proof__/no-lib.d.ts",
    getNewLine: () => "\n",
    getSourceFile: (fileName) => fileName === virtualPath ? parsed : undefined,
    readFile: (fileName) => fileName === virtualPath ? source : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };
  const program = ts.createProgram([virtualPath], options, host);
  const sourceFile = program.getSourceFile(virtualPath) as ParsedSourceFile | undefined;
  if (sourceFile === undefined) {
    return null;
  }
  const diagnostics = program.getSemanticDiagnostics(sourceFile)
    .map((diagnostic) =>
      `${diagnostic.category}:${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`
    )
    .sort(compareStrings);
  return { sourceFile, diagnostics };
}

/**
 * Canonical structural token tree. Source positions and trivia never enter the representation;
 * leaf text retains identifiers/literals and token kinds retain operators. Only a grammar-safe
 * trailing comma in a non-rest parameter list is omitted.
 */
function structuralSyntax(sourceFile: ts.SourceFile, source: string): string[] {
  const syntax: string[] = [];
  const stack: Array<{ node: ts.Node; close: boolean }> = [{ node: sourceFile, close: false }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) {
      break;
    }
    if (entry.close) {
      syntax.push(")");
      continue;
    }
    const node = entry.node;
    if (node.kind === ts.SyntaxKind.CommaToken && commaClosesList(node, sourceFile, source)) {
      continue;
    }
    const children = node.getChildren(sourceFile);
    syntax.push(children.length === 0 ? `(${node.kind}:${node.getText(sourceFile)}` : `(${node.kind}`);
    stack.push({ node, close: true });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], close: false });
    }
  }
  return syntax;
}

function commaClosesList(node: ts.Node, sourceFile: ts.SourceFile, source: string): boolean {
  const parent = node.parent;
  if (!(
    ts.isArrowFunction(parent)
    || ts.isCallSignatureDeclaration(parent)
    || ts.isConstructSignatureDeclaration(parent)
    || ts.isConstructorDeclaration(parent)
    || ts.isConstructorTypeNode(parent)
    || ts.isFunctionDeclaration(parent)
    || ts.isFunctionExpression(parent)
    || ts.isFunctionTypeNode(parent)
    || ts.isMethodDeclaration(parent)
    || ts.isMethodSignature(parent)
  )) {
    return false;
  }
  const lastParameter = parent.parameters.at(-1);
  if (
    !parent.parameters.hasTrailingComma
    || lastParameter === undefined
    || lastParameter.dotDotDotToken !== undefined
  ) {
    return false;
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    sourceFile.languageVariant,
    source,
  );
  scanner.setTextPos(node.end);
  return scanner.scan() === ts.SyntaxKind.CloseParenToken;
}

function sameSyntax(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function sensitiveLines(start: number, count: number, totalLines: number): ReadonlySet<number> {
  const lines = new Set<number>();
  const last = Math.min(totalLines, start + count - 1);
  for (let line = Math.max(1, start); line <= last; line += 1) {
    lines.add(line);
  }
  return lines;
}

function adjacentLines(start: number, count: number, totalLines: number): ReadonlySet<number> {
  const lines = new Set<number>();
  const first = Math.max(1, start - 1);
  const last = Math.min(totalLines, start + count);
  for (let line = first; line <= last; line += 1) {
    lines.add(line);
  }
  return lines;
}

function hasCommentsOrDirectivesInEdit(
  sourceFile: ts.SourceFile,
  source: string,
  sensitive: ReadonlySet<number>,
  adjacent: ReadonlySet<number>,
): boolean {
  if (sensitive.size === 0 && adjacent.size === 0) {
    return false;
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    source,
  );
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia
      || kind === ts.SyntaxKind.MultiLineCommentTrivia
      || kind === ts.SyntaxKind.ShebangTrivia
      || kind === ts.SyntaxKind.ConflictMarkerTrivia
    ) {
      const start = scanner.getTokenPos();
      const end = Math.max(start, scanner.getTextPos() - 1);
      const changed = lineSpanIntersects(sourceFile, start, end, sensitive);
      const directive = (
        kind === ts.SyntaxKind.ShebangTrivia
        || kind === ts.SyntaxKind.ConflictMarkerTrivia
        || looksLikeCommentDirective(source.slice(start, scanner.getTextPos()))
      );
      if (changed || (directive && lineSpanIntersects(sourceFile, start, end, adjacent))) {
        return true;
      }
    }
  }

  const nodes: ts.Node[] = [...sourceFile.statements];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (node === undefined) {
      break;
    }
    if (
      ts.isExpressionStatement(node)
      && ts.isStringLiteral(node.expression)
      && (lineSpanIntersects(
        sourceFile,
        node.getStart(sourceFile),
        Math.max(node.getStart(sourceFile), node.end - 1),
        sensitive,
      ) || lineSpanIntersects(
        sourceFile,
        node.getStart(sourceFile),
        Math.max(node.getStart(sourceFile), node.end - 1),
        adjacent,
      ))
    ) {
      return true;
    }
    node.forEachChild((child) => {
      nodes.push(child);
    });
  }
  return false;
}

function looksLikeCommentDirective(comment: string): boolean {
  return /(?:@|#|<reference\b|eslint|prettier|biome|istanbul|\bc8\b|sourceMappingURL|sourceURL)/i.test(comment);
}

function lineSpanIntersects(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
  sensitive: ReadonlySet<number>,
): boolean {
  const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(end).line + 1;
  for (let line = startLine; line <= endLine; line += 1) {
    if (sensitive.has(line)) {
      return true;
    }
  }
  return false;
}
