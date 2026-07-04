/**
 * The `--behavior` git-history pass served at `/api/behavior`.
 *
 * git is spawned argv-only (never through a shell) with cwd pinned to the resolved source
 * root, a hard timeout, and stdout/stderr byte caps — mirroring `git-exec.ts`. Every failure
 * mode (not a repo, git missing, timeout, oversized output) disables the endpoint with a
 * warning instead of crashing `view`. The report carries only source-root-relative POSIX
 * paths; failure detail goes to the operator's terminal, never into an HTTP response.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { aggregateNumstatLog } from "./behavior-numstat";
import type { BehaviorStats } from "./behavior-numstat";

export interface BehaviorReport extends BehaviorStats {
  behaviorVersion: "1";
  generatedAt: string;
}

const GIT_TIMEOUT_MS = 90_000;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 4_000;

export async function collectBehavior(
  sourceRoot: string,
  commitLimit: number,
  warn: (line: string) => void,
): Promise<BehaviorReport | null> {
  try {
    // git reports the repo top as a real path; realpath the root too (and validate it exists)
    // so the containment math never trips over a symlinked directory like macOS /var.
    const realRoot = realpathSync(sourceRoot);
    const repoRoot = (await runGit(["rev-parse", "--show-toplevel"], realRoot)).trim();
    const numstatLog = await runGit(numstatArgs(commitLimit), realRoot);
    return {
      behaviorVersion: "1",
      generatedAt: new Date().toISOString(),
      ...aggregateNumstatLog(numstatLog, repoRoot, realRoot),
    };
  } catch (error) {
    warn(`behavior analysis disabled: ${messageOf(error)}`);
    return null;
  }
}

/** Fixed strings plus one bounds-checked integer; the trailing `--` fences off pathspec parsing. */
function numstatArgs(commitLimit: number): string[] {
  return ["-c", "core.quotePath=off", "log", "-n", String(commitLimit), "--numstat", "--format=%H", "--no-renames", "--"];
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = "";
    const fail = (message: string) => {
      child.kill("SIGKILL");
      rejectRun(new Error(message));
    };
    const timer = setTimeout(() => fail(`git ${args[2] ?? args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s`), GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        clearTimeout(timer);
        fail("git output exceeded the size cap");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(new Error(`could not run git: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolveRun(Buffer.concat(stdout).toString("utf8"))
        : rejectRun(new Error(lastLine(stderrTail) || `git exited with code ${code}`));
    });
  });
}

function lastLine(text: string): string {
  return text.trim().split("\n").slice(-1)[0]?.trim() ?? "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
