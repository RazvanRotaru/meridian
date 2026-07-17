/**
 * Parent-side transport for running one extraction in an isolated Node process.
 *
 * The scheduler owns admission control; this module owns only the process lifetime and IPC
 * boundary. A promise does not settle until the child closes, so a scheduler slot continues to
 * represent a real process even during cancellation.
 */

import { fork, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CliError, EXIT } from "../errors";
import {
  errorFromExtractionWorker,
  isExtractionWorkerResponse,
  type ExtractionWorkerRequestMessage,
  type ExtractionWorkerResponseMessage,
  type ExtractionWorkerResult,
  type SerializablePipelineRequest,
} from "./extraction-worker-protocol";
import {
  GRAPH_PROJECTION_DIRECTORY,
  readGraphProjectionManifest,
} from "./graph-projection-bundle";
import {
  inspectSyntheticCapabilitySidecar,
  syntheticCapabilitySidecarPath,
} from "./synthetic-capability-sidecar";

export type {
  ExtractionWorkerResult,
  SerializablePipelineRequest,
} from "./extraction-worker-protocol";

export const MAX_EXTRACTION_WORKER_STDERR_BYTES = 8_000;
const DEFAULT_TERMINATE_GRACE_MS = 5_000;
const PROCESS_TREE_POLL_MS = 25;
const DEFAULT_PROCESS_TREE_KILL_WAIT_MS = 5_000;
const DEFAULT_WORKER_HEAP_MB = 8_192;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 20 * 60_000;

export interface ExtractionWorkerOptions {
  /** Caller-owned unpublished path. The child creates this file and the caller publishes it. */
  artifactOutputPath: string;
  /** Production cache root whose lifecycle authority protects the unpublished output stage. */
  lifecycleCacheRoot: string;
  /** Ephemeral credential sent only in the first private IPC message. */
  token?: string;
  signal?: AbortSignal;
  /** Internal: this extraction already owns a bounded upstream lifecycle slot. */
  admitted?: boolean;
  /** Internal, non-secret scheduler identity. Never sent to the child process. */
  schedulingGroup?: string;
  /** Test/dev override. Production resolves the colocated built worker automatically. */
  workerEntry?: string | URL;
  /** Test/dev override for loading a source worker; never put credentials here. */
  workerExecArgv?: readonly string[];
  terminateGraceMs?: number;
  /** Test/dev override for the post-SIGKILL process-group disappearance deadline. */
  processTreeKillWaitMs?: number;
  /** Hard wall-clock limit. The entire worker process group is terminated on expiry. */
  timeoutMs?: number;
}

export type ExtractionWorkerRunner = (
  request: SerializablePipelineRequest,
  options: Pick<
    ExtractionWorkerOptions,
    "artifactOutputPath" | "token" | "signal" | "admitted" | "schedulingGroup"
  >,
) => Promise<ExtractionWorkerResult>;

/** Fork one worker, send one request, and wait for both its response and process exit. */
export function runExtractionWorker(
  request: SerializablePipelineRequest,
  options: ExtractionWorkerOptions,
): Promise<ExtractionWorkerResult> {
  if (!options.artifactOutputPath) {
    return Promise.reject(new RangeError("extraction worker output path is required"));
  }
  const payload: ExtractionWorkerRequestMessage = {
    type: "extract",
    request: serializableRequest(request),
    artifactOutputPath: options.artifactOutputPath,
    lifecycleCacheRoot: options.lifecycleCacheRoot,
    ...(options.token ? { token: options.token } : {}),
  };
  return runExtractionProcess(
    payload,
    options.artifactOutputPath,
    join(dirname(options.artifactOutputPath), GRAPH_PROJECTION_DIRECTORY),
    options,
  );
}

function runExtractionProcess(
  payload: ExtractionWorkerRequestMessage,
  expectedArtifactPath: string,
  expectedProjectionDirectory: string,
  options: ExtractionWorkerOptions,
): Promise<ExtractionWorkerResult> {
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  if (!Number.isFinite(terminateGraceMs) || terminateGraceMs < 0) {
    return Promise.reject(new RangeError("extraction worker termination grace must be a non-negative number"));
  }
  const processTreeKillWaitMs = options.processTreeKillWaitMs ?? DEFAULT_PROCESS_TREE_KILL_WAIT_MS;
  if (!Number.isFinite(processTreeKillWaitMs) || processTreeKillWaitMs < 0) {
    return Promise.reject(new RangeError("extraction worker process-tree wait must be a non-negative number"));
  }
  const timeoutMs = options.timeoutMs ?? configuredExtractionTimeoutMs();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError("extraction worker timeout must be a positive number"));
  }

  const workerEntry = options.workerEntry ?? defaultWorkerEntry();
  const execArgv = options.workerExecArgv
    ? [...options.workerExecArgv]
    : isTypeScriptEntry(workerEntry)
      ? [workerHeapArg(), ...sourceWorkerExecArgv()]
      : [workerHeapArg()];
  return new Promise<ExtractionWorkerResult>((resolve, reject) => {
    let child: ReturnType<typeof fork>;
    try {
      child = fork(workerEntry, {
        detached: process.platform !== "win32",
        env: extractionWorkerEnvironment(),
        execArgv,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    } catch {
      reject(transportError("could not start extraction worker"));
      return;
    }

    let responseMessage: ExtractionWorkerResponseMessage | undefined;
    let terminalReason: unknown;
    let transportFailure: CliError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let windowsTreeTermination: Promise<void> | undefined;
    let windowsResponseCleanup = false;
    let terminating = false;
    let settled = false;
    let stderrTail: Buffer = Buffer.alloc(0);
    const callerSignal = options.signal;

    const terminate = () => {
      if (terminating) return;
      terminating = true;
      if (process.platform === "win32") {
        // `child.kill()` only terminates the direct Node process on Windows. Start taskkill while
        // the root PID still exists, then keep the scheduler slot until `/T /F` has completed.
        windowsTreeTermination ??= terminateWindowsProcessTree(child);
        return;
      }
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), terminateGraceMs);
    };
    const abort = () => {
      if (callerSignal === undefined) return;
      terminalReason = abortReason(callerSignal);
      terminate();
    };
    const failTransport = (message: string) => {
      if (!transportFailure) transportFailure = transportError(message);
      terminate();
    };
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      callerSignal?.removeEventListener("abort", abort);
      // The captured tail is deliberately not logged or returned: child stderr is untrusted and
      // may contain source or credentials. Retaining only a tail prevents memory amplification.
      stderrTail = Buffer.alloc(0);
    };
    callerSignal?.addEventListener("abort", abort, { once: true });
    timeoutTimer = setTimeout(() => {
      if (terminalReason !== undefined || settled) return;
      terminalReason = new CliError(
        EXIT.extractor,
        `extraction timed out after ${Math.ceil(timeoutMs / 1000)}s`,
      );
      terminate();
    }, timeoutMs);
    timeoutTimer.unref?.();
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = appendCappedTail(stderrTail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("message", (value: unknown) => {
      if (settled || terminalReason !== undefined) return;
      if (responseMessage !== undefined || !isExtractionWorkerResponse(value)) {
        failTransport("extraction worker sent an invalid response");
        return;
      }
      responseMessage = value;
      if (process.platform === "win32") {
        // A normally-exiting worker can leave detached Git/Python descendants behind. Once the
        // complete response is in the parent, the artifact is durable and it is safe to tear down
        // the entire Windows tree before treating that response as settled.
        windowsResponseCleanup = true;
        windowsTreeTermination ??= terminateWindowsProcessTree(child);
      }
    });
    child.once("error", () => {
      if (terminalReason === undefined) failTransport("extraction worker process failed");
    });
    child.once("close", (code, signal) => {
      const finishClose = (treeFailure?: CliError) => {
        if (settled) return;
        settled = true;
        // Git/Python helpers inherit the worker's process group. If the direct worker exited before
        // a helper, stop the remainder before the scheduler slot and worktree lease are released.
        cleanup();

        if (treeFailure) {
          reject(treeFailure);
          return;
        }
        if (terminalReason !== undefined) {
          reject(terminalReason);
          return;
        }
        if (transportFailure) {
          reject(transportFailure);
          return;
        }
        // Windows cleanup deliberately force-terminates the worker after its complete response is
        // received, so a non-zero direct-child exit is expected on that one success path.
        const cleanResponseExit = code === 0 && signal === null;
        if ((!cleanResponseExit && !windowsResponseCleanup) || responseMessage === undefined) {
          reject(transportError("extraction worker exited without a valid response"));
          return;
        }
        if (responseMessage.type === "error") {
          reject(errorFromExtractionWorker(responseMessage.error, options.token));
          return;
        }
        try {
          if (responseMessage.result.artifactPath !== expectedArtifactPath) {
            throw new Error("worker returned an unexpected artifact path");
          }
          if (responseMessage.result.projectionDirectory !== expectedProjectionDirectory
            || !readGraphProjectionManifest(expectedProjectionDirectory)) {
            throw new Error("worker returned an invalid projection bundle");
          }
          if (!inspectSyntheticCapabilitySidecar(syntheticCapabilitySidecarPath(expectedArtifactPath))) {
            throw new Error("worker returned an invalid synthetic capability sidecar");
          }
          const output = statSync(expectedArtifactPath);
          if (!output.isFile() || output.size !== responseMessage.result.artifactBytes) {
            throw new Error("worker artifact size does not match its result");
          }
          resolve(responseMessage.result);
        } catch {
          reject(transportError("could not verify extraction worker artifact"));
        }
      };
      if (windowsTreeTermination) {
        void windowsTreeTermination.then(() => finishClose());
      } else {
        void killRemainingProcessTree(child, processTreeKillWaitMs).then(
          () => finishClose(),
          () => finishClose(transportError("could not confirm extraction worker process tree termination")),
        );
      }
    });
    // Close the pre-fork/listener race only after every child event is observable.
    if (options.signal?.aborted) abort();

    try {
      child.send(payload, (error) => {
        if (error && !settled && terminalReason === undefined) {
          failTransport("could not send the extraction worker request");
        }
      });
    } catch {
      failTransport("could not send the extraction worker request");
    }
  });
}

/** Heap reservation used by server admission control and the child process itself. */
export function extractionWorkerHeapMb(): number {
  const configured = Number.parseInt(process.env.MERIDIAN_EXTRACTION_WORKER_HEAP_MB ?? "", 10);
  if (validHeapMb(configured)) return configured;
  const userPinned = pinnedNodeHeapMb(process.env.NODE_OPTIONS);
  return userPinned ?? DEFAULT_WORKER_HEAP_MB;
}

function pinnedNodeHeapMb(nodeOptions: string | undefined): number | undefined {
  if (!nodeOptions) return undefined;
  const matches = [...nodeOptions.matchAll(/--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)/g)];
  const parsed = Number.parseInt(matches.at(-1)?.[1] ?? "", 10);
  return validHeapMb(parsed) ? parsed : undefined;
}

function validHeapMb(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1_024 && value <= 131_072;
}

function workerHeapArg(): string {
  return `--max-old-space-size=${extractionWorkerHeapMb()}`;
}

function configuredExtractionTimeoutMs(): number {
  const configured = Number.parseInt(process.env.MERIDIAN_EXTRACTION_TIMEOUT_MS ?? "", 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_EXTRACTION_TIMEOUT_MS;
}

function signalProcessTree(child: ReturnType<typeof fork>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    child.kill(signal);
  }
}

/** Resolve only after Windows has attempted an OS-level whole-tree termination. */
function terminateWindowsProcessTree(child: ReturnType<typeof fork>): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGKILL");
    return Promise.resolve();
  }
  return new Promise((resolveTermination) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolveTermination();
    };
    try {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
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
      finish();
    }
  });
}

function killRemainingProcessTree(child: ReturnType<typeof fork>, waitMs: number): Promise<void> {
  const pid = child.pid;
  if (!pid || process.platform === "win32") return Promise.resolve();
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    // ESRCH means the process group is already gone, which is the desired state.
    if (isNoSuchProcess(error)) return Promise.resolve();
    // Permission/transient kernel errors do not prove disappearance. The bounded poll below will
    // either observe ESRCH or surface the cleanup failure without releasing the scheduler slot early.
  }
  return waitForPosixProcessGroupExit(pid, waitMs);
}

function waitForPosixProcessGroupExit(pid: number, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  return new Promise((resolveExit, rejectExit) => {
    const poll = () => {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (isNoSuchProcess(error)) {
          resolveExit();
          return;
        }
        // Any other error is "not yet confirmed gone"; keep polling until the bounded deadline.
      }
      if (Date.now() >= deadline) {
        rejectExit(new Error("process group remained alive after SIGKILL"));
        return;
      }
      setTimeout(poll, PROCESS_TREE_POLL_MS);
    };
    poll();
  });
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

/**
 * Source runs use the sibling `.ts` entry through `tsx`; a tsup bundle resolves the sibling
 * worker emitted under `dist`. Production integration must add
 * `src/server/extraction-worker-child.ts` as a second `tsup.config.ts` entry; the existing entry
 * array emits it at `dist/server/extraction-worker-child.js`, which the candidates below cover.
 */
function defaultWorkerEntry(): URL {
  if (import.meta.url.endsWith(".ts")) {
    return new URL("./extraction-worker-child.ts", import.meta.url);
  }
  // A named tsup entry can land at dist/extraction-worker-child.js, while adding the source path
  // to the existing entry array lands at dist/server/extraction-worker-child.js. Support both,
  // and also the sibling emitted by a non-bundling TypeScript build.
  const candidates = [
    new URL("./extraction-worker-child.js", import.meta.url),
    new URL("./server/extraction-worker-child.js", import.meta.url),
  ];
  return candidates.find((candidate) => existsSync(fileURLToPath(candidate))) ?? candidates[0];
}

function sourceWorkerExecArgv(): string[] {
  const require = createRequire(import.meta.url);
  return ["--import", pathToFileURL(require.resolve("tsx")).href];
}

function extractionWorkerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // The selected credential is supplied in the private IPC payload. Do not also inherit the two
  // ambient credential sources when the web server itself was started with one of them.
  delete environment.GITHUB_TOKEN;
  delete environment.GH_TOKEN;
  return environment;
}

function isTypeScriptEntry(entry: string | URL): boolean {
  return (entry instanceof URL ? entry.pathname : entry).endsWith(".ts");
}

/** Project only the declared data fields so functions or accidental credential fields cannot cross. */
function serializableRequest(request: SerializablePipelineRequest): SerializablePipelineRequest {
  return {
    absoluteRoot: request.absoluteRoot,
    cwd: request.cwd,
    materializeBoundary: request.materializeBoundary,
    ...(request.language !== undefined ? { language: request.language } : {}),
    ...(request.project !== undefined ? { project: request.project } : {}),
    ...(request.include !== undefined ? { include: [...request.include] } : {}),
    ...(request.exclude !== undefined ? { exclude: [...request.exclude] } : {}),
    ...(request.depth !== undefined ? { depth: request.depth } : {}),
    ...(request.includeExternal !== undefined ? { includeExternal: request.includeExternal } : {}),
    ...(request.includeUnresolved !== undefined ? { includeUnresolved: request.includeUnresolved } : {}),
    ...(request.excludeTests !== undefined ? { excludeTests: request.excludeTests } : {}),
    ...(request.valueRefs !== undefined ? { valueRefs: request.valueRefs } : {}),
    ...(request.changedSince !== undefined ? { changedSince: request.changedSince } : {}),
    ...(request.changedSinceLabel !== undefined ? { changedSinceLabel: request.changedSinceLabel } : {}),
    ...(request.changedSinceTimeoutMs !== undefined ? { changedSinceTimeoutMs: request.changedSinceTimeoutMs } : {}),
    ...(request.hintedFiles !== undefined ? { hintedFiles: [...request.hintedFiles] } : {}),
    ...(request.allowEmpty !== undefined ? { allowEmpty: request.allowEmpty } : {}),
    ...(request.targetName !== undefined ? { targetName: request.targetName } : {}),
    ...(request.vcs !== undefined ? { vcs: { ...request.vcs } } : {}),
  };
}

function appendCappedTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.byteLength >= MAX_EXTRACTION_WORKER_STDERR_BYTES) {
    return Buffer.from(chunk.subarray(chunk.byteLength - MAX_EXTRACTION_WORKER_STDERR_BYTES));
  }
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= MAX_EXTRACTION_WORKER_STDERR_BYTES
    ? combined
    : Buffer.from(combined.subarray(combined.byteLength - MAX_EXTRACTION_WORKER_STDERR_BYTES));
}

function transportError(message: string): CliError {
  return new CliError(EXIT.internal, message);
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
