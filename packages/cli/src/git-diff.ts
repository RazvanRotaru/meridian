/**
 * Local `git diff` plumbing for the change lens: one spawn helper (argv-only, `--` fenced,
 * output-capped) and pure parsers for the three read-only diff shapes the `change` command
 * consumes — `--numstat` (± per file), `--name-status` (A/M/D/R per file), and `-U0` hunk
 * headers (new-side line ranges per file, for mapping onto node source spans).
 */

import { spawn } from "node:child_process";
import { CliError, EXIT } from "./errors";

const GIT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;

export function runGit(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolveGit, rejectGit) => {
    const child = spawn("git", ["-C", repoRoot, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectGit(new CliError(EXIT.io, `git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s`));
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout += chunk.toString("utf8");
      } else {
        truncated = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectGit(new CliError(EXIT.io, `could not run git: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectGit(new CliError(EXIT.io, `git ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      if (truncated) {
        rejectGit(new CliError(EXIT.io, `git ${args[0]} output exceeded ${MAX_STDOUT_BYTES} bytes`));
        return;
      }
      resolveGit(stdout);
    });
  });
}

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
}

/** Parse `git diff --numstat` output. Binary files report "-" and count as 0/0. */
export function parseNumstat(output: string): FileStat[] {
  const stats: FileStat[] = [];
  for (const line of output.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    stats.push({
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
      path: unquoteRenamePath(match[3]),
    });
  }
  return stats;
}

/** Parse `git diff --name-status` into path -> A|M|D (renames count as M of the new path). */
export function parseNameStatus(output: string): Map<string, "A" | "M" | "D"> {
  const statuses = new Map<string, "A" | "M" | "D">();
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 2) {
      continue;
    }
    const code = parts[0][0];
    if (code === "A" || code === "M" || code === "D") {
      statuses.set(parts[1], code);
    } else if (code === "R" || code === "C") {
      // Rename/copy lines are "Rxx\told\tnew" — the surviving path is the last field.
      statuses.set(parts[parts.length - 1], "M");
    }
  }
  return statuses;
}

export interface HunkRange {
  /** First affected line in the NEW file (for pure deletions, the anchor line). */
  start: number;
  /** Last affected line in the NEW file (>= start). */
  end: number;
}

/** Parse `git diff -U0` into new-side hunk ranges per file path. */
export function parseHunkRanges(output: string): Map<string, HunkRange[]> {
  const byFile = new Map<string, HunkRange[]>();
  let currentFile: string | null = null;
  for (const line of output.split("\n")) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentFile = unquoteRenamePath(fileMatch[1]);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      currentFile = null; // deleted file: nothing on the new side to anchor to
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch && currentFile) {
      const start = Number(hunkMatch[1]);
      const count = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      const range: HunkRange = count === 0 ? { start, end: start } : { start, end: start + count - 1 };
      const ranges = byFile.get(currentFile);
      if (ranges) {
        ranges.push(range);
      } else {
        byFile.set(currentFile, [range]);
      }
    }
  }
  return byFile;
}

/** Git quotes unusual paths; strip the quotes (escapes stay rare enough to pass through). */
function unquoteRenamePath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1);
  }
  return path;
}
