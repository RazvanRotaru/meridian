/**
 * Running `git` as a child process and turning its stderr into a browser-safe message.
 *
 * Split from `clone` so the process/IO concerns (spawn, timeout, secret-scrubbing) stay apart
 * from the pure input parsing. A token appears here only to build the redactor that strips it
 * from git's stderr and (for `runGit`) to inject an `http.extraHeader` credential; it is never
 * placed in argv, logged, echoed in a response, or persisted anywhere.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { OperationCancelledError } from "./web-cancellation";
import { WebError } from "./web-error";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const MAX_STDERR_BYTES = 4_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const AUTH_HEADER_ENV = "MERIDIAN_GIT_HTTP_EXTRA_HEADER";

/** base64("x-access-token:<token>") — the credential half of the Authorization header. */
export function base64Auth(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
}

/** Ask Git to read its ephemeral header from the child environment, never process-list-visible argv. */
function authArgs(token?: string): string[] {
  return token ? [`--config-env=http.extraHeader=${AUTH_HEADER_ENV}`] : [];
}

function gitEnvironment(token?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Never inherit a credential accidentally. Each invocation owns this one ephemeral value.
  delete env[AUTH_HEADER_ENV];
  if (token) env[AUTH_HEADER_ENV] = `AUTHORIZATION: basic ${base64Auth(token)}`;
  return env;
}

/**
 * Run an arbitrary git subcommand in `opts.cwd`, argv-only (never shell-interpolated), and return
 * its stdout. Git reads the token-bearing header from a dedicated child environment variable via
 * `--config-env`, so it never lands in a URL, process-list-visible argv, a log, or an error message.
 */
export function runGit(
  args: string[],
  opts: { cwd: string; token?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
  return spawnGit([...authArgs(opts.token), ...args], {
    cwd: opts.cwd,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    signal: opts.signal,
  });
}

interface SpawnOptions {
  cwd?: string;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** The one place `git` is spawned: pipes stdout, caps buffers, time-boxes, and scrubs the token. */
function spawnGit(args: string[], opts: SpawnOptions): Promise<string> {
  if (opts.signal?.aborted) {
    return Promise.reject(new OperationCancelledError("git operation was cancelled"));
  }
  const redact = redactor(opts.token);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: gitEnvironment(opts.token),
      // A separate POSIX process group lets cancellation terminate Git and any transport helpers
      // before a persistent repository cache is reused. Windows uses taskkill /T instead.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stdoutOverflowed = false;
    let stderr = "";
    let settled = false;
    let killed = false;
    let terminationError: Error | undefined;
    let terminationCompletion: Promise<void> | undefined;
    const kill = () => {
      if (killed) return;
      killed = true;
      terminationCompletion = terminateGitProcessTree(child);
    };
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectRun(error);
    };
    const resolveOnce = (value: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveRun(value);
    };
    const onAbort = () => {
      if (settled || terminationError) return;
      terminationError = new OperationCancelledError("git operation was cancelled");
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      kill();
    };
    const timer = setTimeout(() => {
      if (settled || terminationError) return;
      terminationError = new WebError(422, `git timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
      opts.signal?.removeEventListener("abort", onAbort);
      kill();
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
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
      // Cancellation and timeout settle only from `close`, after the direct Git child has exited.
      // A spawn failure before either condition remains an immediate, scrubbed execution error.
      if (terminationError) return;
      rejectOnce(terminationError ?? new WebError(500, `could not run git: ${redact(error.message)}`));
    });
    child.on("close", (code) => {
      if (terminationError) {
        const error = terminationError;
        void (terminationCompletion ?? Promise.resolve()).then(() => rejectOnce(error));
      } else if (code !== 0) {
        rejectOnce(new WebError(422, gitFailureMessage(redact(stderr))));
      } else if (stdoutOverflowed) {
        // Never hand a syntactically plausible prefix to a parser: name-status output can happen
        // to end on a NUL and a patch can end after a complete hunk even when later files vanished.
        rejectOnce(new WebError(422, "git output exceeded 32MB; refusing truncated output"));
      } else {
        resolveOnce(stdout + stdoutDecoder.end());
      }
    });
  });
}

/** Kill Git together with credential/network helpers; the caller still waits for Git's `close`. */
function terminateGitProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGKILL");
    return Promise.resolve();
  }
  if (process.platform === "win32") {
    return terminateWindowsProcessTree(child, pid);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  return Promise.resolve();
}

function terminateWindowsProcessTree(child: ReturnType<typeof spawn>, pid: number): Promise<void> {
  return new Promise((resolveTermination) => {
    let finished = false;
    const finish = (fallback: boolean) => {
      if (finished) return;
      finished = true;
      if (fallback) child.kill("SIGKILL");
      resolveTermination();
    };
    try {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => finish(true));
      killer.once("close", (code) => finish(code !== 0));
    } catch {
      finish(true);
    }
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
