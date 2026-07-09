/**
 * Turning "the working tree vs a base ref" into the raw changed-file facts the review extension carries.
 *
 * The diff is merge-base(base, HEAD) → working tree (committed + staged + unstaged) ∪ untracked, so it
 * matches exactly what the extractor just read off disk — no artifact-vs-diff staleness is possible.
 * Paths come back repo-root-relative and are rebased to the extraction root (the same base as
 * `node.location.file`), dropping anything outside it. The parse/rebase/normalize steps are pure.
 */

import { relative } from "node:path";
import type { ChangedFile, ChangeStatus, LineRange } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { toPosix } from "../paths";
import { runGitCapture, tryGitCapture } from "./git-local";

export interface ReviewDiff {
  /** Extraction-root-relative POSIX paths (already rebased). */
  changedFiles: ChangedFile[];
  baseRef: string;
  baseSha: string;
  headRef: string | null;
  /** Normalized remote.origin.url, else posix basename of the git toplevel. */
  repoIdentity: string;
  warnings: string[];
}

export async function collectReviewDiff(absoluteRoot: string, baseOption: string | undefined): Promise<ReviewDiff> {
  const toplevel = await resolveToplevel(absoluteRoot);
  // The base-ref → merge-base → diff chain (each step needs the last) runs concurrently with the
  // toplevel-only reads — the untracked list, HEAD ref, and remote identity need no base ref. Error
  // semantics are unchanged: the diff chain and untracked throw; head/identity tolerate null.
  const [base, untracked, headRef, repoIdentity] = await Promise.all([
    resolveTrackedDiff(toplevel, baseOption),
    listUntracked(toplevel),
    resolveHeadRef(toplevel),
    resolveRemoteIdentity(toplevel),
  ]);
  const prefix = toPosix(relative(toplevel, absoluteRoot));
  const { kept, dropped } = rebaseToExtractionRoot(dedupeByPath([...base.tracked, ...untracked]), prefix);
  return {
    changedFiles: kept,
    baseRef: base.baseRef,
    baseSha: base.baseSha,
    headRef,
    repoIdentity: repoIdentity ?? posixBasename(toplevel),
    warnings: dropped > 0 ? [`${dropped} changed file(s) outside the extraction root were skipped`] : [],
  };
}

/** The tracked half: resolve the base ref, its merge-base with HEAD, the name-status diff, and per-file hunks. */
async function resolveTrackedDiff(toplevel: string, baseOption: string | undefined): Promise<{ baseRef: string; baseSha: string; tracked: ChangedFile[] }> {
  const baseRef = await resolveBaseRef((ref) => refExists(ref, toplevel), baseOption);
  const baseSha = await runGitCapture(["merge-base", baseRef, "HEAD"], toplevel);
  // name-status (rename-aware) and the zero-context unified diff (line ranges) run off the same
  // merge-base sha, so the hunks describe exactly the files name-status reports.
  const [names, patch] = await Promise.all([
    runGitCapture(["diff", "--name-status", "-z", "-M50", baseSha], toplevel),
    runGitCapture(["diff", "--unified=0", "--no-color", "-M50", baseSha], toplevel),
  ]);
  const hunksByPath = parseUnifiedZeroHunks(patch);
  const tracked = withHunks(parseNameStatusZ(names), hunksByPath);
  return { baseRef, baseSha, tracked };
}

/** Attach parsed hunks to each file by its (new-side) path; a file with none stays whole-file. */
export function withHunks(files: ChangedFile[], hunksByPath: Map<string, LineRange[]>): ChangedFile[] {
  return files.map((file) => {
    const hunks = hunksByPath.get(file.path);
    return hunks && hunks.length > 0 ? { ...file, hunks } : file;
  });
}

/** The untracked half: files git doesn't track yet, each reported as an add. */
async function listUntracked(toplevel: string): Promise<ChangedFile[]> {
  return parseUntracked(await runGitCapture(["ls-files", "--others", "--exclude-standard", "-z"], toplevel));
}

/** Candidates: explicit → origin/HEAD → origin/main → origin/master → main → master; CliError(EXIT.usage) if none. */
export async function resolveBaseRef(probe: (ref: string) => Promise<boolean>, explicit?: string): Promise<string> {
  if (explicit) {
    if (await probe(explicit)) {
      return explicit;
    }
    throw new CliError(EXIT.usage, `base ref '${explicit}' not found — pass an existing --base <ref>`);
  }
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    if (await probe(ref)) {
      return ref;
    }
  }
  throw new CliError(EXIT.usage, "could not resolve a base ref; pass --base <ref>");
}

/** Pure. Parses `git diff --name-status -z` (A/M/T/U/D one-path, R<n>/C<n> two-path). Paths repo-root-relative. */
export function parseNameStatusZ(output: string): ChangedFile[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const files: ChangedFile[] = [];
  let index = 0;
  while (index < tokens.length) {
    const code = tokens[index++];
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (path === undefined) break;
      files.push(letter === "R" ? { status: "renamed", path, previousPath } : { status: "added", path });
    } else {
      const path = tokens[index++];
      if (path === undefined) break;
      files.push({ status: statusFromLetter(letter), path });
    }
  }
  return files;
}

/**
 * Pure. Parses `git diff --unified=0` into new-side (post-image) line ranges per file.
 *
 * Each file section is framed by a `--- a/<old>` then `+++ b/<new>` pair (`/dev/null` = deletion,
 * skipped); each `@@ -… +s[,c] @@` hunk header contributes `[s, s+c-1]`. A `+s,0` pure DELETION owns
 * no new-side line but still edits the block around `s`, so it is anchored to `[s, s+1]` rather than
 * dropped — otherwise a file whose only edits are deletions would carry no hunks and fall back to
 * whole-file, flagging every block in it. Binary sections have no `@@` lines and vanish. A `+++ `
 * header is only honoured right after a `--- ` line, so an ADDED content line that itself begins with
 * `++ ` (rendered `+++ …` at zero context) is not mistaken for a file header. Paths git quoted
 * (special chars, core.quotepath on) are left unmatched — that file falls back to whole-file, safe.
 */
export function parseUnifiedZeroHunks(output: string): Map<string, LineRange[]> {
  const byPath = new Map<string, LineRange[]>();
  let current: string | null = null;
  let expectNewPath = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("--- ")) {
      expectNewPath = true;
      continue;
    }
    if (expectNewPath && line.startsWith("+++ ")) {
      current = pathFromPlusPlusPlus(line);
      expectNewPath = false;
      continue;
    }
    expectNewPath = false;
    if (current === null || !line.startsWith("@@")) {
      continue;
    }
    const range = rangeFromHunkHeader(line);
    if (range !== null) {
      appendRange(byPath, current, range);
    }
  }
  return byPath;
}

/** `+++ b/src/a.ts` → `src/a.ts`; `+++ /dev/null` → null (a deletion has no new-side path). */
function pathFromPlusPlusPlus(line: string): string | null {
  const rest = line.slice(4).replace(/\t.*$/, "").trim();
  if (rest === "/dev/null") {
    return null;
  }
  return rest.startsWith("b/") ? rest.slice(2) : rest;
}

/** `@@ -3,0 +4,2 @@ ctx` → {4,5}; `@@ -3 +4 @@` → {4,4}; a `+s,0` deletion anchors to {max(1,s), +1}. */
function rangeFromHunkHeader(line: string): LineRange | null {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  if (count === 0) {
    // A pure deletion has no new-side line; `start` is the line it sits AFTER (0 ⇒ file top). Anchor
    // to that line and the next so whichever block borders the removal is attributed — never dropped.
    const anchor = Math.max(1, start);
    return { start: anchor, end: anchor + 1 };
  }
  return { start, end: start + count - 1 };
}

function appendRange(byPath: Map<string, LineRange[]>, path: string, range: LineRange): void {
  const existing = byPath.get(path);
  if (existing) {
    existing.push(range);
  } else {
    byPath.set(path, [range]);
  }
}

/** Pure. prefix = posix path of the extraction root within the toplevel ("" = same). Drops files outside it. */
export function rebaseToExtractionRoot(files: ChangedFile[], prefix: string): { kept: ChangedFile[]; dropped: number } {
  const normalized = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
  const kept: ChangedFile[] = [];
  let dropped = 0;
  for (const file of files) {
    const path = stripPrefix(file.path, normalized);
    if (path === null) {
      dropped++;
      continue;
    }
    kept.push(rebaseFile(file, path, normalized));
  }
  return { kept, dropped };
}

/** Pure. Strips protocol/credentials/.git, lowercases host: "https://x@GitHub.com/a/b.git" → "github.com/a/b". */
export function normalizeRemote(url: string): string {
  const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(url.trim());
  let rest = scp && !url.includes("://")
    ? `${scp[1]}/${scp[2]}`
    : url.trim().replace(/^[a-zA-Z][\w+.-]*:\/\//, "").replace(/^[^/@]+@/, "");
  rest = rest.replace(/\.git$/, "").replace(/\/+$/, "");
  const slash = rest.indexOf("/");
  return slash === -1 ? rest.toLowerCase() : `${rest.slice(0, slash).toLowerCase()}${rest.slice(slash)}`;
}

/** Current branch name; null when detached HEAD or unknown. Best-effort (never throws). */
export async function resolveHeadRef(cwd: string): Promise<string | null> {
  const head = await tryGitCapture(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return head && head !== "HEAD" ? head : null;
}

/** Normalized remote.origin.url, or null when there is no origin. Best-effort (never throws). */
export async function resolveRemoteIdentity(cwd: string): Promise<string | null> {
  const url = await tryGitCapture(["config", "--get", "remote.origin.url"], cwd);
  return url ? normalizeRemote(url) : null;
}

export function posixBasename(path: string): string {
  return toPosix(path).replace(/\/+$/, "").split("/").pop() ?? path;
}

async function resolveToplevel(absoluteRoot: string): Promise<string> {
  const top = await tryGitCapture(["rev-parse", "--show-toplevel"], absoluteRoot);
  if (!top) {
    throw new CliError(EXIT.usage, `not a git repository at ${absoluteRoot} — run inside a repo or pass --changed <files...>`);
  }
  return top;
}

async function refExists(ref: string, cwd: string): Promise<boolean> {
  return (await tryGitCapture(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)) !== null;
}

function parseUntracked(output: string): ChangedFile[] {
  return output
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => ({ status: "added" as ChangeStatus, path }));
}

/** Untracked never overlaps tracked (git diff is tracked-only), but a defensive dedupe keeps first-seen. */
function dedupeByPath(files: ChangedFile[]): ChangedFile[] {
  const seen = new Set<string>();
  return files.filter((file) => (seen.has(file.path) ? false : (seen.add(file.path), true)));
}

/** Keep the file (its `path` is inside the root); rebase a rename's previousPath too, else drop that display-only field.
 * Hunks are line numbers (path-independent), so they ride through the rebase untouched via the spread. */
function rebaseFile(file: ChangedFile, path: string, prefix: string): ChangedFile {
  if (file.previousPath === undefined) {
    return { ...file, path };
  }
  const previousPath = stripPrefix(file.previousPath, prefix);
  return previousPath === null ? { ...file, path, previousPath: undefined } : { ...file, path, previousPath };
}

function stripPrefix(path: string, prefix: string): string | null {
  if (prefix === "") return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function statusFromLetter(letter: string): ChangeStatus {
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  return "modified";
}
