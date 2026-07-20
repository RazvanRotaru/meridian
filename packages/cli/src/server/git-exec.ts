/**
 * Running `git` as a child process and turning its stderr into a browser-safe message.
 *
 * Split from `clone` so the process/IO concerns (spawn, timeout, secret-scrubbing) stay apart
 * from the pure input parsing. A token appears here only to build the redactor that strips it
 * from git's stderr and (for `runGit`) to inject an `http.extraHeader` credential; it is never
 * logged, echoed in a response, or persisted anywhere.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { WebError } from "./web-error";

const CLONE_TIMEOUT_MS = 90_000;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const MAX_STDERR_BYTES = 4_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;

/** base64("x-access-token:<token>") — the credential half of the Authorization header. */
export function base64Auth(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
}

/** The `-c http.extraHeader=…` prefix that carries a token into a git subcommand without a URL. */
function authArgs(token?: string): string[] {
  return token ? ["-c", `http.extraHeader=AUTHORIZATION: basic ${base64Auth(token)}`] : [];
}

export function runGitClone(args: string[], token?: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  return spawnGit(args, { token, timeoutMs: opts.timeoutMs ?? CLONE_TIMEOUT_MS }).then(() => undefined);
}

/**
 * Run an arbitrary git subcommand in `opts.cwd`, argv-only (never shell-interpolated), and return
 * its stdout. The token is injected the same way `runGitClone` does — a `-c http.extraHeader`
 * before the subcommand — so it never lands in an argv URL, a log, or an error message.
 */
export function runGit(args: string[], opts: { cwd: string; token?: string; timeoutMs?: number }): Promise<string> {
  return spawnGit([...authArgs(opts.token), ...args], {
    cwd: opts.cwd,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
}

interface SpawnOptions {
  cwd?: string;
  token?: string;
  timeoutMs: number;
}

/** The one place `git` is spawned: pipes stdout, caps buffers, time-boxes, and scrubs the token. */
function spawnGit(args: string[], opts: SpawnOptions): Promise<string> {
  const redact = redactor(opts.token);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stdoutOverflowed = false;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new WebError(422, `git timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stdoutOverflowed = true;
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(new WebError(500, `could not run git: ${redact(error.message)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new WebError(422, gitFailureMessage(redact(stderr))));
      } else if (stdoutOverflowed) {
        // Never hand a syntactically plausible prefix to a parser: name-status output can happen
        // to end on a NUL and a patch can end after a complete hunk even when later files vanished.
        rejectRun(new WebError(422, "git output exceeded 32MB; refusing truncated output"));
      } else {
        resolveRun(stdout + stdoutDecoder.end());
      }
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
  return `git failed: ${tail}`;
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
