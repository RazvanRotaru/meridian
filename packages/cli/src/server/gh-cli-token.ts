/**
 * Resolving the local `gh` CLI's GitHub token as a last-resort credential for the web flow.
 *
 * When there's no explicit token, no signed-in session, and no GITHUB_TOKEN/GH_TOKEN, a user who has
 * already run `gh auth login` shouldn't have to sign in again — `gh auth token` prints the token they
 * already hold. It is resolved ONCE at server boot (never per request) and only ever feeds the same
 * vetted clone/API path as GITHUB_TOKEN — never logged, echoed, or persisted.
 *
 * IO (spawning `gh`) is split from parsing so the parse stays pure and unit-tested; a missing `gh`
 * (ENOENT), a timeout, or a not-signed-in exit all resolve to `undefined`, so the fallback simply
 * doesn't apply.
 */

import { spawn } from "node:child_process";

const GH_TIMEOUT_MS = 5_000;

/** The token from a successful `gh auth token`, or undefined when gh is absent / not signed in. */
export async function resolveGhCliToken(): Promise<string | undefined> {
  try {
    const { stdout, code } = await runGhAuthToken();
    return parseGhTokenOutput(stdout, code);
  } catch {
    // `gh` not installed (spawn ENOENT) — the fallback just doesn't apply.
    return undefined;
  }
}

/** Pure: a token only from a clean (exit 0) run with non-empty output. */
export function parseGhTokenOutput(stdout: string, code: number | null): string | undefined {
  if (code !== 0) {
    return undefined;
  }
  const token = stdout.trim();
  return token.length > 0 ? token : undefined;
}

/** argv-only spawn (never a shell); stderr is dropped so gh's messages can't leak the token path. */
function runGhAuthToken(): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveRun({ stdout: "", code: null });
    }, GH_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, code });
    });
  });
}
