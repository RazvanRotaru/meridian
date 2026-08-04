/** Parent transport for one disposable full-artifact projection/index worker. */

import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CliError, EXIT } from "../errors";
import { repositoryAnalysisWorkerHeapArg } from "./repository-analysis-memory";
import {
  benchmarkWorkerOwnerArgs,
  registerBenchmarkOwnedChild,
  terminateUnregisteredBenchmarkChild,
} from "./benchmark-owned-process-registry";
import { WebError } from "./web-error";
import {
  MAX_GRAPH_PROJECT_STDERR_BYTES,
  isGraphProjectWorkerRequest,
  isGraphProjectWorkerResponse,
  type GraphProjectWorkerOutputFile,
  type GraphProjectWorkerRequest,
  type GraphProjectWorkerResult,
} from "./web-graph-project-worker-job";

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const TERMINATE_GRACE_MS = 2_000;

export interface GraphProjectChildOptions {
  signal?: AbortSignal;
  workerEntry?: string | URL;
  workerExecArgv?: readonly string[];
  workerHeapMb?: number;
  timeoutMs?: number;
}

export async function runGraphProjectChild(
  request: GraphProjectWorkerRequest,
  options: GraphProjectChildOptions = {},
): Promise<GraphProjectWorkerResult> {
  if (!isGraphProjectWorkerRequest(request)) throw new TypeError("graph projection worker request is invalid");
  if (outputExists(request)) throw new RangeError("graph projection output path already exists");
  if (options.signal?.aborted) throw abortReason(options.signal);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("graph projection timeout must be positive");
  const workerEntry = options.workerEntry ?? defaultWorkerEntry();
  const sourceMode = isTypeScriptEntry(workerEntry);
  const execArgv = options.workerExecArgv
    ? [...options.workerExecArgv]
    : sourceMode
      ? sourceWorkerExecArgv()
      : [];
  execArgv.push(repositoryAnalysisWorkerHeapArg(options.workerHeapMb));

  try {
    const result = await executeWorker(request, {
      ...options,
      workerEntry,
      execArgv,
      sourceMode,
      timeoutMs,
    });
    await verifyResult(request, result, options.signal);
    return result;
  } catch (error) {
    cleanupOutputs(request);
    throw error;
  }
}

interface ResolvedExecutionOptions extends GraphProjectChildOptions {
  workerEntry: string | URL;
  execArgv: string[];
  sourceMode: boolean;
  timeoutMs: number;
}

function executeWorker(
  request: GraphProjectWorkerRequest,
  options: ResolvedExecutionOptions,
): Promise<GraphProjectWorkerResult> {
  return new Promise((resolve, reject) => {
    let spawned: ReturnType<typeof fork> | null = null;
    try {
      spawned = fork(options.workerEntry, benchmarkWorkerOwnerArgs(), {
        detached: process.platform !== "win32",
        ...(options.sourceMode ? { cwd: sourceWorkerCwd() } : {}),
        env: workerEnvironment(options.sourceMode),
        execArgv: options.execArgv,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      spawned.once("error", () => {});
      registerBenchmarkOwnedChild(spawned.pid ?? 0);
    } catch {
      const error = transportError("could not start graph projection worker");
      if (spawned === null) reject(error);
      else void terminateUnregisteredBenchmarkChild(spawned).then(
        () => reject(error),
        (cleanupError) => {
          (error as Error & { cause?: unknown }).cause = cleanupError;
          reject(error);
        },
      );
      return;
    }
    const child = spawned;

    let response: GraphProjectWorkerResult | undefined;
    let responseError: unknown;
    let terminalReason: unknown;
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = options.signal;
    const terminate = () => {
      const pid = child.pid;
      try {
        if (pid && process.platform !== "win32") process.kill(-pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      killTimer ??= setTimeout(() => {
        try {
          if (pid && process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, TERMINATE_GRACE_MS);
      killTimer.unref?.();
    };
    const abort = () => {
      if (terminalReason !== undefined || signal === undefined) return;
      terminalReason = abortReason(signal);
      terminate();
    };
    const timeout = setTimeout(() => {
      if (settled || terminalReason !== undefined) return;
      terminalReason = new WebError(504, "graph projection timed out");
      terminate();
    }, options.timeoutMs);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      stderr = Buffer.alloc(0);
    };

    signal?.addEventListener("abort", abort, { once: true });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendTail(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("message", (value: unknown) => {
      if (response !== undefined || responseError !== undefined || terminalReason !== undefined) {
        responseError = transportError("graph projection worker sent more than one response");
        terminate();
        return;
      }
      if (!isGraphProjectWorkerResponse(value)) {
        responseError = transportError("graph projection worker sent an invalid response");
        terminate();
        return;
      }
      if (value.type === "error") {
        responseError = value.error.kind === "invalid"
          ? new WebError(422, value.error.message)
          : transportError("graph projection worker failed");
      } else {
        response = value.result;
      }
    });
    child.once("error", () => {
      responseError ??= transportError("graph projection worker process failed");
      terminate();
    });
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalReason !== undefined) {
        reject(terminalReason);
      } else if (responseError !== undefined) {
        reject(responseError);
      } else if (code !== 0 || closeSignal !== null || response === undefined) {
        reject(transportError("graph projection worker exited without a valid result"));
      } else {
        resolve(response);
      }
    });
    if (signal?.aborted) abort();
    try {
      child.send(request, (error) => {
        if (error && terminalReason === undefined) {
          responseError = transportError("could not send graph projection request");
          terminate();
        }
      });
    } catch {
      responseError = transportError("could not send graph projection request");
      terminate();
    }
  });
}

async function verifyResult(
  request: GraphProjectWorkerRequest,
  result: GraphProjectWorkerResult,
  signal?: AbortSignal,
): Promise<void> {
  if (result.id !== request.id
    || result.operation !== request.type
    || result.graphId !== request.graph.graphId
    || result.generation !== request.generation) {
    throw transportError("graph projection worker result coordinates do not match");
  }
  if (request.type === "project" || request.type === "merge") {
    if (result.projection === null
      || request.projectionOutputPath === null
      || request.projection === null
      || result.projection.path !== request.projectionOutputPath
      || result.projection.loadedDepth !== request.projection.requestedDepth
      || result.symbols !== null
      || result.topology !== null) {
      throw transportError("graph projection worker returned invalid projection coordinates");
    }
    await verifyOutput(result.projection, signal);
  } else {
    if (result.projection !== null
      || result.symbols === null
      || request.symbolOutputPath === null
      || result.symbols.path !== request.symbolOutputPath
      || (request.topologyOutputPath === null
        ? result.topology !== null
        : result.topology === null || result.topology.path !== request.topologyOutputPath)) {
      throw transportError("graph projection worker returned invalid symbol coordinates");
    }
    await verifyOutput(result.symbols, signal);
    if (result.topology !== null) await verifyOutput(result.topology, signal);
  }
}

async function verifyOutput(output: GraphProjectWorkerOutputFile, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  const before = lstatSync(output.path);
  if (!before.isFile() || before.size !== output.bytes) throw transportError("graph projection output size does not match");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(output.path, { signal })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  const after = lstatSync(output.path);
  if (!after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || after.ctimeMs !== before.ctimeMs
    || bytes !== output.bytes
    || hash.digest("hex") !== output.sha256) {
    throw transportError("graph projection output failed immutable verification");
  }
}

function outputExists(request: GraphProjectWorkerRequest): boolean {
  return (request.projectionOutputPath !== null && existsSync(request.projectionOutputPath))
    || (request.symbolOutputPath !== null && existsSync(request.symbolOutputPath))
    || (request.topologyOutputPath !== null && existsSync(request.topologyOutputPath));
}

function cleanupOutputs(request: GraphProjectWorkerRequest): void {
  if (request.projectionOutputPath !== null) rmSync(request.projectionOutputPath, { force: true });
  if (request.symbolOutputPath !== null) rmSync(request.symbolOutputPath, { force: true });
  if (request.topologyOutputPath !== null) rmSync(request.topologyOutputPath, { force: true });
}

function defaultWorkerEntry(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("../graph-project-worker.ts", import.meta.url)
    : new URL("./graph-project-worker.js", import.meta.url);
}

function sourceWorkerExecArgv(): string[] {
  const require = createRequire(import.meta.url);
  return ["--import", pathToFileURL(require.resolve("tsx")).href];
}

function sourceWorkerCwd(): string {
  return dirname(fileURLToPath(new URL("../../tsconfig.json", import.meta.url)));
}

function workerEnvironment(sourceMode: boolean): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.GITHUB_TOKEN;
  delete environment.GH_TOKEN;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  for (const name of Object.keys(environment)) if (name.startsWith("TSX_")) delete environment[name];
  if (sourceMode) environment.TSX_TSCONFIG_PATH = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
  return environment;
}

function isTypeScriptEntry(entry: string | URL): boolean {
  return (entry instanceof URL ? entry.pathname : entry).endsWith(".ts");
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.byteLength >= MAX_GRAPH_PROJECT_STDERR_BYTES) {
    return Buffer.from(chunk.subarray(chunk.byteLength - MAX_GRAPH_PROJECT_STDERR_BYTES));
  }
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= MAX_GRAPH_PROJECT_STDERR_BYTES
    ? combined
    : Buffer.from(combined.subarray(combined.byteLength - MAX_GRAPH_PROJECT_STDERR_BYTES));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new WebError(499, "graph projection was cancelled");
}

function transportError(message: string): CliError {
  return new CliError(EXIT.internal, message);
}
