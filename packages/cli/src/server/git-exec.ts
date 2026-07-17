/**
 * Running `git` as a child process and turning its stderr into a browser-safe message.
 *
 * Process/IO concerns (spawn, timeout, secret-scrubbing) stay separate from repository input
 * parsing. A token appears here only to build the redactor that strips it
 * from git's stderr and (for `runGit`) to inject an `http.extraHeader` credential; it is never
 * logged, echoed in a response, or persisted anywhere.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { WebError } from "./web-error";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const TERMINATE_GRACE_MS = 5_000;
const PROCESS_TREE_POLL_MS = 25;
const PROCESS_TREE_KILL_WAIT_MS = 5_000;
const MAX_STDERR_BYTES = 4_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDOUT_LINE_CHARACTERS = 64 * 1024;

export interface RunGitOptions {
  cwd: string;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Keep false only when an outer supervisor owns and terminates this process group. */
  isolateProcessGroup?: boolean;
}

export type GitLineConsumer = (line: string) => void | Promise<void>;

/** base64("x-access-token:<token>") — the credential half of the Authorization header. */
export function base64Auth(token: string): string {
  return Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
}

/** The `-c http.extraHeader=…` prefix that carries a token into a git subcommand without a URL. */
function authArgs(token?: string): string[] {
  return token ? ["-c", `http.extraHeader=AUTHORIZATION: basic ${base64Auth(token)}`] : [];
}

/**
 * Run an arbitrary git subcommand in `opts.cwd`, argv-only (never shell-interpolated), and return
 * its stdout. A token is injected as a `-c http.extraHeader` before the subcommand, so it never
 * lands in an argv URL, a log, or an error message.
 */
export function runGit(
  args: string[],
  opts: RunGitOptions,
): Promise<string> {
  return spawnGit([...authArgs(opts.token), ...args], {
    cwd: opts.cwd,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    signal: opts.signal,
    isolateProcessGroup: opts.isolateProcessGroup ?? true,
  }, bufferedStdoutConsumer());
}

/**
 * Stream Git's newline-delimited stdout with backpressure and bounded carry memory.
 *
 * The consumer is awaited before stdout resumes, so callers can process a fixed-size batch and
 * yield without the child accumulating an unbounded JavaScript-side output inventory.
 */
export function streamGitLines(
  args: string[],
  opts: RunGitOptions,
  consume: GitLineConsumer,
): Promise<void> {
  return spawnGit([...authArgs(opts.token), ...args], {
    cwd: opts.cwd,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    signal: opts.signal,
    isolateProcessGroup: opts.isolateProcessGroup ?? true,
  }, lineStdoutConsumer(consume));
}

interface SpawnOptions {
  cwd?: string;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  isolateProcessGroup?: boolean;
}

interface StdoutConsumer<T> {
  write(chunk: Buffer): void | Promise<void>;
  end(): T | Promise<T>;
}

/** The one place `git` is spawned: pipes stdout, caps buffers, time-boxes, and scrubs the token. */
function spawnGit<T>(args: string[], opts: SpawnOptions, stdoutConsumer: StdoutConsumer<T>): Promise<T> {
  const redact = redactor(opts.token);
  if (opts.signal?.aborted) {
    return Promise.reject(abortReason(opts.signal));
  }
  return new Promise((resolveRun, rejectRun) => {
    const isolatedProcessGroup = opts.isolateProcessGroup ?? true;
    let child: ChildProcess;
    try {
      child = spawn("git", args, {
        cwd: opts.cwd,
        detached: isolatedProcessGroup && process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const message = error instanceof Error ? redact(error.message) : "unknown spawn failure";
      rejectRun(new WebError(500, `could not run git: ${message}`));
      return;
    }
    let stderr = "";
    let terminalError: unknown;
    let spawnFailure: WebError | undefined;
    let settled = false;
    let closed = false;
    let closeCode: number | null = null;
    let terminationComplete = false;
    let terminationFailure: WebError | undefined;
    let outputQueue = Promise.resolve();
    let outputComplete = false;
    let outputFinalized = false;
    let outputFailed = false;
    let outputFailure: unknown;
    let output!: T;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let treePollTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (treePollTimer) clearTimeout(treePollTimer);
      opts.signal?.removeEventListener("abort", abort);
      error === undefined ? resolveRun(value as T) : rejectRun(error);
    };
    const finishClosed = () => {
      if (!closed || !outputComplete) return;
      if (terminalError !== undefined) {
        if (terminationComplete) finish(terminationFailure ?? terminalError);
        return;
      }
      if (spawnFailure) {
        finish(spawnFailure);
        return;
      }
      if (outputFailed) {
        finish(outputFailure);
        return;
      }
      closeCode === 0
        ? finish(undefined, output)
        : finish(new WebError(422, gitFailureMessage(redact(stderr))));
    };
    const finalizeOutput = () => {
      if (outputFinalized) return;
      outputFinalized = true;
      void outputQueue.then(async () => {
        if (!outputFailed) output = await stdoutConsumer.end();
      }).catch((error: unknown) => {
        outputFailed = true;
        outputFailure = error;
      }).finally(() => {
        outputComplete = true;
        finishClosed();
      });
    };
    const markTerminationComplete = (failure?: WebError) => {
      if (terminationComplete) return;
      terminationComplete = true;
      terminationFailure = failure;
      if (killTimer) clearTimeout(killTimer);
      if (treePollTimer) clearTimeout(treePollTimer);
      finishClosed();
    };
    const terminate = (error: unknown) => {
      if (terminalError !== undefined) return;
      terminalError = error;
      terminateProcessTree(child, isolatedProcessGroup, markTerminationComplete, (timer) => {
        killTimer = timer.killTimer;
        treePollTimer = timer.pollTimer;
      });
    };
    const abort = () => terminate(abortReason(opts.signal!));
    const timer = setTimeout(() => {
      const error = new WebError(422, `git timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
      terminate(error);
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (terminalError !== undefined) return;
      (child.stdout as { pause?: () => unknown } | null)?.pause?.();
      outputQueue = outputQueue.then(async () => {
        if (!outputFailed && terminalError === undefined) await stdoutConsumer.write(chunk);
      }).catch((error: unknown) => {
        outputFailed = true;
        outputFailure = error;
        if (!closed) terminate(error);
      }).finally(() => {
        if (terminalError === undefined) {
          (child.stdout as { resume?: () => unknown } | null)?.resume?.();
        }
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      if (terminalError === undefined) {
        spawnFailure ??= new WebError(500, `could not run git: ${redact(error.message)}`);
      }
    });
    child.on("close", (code) => {
      closed = true;
      closeCode = code;
      if (terminalError !== undefined && !terminationComplete && !processTreeExists(child, isolatedProcessGroup)) {
        markTerminationComplete();
      }
      finalizeOutput();
    });
    // The signal can flip after the pre-spawn check but before listener registration.
    if (opts.signal?.aborted) abort();
  });
}

function bufferedStdoutConsumer(): StdoutConsumer<string> {
  const decoder = new StringDecoder("utf8");
  let output = "";
  let bytes = 0;
  return {
    write(chunk): void {
      bytes += chunk.byteLength;
      if (bytes > MAX_STDOUT_BYTES) {
        // Never expose a plausible prefix: a cut name-status stream can still end on a NUL and a
        // cut patch can still end on a complete hunk while silently omitting later files.
        throw new WebError(422, "git output exceeded 32MB; refusing truncated output");
      }
      output += decoder.write(chunk);
    },
    end(): string {
      return output + decoder.end();
    },
  };
}

function lineStdoutConsumer(consume: GitLineConsumer): StdoutConsumer<void> {
  const decoder = new StringDecoder("utf8");
  let carry = "";
  const append = (value: string): void => {
    carry += value;
    if (carry.length > MAX_STDOUT_LINE_CHARACTERS) {
      throw new WebError(422, "git emitted an overlong stdout line");
    }
  };
  const accept = async (value: string): Promise<void> => {
    let start = 0;
    while (start < value.length) {
      const newline = value.indexOf("\n", start);
      if (newline === -1) {
        append(value.slice(start));
        return;
      }
      append(value.slice(start, newline));
      const line = carry.endsWith("\r") ? carry.slice(0, -1) : carry;
      carry = "";
      await consume(line);
      start = newline + 1;
    }
  };
  return {
    write(chunk): Promise<void> {
      return accept(decoder.write(chunk));
    },
    async end(): Promise<void> {
      await accept(decoder.end());
      if (carry) {
        const line = carry.endsWith("\r") ? carry.slice(0, -1) : carry;
        carry = "";
        await consume(line);
      }
    },
  };
}

/**
 * Stop Git and every helper it spawned. Completion means no descendant can still mutate a mirror;
 * the caller separately waits for Node's `close` event so pipes and the direct child are reaped.
 */
function terminateProcessTree(
  child: ChildProcess,
  isolatedProcessGroup: boolean,
  complete: (failure?: WebError) => void,
  captureTimers: (timers: {
    killTimer?: ReturnType<typeof setTimeout>;
    pollTimer?: ReturnType<typeof setTimeout>;
  }) => void,
): void {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
    captureTimers({ killTimer });
    return;
  }

  if (!isolatedProcessGroup && process.platform !== "win32") {
    // The extraction-worker supervisor owns this inherited process group. Killing `-pid` here
    // would either miss it or terminate the worker itself; direct-child close is still awaited,
    // and the supervisor kills any remaining helpers before releasing its scheduler slot. Still
    // escalate the direct Git child so its shorter timeout cannot stretch to the worker timeout.
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
    captureTimers({ killTimer });
    return;
  }

  if (process.platform === "win32") {
    terminateWindowsProcessTree(child, pid, complete);
    return;
  }

  signalPosixProcessGroup(child, pid, "SIGTERM");
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let killedAt: number | undefined;
  const poll = () => {
    if (!processTreeExists(child, isolatedProcessGroup)) {
      complete();
      return;
    }
    if (killedAt !== undefined && Date.now() - killedAt >= PROCESS_TREE_KILL_WAIT_MS) {
      complete(new WebError(500, "could not confirm git process tree termination"));
      return;
    }
    pollTimer = setTimeout(poll, PROCESS_TREE_POLL_MS);
    captureTimers({ killTimer, pollTimer });
  };
  killTimer = setTimeout(() => {
    signalPosixProcessGroup(child, pid, "SIGKILL");
    killedAt = Date.now();
  }, TERMINATE_GRACE_MS);
  captureTimers({ killTimer, pollTimer });
  poll();
}

function signalPosixProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

function processTreeExists(child: ChildProcess, isolatedProcessGroup: boolean): boolean {
  const pid = child.pid;
  // On Windows a started `taskkill /T /F` owns the tree-settlement boundary. The direct Git
  // process can close before taskkill has finished reaping descendants, so keep termination
  // pending until that command invokes `complete`. A missing PID has no addressable tree.
  if (process.platform === "win32") return pid !== undefined;
  if (!isolatedProcessGroup || !pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function terminateWindowsProcessTree(child: ChildProcess, pid: number, complete: () => void): void {
  try {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      complete();
    };
    killer.once("error", () => {
      child.kill("SIGKILL");
      finish();
    });
    killer.once("close", (code) => {
      if (code !== 0) child.kill("SIGKILL");
      finish();
    });
  } catch {
    child.kill("SIGKILL");
    complete();
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
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
