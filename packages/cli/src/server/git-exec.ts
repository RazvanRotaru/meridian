/**
 * Running `git clone` as a child process and turning its stderr into a browser-safe message.
 *
 * Split from `clone` so the process/IO concerns (spawn, timeout, secret-scrubbing) stay apart
 * from the pure input parsing. A token appears here only to build the redactor that strips it
 * from git's stderr; it is never logged, echoed in a response, or persisted anywhere.
 */

import { spawn } from "node:child_process";
import { WebError } from "./web-error";

const CLONE_TIMEOUT_MS = 90_000;
const MAX_STDERR_BYTES = 4_000;

/** base64("x-access-token:<token>") — the credential half of the Authorization header. */
export function base64Auth(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
}

export function runGitClone(args: string[], token?: string): Promise<void> {
  const redact = redactor(token);
  return new Promise((resolveClone, rejectClone) => {
    const child = spawn("git", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectClone(new WebError(422, "git clone timed out after 90s"));
    }, CLONE_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectClone(new WebError(500, `could not run git: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolveClone() : rejectClone(new WebError(422, cloneFailureMessage(redact(stderr))));
    });
  });
}

function cloneFailureMessage(scrubbedStderr: string): string {
  const authLike = /Authentication failed|could not read Username|terminal prompts disabled|\b403\b|not found/i.test(
    scrubbedStderr,
  );
  const tail = lastLines(scrubbedStderr, 4);
  if (authLike) {
    return `authentication failed — repository not found or is private (set GITHUB_TOKEN or provide a token): ${tail}`;
  }
  return `git clone failed: ${tail}`;
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
