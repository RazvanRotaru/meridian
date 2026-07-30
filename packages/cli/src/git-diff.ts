/**
 * Turning "what did this PR change?" into per-file line ranges the tagger can join on.
 *
 * `changedRangesSince(root, base)` runs `git diff --merge-base <base>` — the merge-base three-dot
 * semantics a PR review shows — against the WORKING TREE, so uncommitted edits count too.
 * `--relative` (with git running IN the extraction root) makes every path root-relative, matching
 * `node.location.file` verbatim even when the root is a subdirectory of the repository.
 *
 * Security mirrors `server/git-exec.ts`: argv-only spawn (no shell), a `--` fence before any
 * user-supplied ref is NOT possible (refs precede paths in `git diff`), so the ref is validated
 * against a conservative grammar instead; stderr is size-capped and the run is time-boxed.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  ChangedDiffLines,
  ChangedFileManifestEntry,
  ChangedLineKinds,
  ChangedLineStats,
  ChangedRanges,
  FormattingOnlyProof,
} from "@meridian/core";
import { CliError, EXIT } from "./errors";
import {
  proveFormattingOnlyEdits,
  type FormattingProofCandidate,
} from "./formatting-only";
import { parseUnifiedDiffBody } from "./unified-diff";
import { typescriptLineCommentProjections } from "./typescript-source-comments";

const DIFF_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
// Optional supported-source proof. Prioritize U0 rows that already look comment-shaped so a large
// PR still classifies its likely candidates; the bounded remainder catches ambiguous block-comment
// interiors when capacity permits.
const SOURCE_COMMENT_CONTEXT_LINES = 999_999;
const SOURCE_COMMENT_CONTEXT_FILE_CAP = 200;
/** Branch/tag/sha/HEAD~n shapes; refuses anything that could read as a `git diff` option. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/~^-]*$/;

/** Injectable so authenticated server flows can reuse their token-scrubbing git executor. */
export type GitDiffExecutor = (absoluteRoot: string, args: string[], timeoutMs: number) => Promise<string>;

export async function changedRangesSince(absoluteRoot: string, baseRef: string, timeoutMs?: number): Promise<ChangedRanges> {
  const changed = await changedSinceMetadata(absoluteRoot, baseRef, timeoutMs);
  return changed.ranges;
}

export async function changedSinceMetadata(
  absoluteRoot: string,
  baseRef: string,
  timeoutMs = DIFF_TIMEOUT_MS,
  executeGitDiff: GitDiffExecutor = runGitDiff,
): Promise<{
  ranges: ChangedRanges;
  stats: ChangedLineStats;
  kinds: ChangedLineKinds;
  diffLines: ChangedDiffLines;
  manifest: ChangedFileManifestEntry[];
  formattingOnly: FormattingOnlyProof;
}> {
  const ref = validatedRef(baseRef);
  const patchArgs = [
    "diff",
    "--merge-base",
    ref,
    "--relative",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
  ];
  const patch = await executeGitDiff(absoluteRoot, patchArgs, timeoutMs);
  // U0 is the authoritative row transaction but not a complete lexical source view. Even a hunk
  // beginning at line 1 can omit unchanged code whose meaning changes when a block-comment
  // delimiter moves, so comment proof is admitted only from the bounded contextual re-read below.
  const parsed = parseFullUnifiedDiff(patch);
  if (!parsed.complete) {
    throw new CliError(EXIT.io, "git diff output contained an incomplete hunk; refusing to persist a partial diff");
  }
  const manifestArgs = [
    "diff",
    "--merge-base",
    ref,
    "--relative",
    "--name-status",
    "-z",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
  ];
  // Keep both views all-or-nothing. Line details are never published if the exact file inventory
  // is malformed/truncated, and the manifest is never published beside a partial patch body.
  const manifestOutput = await executeGitDiff(absoluteRoot, manifestArgs, timeoutMs);
  const rawManifest = parseNameStatusManifest(manifestOutput);
  if (!patchMatchesManifest(patch, rawManifest)) {
    throw new CliError(
      EXIT.io,
      "git diff patch paths did not match the exact file manifest; retry the analysis",
    );
  }
  const manifest = rawManifest.map((entry) => parsed.nonTextualPaths.has(entry.path)
    ? { ...entry, nonTextualChanges: true as const }
    : entry);
  const formattingOnly = await proveFormattingOnlyEdits(
    absoluteRoot,
    parsed.formattingCandidates,
    manifest,
  );
  await mergeSourceCommentContext(
    absoluteRoot,
    ref,
    timeoutMs,
    executeGitDiff,
    parsed,
    manifest,
  );
  const verifiedManifestOutput = await executeGitDiff(absoluteRoot, manifestArgs, timeoutMs);
  if (!Buffer.from(manifestOutput, "utf8").equals(Buffer.from(verifiedManifestOutput, "utf8"))) {
    throw new CliError(EXIT.io, "working tree changed while reading git diff manifest; retry the analysis");
  }
  // `git diff` reads the index and working tree independently on every invocation. If either
  // changes between the patch and name-status reads, their otherwise-valid outputs can describe
  // different revisions. Re-read after the proof's HEAD-side file reads and publish nothing unless
  // the exact UTF-8 patch bytes still match the first read.
  const verifiedPatch = await executeGitDiff(absoluteRoot, patchArgs, timeoutMs);
  if (!Buffer.from(patch, "utf8").equals(Buffer.from(verifiedPatch, "utf8"))) {
    throw new CliError(EXIT.io, "working tree changed while reading git diff metadata; retry the analysis");
  }
  return {
    ranges: parsed.ranges,
    stats: parsed.stats,
    kinds: parsed.kinds,
    diffLines: parsed.diffLines,
    manifest,
    formattingOnly,
  };
}

async function mergeSourceCommentContext(
  absoluteRoot: string,
  ref: string,
  timeoutMs: number,
  executeGitDiff: GitDiffExecutor,
  parsed: ParsedFullUnifiedDiff,
  manifest: readonly ChangedFileManifestEntry[],
): Promise<void> {
  const candidates = sourceCommentContextCandidates(parsed.diffLines, manifest);
  if (candidates.length === 0) return;
  const manifestByPath = new Map(manifest.map((file) => [file.path, file]));
  const candidatePathspecs = [...new Set(candidates.flatMap((path) => {
    const file = manifestByPath.get(path);
    return file?.status === "renamed"
      ? [file.previousPath, file.path]
      : [path];
  }))];
  const args = [
    "diff",
    "--merge-base",
    ref,
    "--relative",
    `--unified=${SOURCE_COMMENT_CONTEXT_LINES}`,
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
    "--",
    // Git still parses argv after `--` as pathspec syntax. Force opaque repository identities so a
    // legal name such as `:(literal)comments.ts` selects itself rather than changing pathspec mode.
    // Both sides of a rename are required or Git can degrade the contextual read to an add/delete.
    ...candidatePathspecs.map((path) => `:(literal)${path}`),
  ];
  let contextual: ParsedFullUnifiedDiff;
  try {
    contextual = parseFullUnifiedDiff(await executeGitDiff(absoluteRoot, args, timeoutMs), true);
  } catch {
    // Comment classification is optional metadata. A large contextual read or unsupported injected
    // executor must fail open without discarding the exact U0 change transaction.
    return;
  }
  if (!contextual.complete) return;

  for (const path of candidates) {
    const exact = parsed.diffLines[path];
    const richer = contextual.diffLines[path];
    if (
      exact === undefined
      || richer === undefined
      || exact.length !== richer.length
      || !richer.every((row, index) => sameChangedDiffRow(row, exact[index]))
    ) {
      continue;
    }
    richer.forEach((row, index) => {
      if (row.sourceCommentOnly === true) exact[index].sourceCommentOnly = true;
      if (row.sourceCommentLineOnly === true) exact[index].sourceCommentLineOnly = true;
    });
  }
}

function sourceCommentContextCandidates(
  diffLines: ChangedDiffLines,
  manifest: readonly ChangedFileManifestEntry[],
): string[] {
  const manifestPaths = new Set(manifest.map((file) => file.path));
  return Object.entries(diffLines)
    .filter(([path, rows]) => (
      manifestPaths.has(path)
      && rows.length > 0
      && supportsSourceComments(path)
    ))
    .map(([path, rows]) => ({
      path,
      priority: rows.every((row) => looksEntirelyCommentShaped(path, row.text))
        ? 2
        : rows.some((row) => looksCommentShaped(path, row.text)) ? 1 : 0,
    }))
    .sort((left, right) => right.priority - left.priority || comparePathsDeterministically(left.path, right.path))
    .slice(0, SOURCE_COMMENT_CONTEXT_FILE_CAP)
    .map(({ path }) => path);
}

function comparePathsDeterministically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function looksEntirelyCommentShaped(path: string, text: string): boolean {
  const trimmed = text.trimStart();
  const extension = fileExtension(path);
  return extension === ".py" || extension === ".pyi"
    ? trimmed.startsWith("#")
    : trimmed.startsWith("//")
      || trimmed.startsWith("/*")
      || trimmed.startsWith("*/")
      || trimmed.startsWith("*");
}

function looksCommentShaped(path: string, text: string): boolean {
  const extension = fileExtension(path);
  return extension === ".py" || extension === ".pyi"
    ? text.includes("#")
    : text.includes("//") || text.includes("/*") || text.includes("*/") || /^\s*\*/.test(text);
}

function supportsSourceComments(path: string): boolean {
  const extension = fileExtension(path);
  return [
    ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".pyi",
  ].includes(extension);
}

function sameChangedDiffRow(left: ChangedDiffLines[string][number], right: ChangedDiffLines[string][number]): boolean {
  return left.kind === right.kind
    && left.oldLine === right.oldLine
    && left.newLine === right.newLine
    && left.beforeNewLine === right.beforeNewLine
    && left.text === right.text
    && left.noNewline === right.noNewline;
}

function fileExtension(file: string): string {
  const path = file.toLowerCase();
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot);
}

export function validatedRef(baseRef: string): string {
  const ref = baseRef.trim();
  if (!SAFE_REF.test(ref)) {
    throw new CliError(EXIT.usage, `--changed-since ref looks invalid: '${baseRef}'`);
  }
  return ref;
}

/**
 * Parse `git diff --name-status -z` without applying Git's C-style path unquoting.
 *
 * With `-z`, status and path fields are NUL-delimited and paths are literal, so tabs, quotes, and
 * newlines in a file name cannot corrupt field boundaries. Unknown statuses and unsafe paths fail
 * the whole transaction closed instead of silently losing a changed file.
 */
export function parseNameStatusManifest(output: string): ChangedFileManifestEntry[] {
  if (output.length === 0) {
    return [];
  }
  if (!output.endsWith("\0")) {
    throw malformedManifest("missing final NUL delimiter");
  }
  const fields = output.slice(0, -1).split("\0");
  const manifest: ChangedFileManifestEntry[] = [];
  const seenPaths = new Set<string>();
  let cursor = 0;

  const take = (label: string): string => {
    const value = fields[cursor];
    cursor += 1;
    if (value === undefined || value.length === 0) {
      throw malformedManifest(`missing ${label}`);
    }
    return value;
  };

  const append = (entry: ChangedFileManifestEntry): void => {
    if (!isSafeManifestPath(entry.path) || (entry.previousPath !== undefined && !isSafeManifestPath(entry.previousPath))) {
      throw malformedManifest("path is not extraction-root-relative");
    }
    if (seenPaths.has(entry.path)) {
      throw malformedManifest(`duplicate path '${entry.path}'`);
    }
    seenPaths.add(entry.path);
    manifest.push(entry);
  };

  while (cursor < fields.length) {
    const status = take("status");
    if (status === "A") {
      append({ path: take("added path"), status: "added" });
    } else if (status === "D") {
      append({ path: take("deleted path"), status: "deleted" });
    } else if (status === "M" || status === "T") {
      append({ path: take("modified path"), status: "modified" });
    } else if (renameScore(status) !== null) {
      const previousPath = take("rename old path");
      const path = take("rename new path");
      if (path === previousPath) {
        throw malformedManifest("rename paths are identical");
      }
      append({ path, status: "renamed", previousPath });
    } else {
      throw malformedManifest(`unsupported status '${status}'`);
    }
  }
  return manifest;
}

function renameScore(status: string): number | null {
  const match = /^R([0-9]{1,3})$/.exec(status);
  if (!match) {
    return null;
  }
  const score = Number(match[1]);
  return score <= 100 ? score : null;
}

function isSafeManifestPath(path: string): boolean {
  // `git diff -z` emits opaque repository paths. A backslash (or `C:` prefix) is an ordinary
  // filename character on POSIX, not a traversal separator; `/` is Git's only path separator.
  if (path.startsWith("/")) {
    return false;
  }
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function malformedManifest(reason: string): CliError {
  return new CliError(EXIT.io, `git diff --name-status output was malformed (${reason}); refusing a partial file manifest`);
}

/**
 * Parse `git diff -U0` output into inclusive 1-based ranges per NEW-side file path.
 *
 * Only the `+++ b/<path>` side matters — those are the paths (and line numbers) that exist in the
 * extracted tree. Deleted files (`+++ /dev/null`) have no nodes to tag and are skipped.
 */
export function parseUnifiedDiff(diff: string): ChangedRanges {
  return parseUnifiedDiffWithStats(diff).ranges;
}

export function parseUnifiedDiffWithStats(diff: string): {
  ranges: ChangedRanges;
  stats: ChangedLineStats;
  kinds: ChangedLineKinds;
  diffLines: ChangedDiffLines;
} {
  const parsed = parseFullUnifiedDiff(diff);
  return { ranges: parsed.ranges, stats: parsed.stats, kinds: parsed.kinds, diffLines: parsed.diffLines };
}

interface ParsedFullUnifiedDiff {
  ranges: ChangedRanges;
  stats: ChangedLineStats;
  kinds: ChangedLineKinds;
  diffLines: ChangedDiffLines;
  formattingCandidates: FormattingProofCandidate[];
  nonTextualPaths: Set<string>;
  complete: boolean;
}

function parseFullUnifiedDiff(diff: string, classifySourceComments = false): ParsedFullUnifiedDiff {
  // Git paths are opaque keys and may validly be named `__proto__`, `constructor`, or `toString`.
  // Null-prototype records keep those names as ordinary data throughout the prepared artifact.
  const changed = Object.create(null) as ChangedRanges;
  const stats = Object.create(null) as ChangedLineStats;
  const kinds = Object.create(null) as ChangedLineKinds;
  const diffLines = Object.create(null) as ChangedDiffLines;
  const formattingCandidates: FormattingProofCandidate[] = [];
  const nonTextualPaths = new Set<string>();
  let complete = true;

  for (const section of splitFileSections(diff)) {
    const sectionLines = section.split("\n");
    const newPathLine = sectionLines.find((line) => line.startsWith("+++ "));
    const oldPathLine = sectionLines.find((line) => line.startsWith("--- "));
    const headPath = newPathLine ? newSidePath(newPathLine) : null;
    const metadataPath = headPath ?? (oldPathLine ? oldSidePath(oldPathLine) : null);
    const hasNonTextualChange = sectionHasNonTextualChange(sectionLines);
    if (hasNonTextualChange && metadataPath !== null) nonTextualPaths.add(metadataPath);
    const firstHunk = section.search(/^@@/m);
    if (firstHunk < 0) {
      continue;
    }
    // Validate every body, including `+++ /dev/null`. An incomplete deleted-file hunk still proves
    // the Git output was cut and must fail the all-or-nothing metadata transaction. U0 local diffs
    // can prove self-contained line/block comments; GitHub's U3 body supplies richer lexical context.
    const detail = parseUnifiedDiffBody(
      section.slice(firstHunk),
      classifySourceComments ? metadataPath ?? undefined : undefined,
      classifySourceComments ? typescriptLineCommentProjections : undefined,
    );
    if (hasNonTextualChange) {
      // Executable-bit, file-type, symlink, and gitlink changes are semantic even when a textual
      // hunk happens to look like source comments. Withhold optional proof for the whole file.
      detail.diffLines.forEach((row) => {
        delete row.sourceCommentOnly;
        delete row.sourceCommentLineOnly;
      });
    }
    complete &&= detail.complete;

    // Ranges and kinds address rows in HEAD, so a fully removed file must never manufacture them
    // from base-side coordinates. Stats and exact diff rows are side-aware and remain useful for
    // deleted source, so retain those under the old/base path instead.
    if (headPath !== null && detail.ranges.length > 0) {
      (changed[headPath] ??= []).push(...detail.ranges);
    }
    if (metadataPath !== null && (detail.added > 0 || detail.deleted > 0)) {
      const file = (stats[metadataPath] ??= { added: 0, deleted: 0 });
      file.added += detail.added;
      file.deleted += detail.deleted;
    }
    if (headPath !== null && detail.kinds.length > 0) {
      (kinds[headPath] ??= []).push(...detail.kinds);
    }
    if (metadataPath !== null && detail.diffLines.length > 0) {
      (diffLines[metadataPath] ??= []).push(...detail.diffLines);
    }
    if (headPath !== null && !hasNonTextualChange) {
      for (const edit of detail.edits) {
        formattingCandidates.push({
          path: headPath,
          ...edit,
          addedRows: detail.diffLines.filter((row) =>
            row.kind === "added"
            && row.newLine !== null
            && row.newLine >= edit.newStart
            && row.newLine < edit.newStart + edit.newLines
          ),
          deletedRows: detail.diffLines.filter((row) =>
            row.kind === "deleted"
            && row.oldLine !== null
            && row.oldLine >= edit.oldStart
            && row.oldLine < edit.oldStart + edit.oldLines
          ),
        });
      }
    }
  }
  return {
    ranges: changed,
    stats,
    kinds,
    diffLines,
    formattingCandidates,
    nonTextualPaths,
    complete,
  };
}

function sectionHasNonTextualChange(lines: readonly string[]): boolean {
  if (lines.some((line) => /^(?:old|new) mode \d{6}$/.test(line))) {
    return true;
  }
  const modes = lines.flatMap((line) => {
    const indexMode = /^index \S+\.\.\S+ (\d{6})$/.exec(line)?.[1];
    const fileMode = /^(?:new|deleted) file mode (\d{6})$/.exec(line)?.[1];
    return indexMode ?? fileMode ?? [];
  });
  return modes.some((mode) => mode !== "100644" && mode !== "100755");
}

/**
 * Corroborate the patch and name-status reads before publishing either. Git may read a changing
 * index/worktree between invocations; stable patch bytes alone do not prove that the separately
 * read manifest names the same transaction.
 */
function patchMatchesManifest(
  patch: string,
  manifest: readonly ChangedFileManifestEntry[],
): boolean {
  const headers = patch
    .split(/\r?\n/)
    .filter((line) => line.startsWith("diff --git "));
  if (headers.length !== manifest.length) return false;

  const unmatched = new Set(manifest.map((_entry, index) => index));
  for (const header of headers) {
    const matches = [...unmatched].filter((index) => diffHeaderMatchesEntry(header, manifest[index]));
    if (matches.length !== 1) return false;
    unmatched.delete(matches[0]);
  }
  return unmatched.size === 0;
}

function diffHeaderMatchesEntry(header: string, entry: ChangedFileManifestEntry): boolean {
  const previousPath = entry.status === "renamed" ? entry.previousPath! : entry.path;
  if (header === `diff --git a/${previousPath} b/${entry.path}`) return true;

  // Git C-quotes tabs, newlines, quotes, backslashes, and non-ASCII bytes. Paths containing plain
  // spaces can remain unquoted and are already covered by the exact comparison above.
  const token = String.raw`"(?:\\.|[^"\\])*"|[^ ]+`;
  const match = new RegExp(`^diff --git (${token}) (${token})$`).exec(header);
  return match !== null
    && decodeGitPath(match[1]) === `a/${previousPath}`
    && decodeGitPath(match[2]) === `b/${entry.path}`;
}

function splitFileSections(diff: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    sections.push(current.join("\n"));
  }
  return sections;
}

/** `+++ b/src/x.ts` → `src/x.ts`; `+++ /dev/null` (deleted file) → null. */
function newSidePath(line: string): string | null {
  return diffSidePath(line, "b/");
}

/** `--- a/src/x.ts` → `src/x.ts`; `--- /dev/null` (new file) → null. */
function oldSidePath(line: string): string | null {
  return diffSidePath(line, "a/");
}

function diffSidePath(line: string, prefix: "a/" | "b/"): string | null {
  const raw = decodeGitPath(pathToken(line.slice(4).trim()));
  if (raw === "/dev/null") {
    return null;
  }
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function pathToken(raw: string): string {
  if (!raw.startsWith("\"")) {
    return raw.split("\t", 1)[0];
  }
  let escaped = false;
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (!escaped && char === "\"") {
      return raw.slice(0, index + 1);
    }
    if (!escaped && char === "\\") {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  return raw;
}

/** Decode Git's `core.quotePath` C-style path quoting, including octal UTF-8 bytes. */
function decodeGitPath(raw: string): string {
  if (!(raw.startsWith("\"") && raw.endsWith("\""))) {
    return raw;
  }
  const bytes: number[] = [];
  const inner = raw.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const escaped = inner[index + 1];
    if (escaped === undefined) {
      bytes.push(0x5c);
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += octal[0].length;
      continue;
    }
    const escapes: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      "\\": 0x5c,
      "\"": 0x22,
    };
    bytes.push(escapes[escaped] ?? escaped.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

function runGitDiff(absoluteRoot: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveDiff, rejectDiff) => {
    const child = spawn("git", ["-C", absoluteRoot, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stderr = "";
    let overflowed = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectDiff(new CliError(EXIT.io, `git diff timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_BUFFER_BYTES) {
        overflowed = true;
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectDiff(new CliError(EXIT.io, `could not run git: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectDiff(new CliError(EXIT.usage, gitFailureMessage(args[2] ?? "", stderr)));
        return;
      }
      if (overflowed) {
        rejectDiff(new CliError(EXIT.io, "git diff output exceeded 32MB; narrow the base ref"));
        return;
      }
      resolveDiff(stdout + stdoutDecoder.end());
    });
  });
}

function gitFailureMessage(ref: string, stderr: string): string {
  const tail = stderr.trim().split("\n").slice(-2).join(" ").trim() || "(no output)";
  if (/unknown revision|bad revision|ambiguous argument/i.test(stderr)) {
    return `--changed-since '${ref}' is not a known git revision: ${tail}`;
  }
  if (/not a git repository/i.test(stderr)) {
    return `--changed-since needs the source root inside a git repository: ${tail}`;
  }
  return `git diff failed: ${tail}`;
}
