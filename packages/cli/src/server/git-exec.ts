/**
 * Running `git` as a child process and turning its stderr into a browser-safe message.
 *
 * Split from `clone` so the process/IO concerns (argv-only spawn, 90s timeout, secret-scrubbing)
 * stay apart from the pure input parsing. A token appears here only to build the redactor that
 * strips it from git's stderr; it is never logged, echoed in a response, or persisted anywhere.
 * `cwd` lets the PR flow run fetch/checkout inside the clone; every invocation keeps its fences.
 */

import { spawn } from "node:child_process";
import { WebError } from "./web-error";

const CLONE_TIMEOUT_MS = 90_000;
const MAX_STDERR_BYTES = 4_000;

export interface RunGitOptions {
  /** Only used to redact the credential from stderr — never logged or echoed. */
  token?: string;
  /** Working directory for the invocation (the clone root, for fetch/checkout). */
  cwd?: string;
}

/** base64("x-access-token:<token>") — the credential half of the Authorization header. */
export function base64Auth(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
}

export function runGit(args: string[], opts: RunGitOptions = {}): Promise<void> {
  const redact = redactor(opts.token);
  return new Promise((resolveGit, rejectGit) => {
    const child = spawn("git", args, { cwd: opts.cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectGit(new WebError(422, "git timed out after 90s"));
    }, CLONE_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectGit(new WebError(500, `could not run git: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolveGit() : rejectGit(new WebError(422, gitFailureMessage(redact(stderr))));
    });
  });
}

function gitFailureMessage(scrubbedStderr: string): string {
  const authLike = /Authentication failed|could not read Username|terminal prompts disabled|\b403\b|not found/i.test(
    scrubbedStderr,
  );
  const tail = lastLines(scrubbedStderr, 4);
  if (authLike) {
    return `authentication failed — repository not found or is private (set GITHUB_TOKEN or provide a token): ${tail}`;
  }
  return `git command failed: ${tail}`;
}

/** Strip every trace of the token from git's stderr before it can reach a log or response. */
function redactor(token?: string): (text: string) => string {
  if (!token) {
    return (text) => text;
  }
  const b64 = base64Auth(token);
  return (text) =>
    text.split(token).join("***").split(b64).join("***").replace(/AUTHORIZATION: basic \S+/gi, "AUTHORIZATION: basic ***");
}

function lastLines(text: string, count: number): string {
  return text.trim().split("\n").slice(-count).join(" ").trim() || "(no output)";
}
