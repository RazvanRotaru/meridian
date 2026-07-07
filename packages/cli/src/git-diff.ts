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
import type { ChangedLineStats, ChangedRanges, LineRange } from "@meridian/core";
import { CliError, EXIT } from "./errors";

const DIFF_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Branch/tag/sha/HEAD~n shapes; refuses anything that could read as a `git diff` option. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/~^-]*$/;

export async function changedRangesSince(absoluteRoot: string, baseRef: string): Promise<ChangedRanges> {
  const changed = await changedSinceMetadata(absoluteRoot, baseRef);
  return changed.ranges;
}

export async function changedSinceMetadata(
  absoluteRoot: string,
  baseRef: string,
): Promise<{ ranges: ChangedRanges; stats: ChangedLineStats }> {
  const stdout = await runGitDiff(absoluteRoot, validatedRef(baseRef));
  return parseUnifiedDiffWithStats(stdout);
}

export function validatedRef(baseRef: string): string {
  const ref = baseRef.trim();
  if (!SAFE_REF.test(ref)) {
    throw new CliError(EXIT.usage, `--changed-since ref looks invalid: '${baseRef}'`);
  }
  return ref;
}

/**
 * Parse `git diff -U0` output into inclusive 1-based ranges per NEW-side file path.
 *
 * Only the `+++ b/<path>` side matters — those are the paths (and line numbers) that exist in the
 * extracted tree. Deleted files (`+++ /dev/null`) have no nodes to tag and are skipped. A pure
 * deletion hunk (`+c,0`) removed lines BETWEEN c and c+1, so it marks that seam — the declaration
 * that used to hold the deleted lines spans it.
 */
export function parseUnifiedDiff(diff: string): ChangedRanges {
  return parseUnifiedDiffWithStats(diff).ranges;
}

export function parseUnifiedDiffWithStats(diff: string): { ranges: ChangedRanges; stats: ChangedLineStats } {
  const changed: ChangedRanges = {};
  const stats: ChangedLineStats = {};
  let currentFile: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentFile = newSidePath(line);
      continue;
    }
    if (currentFile === null || !line.startsWith("@@")) {
      continue;
    }
    const hunk = parseHunk(line);
    if (hunk) {
      (changed[currentFile] ??= []).push(hunk.range);
      const file = (stats[currentFile] ??= { added: 0, deleted: 0 });
      file.added += hunk.added;
      file.deleted += hunk.deleted;
    }
  }
  return { ranges: changed, stats };
}

/** `+++ b/src/x.ts` → `src/x.ts`; `+++ /dev/null` (deleted file) → null. Tab-suffixed names too. */
function newSidePath(line: string): string | null {
  const raw = line.slice(4).split("\t")[0].trim();
  if (raw === "/dev/null") {
    return null;
  }
  return raw.startsWith("b/") ? raw.slice(2) : raw;
}

/** `@@ -a,b +c,d @@` → the new-side span; `d` omitted means 1; `d = 0` marks the deletion seam. */
function parseHunk(line: string): { range: LineRange; added: number; deleted: number } | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }
  const deleted = match[2] === undefined ? 1 : Number(match[2]);
  const start = Number(match[3]);
  const added = match[4] === undefined ? 1 : Number(match[4]);
  if (added === 0) {
    const seam = Math.max(1, start);
    return { range: { start: seam, end: seam + 1 }, added, deleted };
  }
  return { range: { start: Math.max(1, start), end: Math.max(1, start) + added - 1 }, added, deleted };
}

function runGitDiff(absoluteRoot: string, ref: string): Promise<string> {
  const args = ["-C", absoluteRoot, "diff", "--merge-base", ref, "--relative", "--unified=0", "--no-color"];
  return new Promise((resolveDiff, rejectDiff) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectDiff(new CliError(EXIT.io, `git diff timed out after ${DIFF_TIMEOUT_MS / 1000}s`));
    }, DIFF_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER_BYTES) {
        stdout += chunk.toString("utf8");
      } else {
        overflowed = true;
      }
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
        rejectDiff(new CliError(EXIT.usage, gitFailureMessage(ref, stderr)));
        return;
      }
      if (overflowed) {
        rejectDiff(new CliError(EXIT.io, "git diff output exceeded 32MB; narrow the base ref"));
        return;
      }
      resolveDiff(stdout);
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
