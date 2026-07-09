/**
 * Running `git` for the local `review` command: capture stdout, or resolve null when probing.
 *
 * Deliberately separate from `server/git-exec.ts` (the web-clone path) so `review`'s read-only
 * plumbing can't perturb the clone flow's security posture. Same discipline: argv-only spawn,
 * never a shell, a hard timeout, and only the last stderr lines surface in an error.
 */

import { spawn } from "node:child_process";
import { CliError, EXIT } from "../errors";

const GIT_TIMEOUT_MS = 10_000;
const MAX_STDERR_BYTES = 4_000;

/** argv-only `git`; trimmed stdout; throws CliError on non-zero exit, spawn error, or timeout. */
export function runGitCapture(args: string[], cwd: string): Promise<string> {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectCapture(gitError(args, "timed out after 10s"));
    }, GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectCapture(gitError(args, error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolveCapture(stdout.trim()) : rejectCapture(gitError(args, lastLines(stderr, 3)));
    });
  });
}

/** Like runGitCapture but resolves null instead of throwing — for ref probing / best-effort reads. */
export async function tryGitCapture(args: string[], cwd: string): Promise<string | null> {
  try {
    return await runGitCapture(args, cwd);
  } catch {
    return null;
  }
}

// EXIT has no dedicated "runtime" code (SPEC named one that isn't in errors.ts, which is outside
// this slice), so an unexpected git failure maps to the generic internal bucket; the two user-facing
// cases (not-a-repo, bad --base) are raised as EXIT.usage by the caller before we reach here.
function gitError(args: string[], detail: string): CliError {
  return new CliError(EXIT.internal, `git ${args[0]} failed: ${detail}`);
}

function lastLines(text: string, count: number): string {
  return text.trim().split("\n").slice(-count).join(" ").trim() || "(no output)";
}
