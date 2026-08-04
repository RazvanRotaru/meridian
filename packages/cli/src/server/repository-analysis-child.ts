/** Parent transport for one disposable repository-analysis or artifact-restamp process. */

import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Target } from "@meridian/core";
import type { TypeScriptRevisionShardPolicy } from "@meridian/extractor-typescript";
import { CliError, EXIT } from "../errors";
import {
  errorFromRepositoryAnalysisWorker,
  isRepositoryAnalysisWorkerRequest,
  isRepositoryAnalysisWorkerResponse,
  MAX_REPOSITORY_WORKER_PROGRESS_EVENTS,
  MAX_REPOSITORY_WORKER_STDERR_BYTES,
  normalizeRepositoryAnalysisRequest,
  type RepositoryAnalysisFacts,
  type RepositoryAnalysisEarlyManifest,
  type RepositoryAnalysisProgress,
  type RepositoryAnalysisProgressContext,
  type RepositoryAnalysisWorkerBranchVariantResult,
  type RepositoryAnalysisWorkerFileResult,
  type RepositoryAnalysisWorkerRequest,
  type ReviewFingerprintSelection,
  type RepositoryAnalysisWorkerResponse,
  type SerializableRepositoryAnalysisRequest,
} from "./repository-analysis-worker-job";
import {
  verifiedArtifactFile,
  type VerifiedFileArtifactMaterial,
  type WebGraphArtifactSummary,
} from "./web-graph-store";
import { repositoryAnalysisWorkerHeapArg } from "./repository-analysis-memory";
import {
  benchmarkWorkerOwnerArgs,
  registerBenchmarkOwnedChild,
  terminateUnregisteredBenchmarkChild,
} from "./benchmark-owned-process-registry";

export type { SerializableRepositoryAnalysisRequest } from "./repository-analysis-worker-job";
export { isRepositoryAnalysisFacts } from "./repository-analysis-worker-job";
export type {
  RepositoryAnalysisEarlyManifest,
  RepositoryAnalysisFacts,
  RepositoryAnalysisProgress,
  RepositoryAnalysisProgressContext,
} from "./repository-analysis-worker-job";

const DEFAULT_TERMINATE_GRACE_MS = 5_000;
const DEFAULT_PROCESS_TREE_KILL_WAIT_MS = 5_000;
const PROCESS_TREE_POLL_MS = 25;
const DEFAULT_ANALYSIS_TIMEOUT_MS = 20 * 60_000;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface RepositoryAnalysisBranchVariantResult {
  material: VerifiedFileArtifactMaterial;
  byteLength: number;
  summary: WebGraphArtifactSummary;
  target: Target;
}

export interface RepositoryAnalysisChildResult extends RepositoryAnalysisFacts {
  material: VerifiedFileArtifactMaterial;
  byteLength: number;
  branchVariant: RepositoryAnalysisBranchVariantResult | null;
}

export interface RepositoryArtifactRestampRequest {
  inputArtifactPath: string;
  expectedInputDigest: string;
  branch: string | null;
}

export interface RepositoryAnalysisChildOptions {
  /** Caller-owned, unpublished path. The child creates it and the caller publishes it. */
  artifactOutputPath: string;
  id?: string;
  /** Ephemeral credential transferred only over private IPC. */
  token?: string;
  /** Cold-cache branch derivative streamed from the same validated in-child graph. */
  branchVariant?: { artifactOutputPath: string; branch: string };
  /** Produce a bounded PR-review fingerprint sidecar inside the disposable worker. */
  reviewFingerprints?: ReviewFingerprintSelection;
  /** Optional non-semantic progress channel, scoped to one exact PR revision. */
  progress?: {
    context: RepositoryAnalysisProgressContext;
    onProgress(progress: RepositoryAnalysisProgress): void;
  };
  /** One complete bounded copy of the verified changed-file manifest, before extraction. */
  onChangedManifest?(manifest: RepositoryAnalysisEarlyManifest): void | Promise<void>;
  /** Server-owned immutable TypeScript shard execution policy transferred over private IPC. */
  typeScriptRevisionShards?: TypeScriptRevisionShardPolicy;
  signal?: AbortSignal;
  /** Test/dev override; production resolves the colocated built worker. */
  workerEntry?: string | URL;
  /** Test/dev override for a source worker. */
  workerExecArgv?: readonly string[];
  /** Immutable web-server reservation; other callers resolve the same environment by default. */
  workerHeapMb?: number;
  terminateGraceMs?: number;
  processTreeKillWaitMs?: number;
  timeoutMs?: number;
}

/** Spawn exactly one process for exactly one repository artifact. */
export async function runRepositoryAnalysisChild(
  request: SerializableRepositoryAnalysisRequest,
  options: RepositoryAnalysisChildOptions,
): Promise<RepositoryAnalysisChildResult> {
  const message: RepositoryAnalysisWorkerRequest = {
    type: "analyze",
    id: workerId(options.id),
    request: normalizeRepositoryAnalysisRequest(request),
    artifactOutputPath: options.artifactOutputPath,
    earlyManifest: options.onChangedManifest !== undefined,
    branchVariant: options.branchVariant ?? null,
    reviewFingerprints: options.reviewFingerprints ?? null,
    progressContext: options.progress?.context ?? null,
    typeScriptRevisionShards: options.typeScriptRevisionShards ?? null,
    ...(options.token ? { token: options.token } : {}),
  };
  return publicResult(await runRepositoryWorkerProcess(message, options), options.artifactOutputPath);
}

/** Spawn one disposable process to validate and restamp an immutable artifact file. */
export async function runRepositoryArtifactRestampChild(
  request: RepositoryArtifactRestampRequest,
  options: RepositoryAnalysisChildOptions,
): Promise<RepositoryAnalysisChildResult> {
  if (options.branchVariant !== undefined) {
    throw new TypeError("artifact restamp child cannot request a second branch variant");
  }
  const message: RepositoryAnalysisWorkerRequest = {
    type: "restamp",
    id: workerId(options.id),
    inputArtifactPath: request.inputArtifactPath,
    expectedInputDigest: request.expectedInputDigest,
    artifactOutputPath: options.artifactOutputPath,
    branch: request.branch,
  };
  return publicResult(await runRepositoryWorkerProcess(message, options), options.artifactOutputPath);
}

function runRepositoryWorkerProcess(
  message: RepositoryAnalysisWorkerRequest,
  options: RepositoryAnalysisChildOptions,
): Promise<RepositoryAnalysisWorkerFileResult> {
  if (!isRepositoryAnalysisWorkerRequest(message)) {
    return Promise.reject(new TypeError("repository analysis worker request is invalid"));
  }
  const variantOutputPath = message.type === "analyze"
    ? message.branchVariant?.artifactOutputPath
    : undefined;
  if (existsSync(options.artifactOutputPath)
    || (variantOutputPath !== undefined && existsSync(variantOutputPath))) {
    return Promise.reject(new RangeError("repository analysis output path already exists"));
  }
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  const terminateGraceMs = nonNegativeOption(
    options.terminateGraceMs,
    DEFAULT_TERMINATE_GRACE_MS,
    "repository analysis worker termination grace",
  );
  const processTreeKillWaitMs = nonNegativeOption(
    options.processTreeKillWaitMs,
    DEFAULT_PROCESS_TREE_KILL_WAIT_MS,
    "repository analysis worker process-tree wait",
  );
  const timeoutMs = positiveOption(
    options.timeoutMs,
    configuredAnalysisTimeoutMs(),
    "repository analysis worker timeout",
  );
  const workerEntry = options.workerEntry ?? defaultWorkerEntry();
  const sourceMode = isTypeScriptEntry(workerEntry);
  const execArgv = options.workerExecArgv
    ? [...options.workerExecArgv]
    : sourceMode
      ? sourceWorkerExecArgv()
      : [];
  // Keep this last so test/dev argv cannot enlarge the reserved heap.
  execArgv.push(repositoryAnalysisWorkerHeapArg(options.workerHeapMb));

  return new Promise<RepositoryAnalysisWorkerFileResult>((resolve, reject) => {
    let spawned: ReturnType<typeof fork> | null = null;
    try {
      spawned = fork(workerEntry, benchmarkWorkerOwnerArgs(), {
        detached: process.platform !== "win32",
        ...(sourceMode ? { cwd: sourceWorkerCwd() } : {}),
        env: repositoryWorkerEnvironment(sourceMode),
        execArgv,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      spawned.once("error", () => {});
      registerBenchmarkOwnedChild(spawned.pid ?? 0);
    } catch {
      const error = transportError("could not start repository analysis worker");
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

    let response: Extract<RepositoryAnalysisWorkerResponse, { type: "result" | "error" }> | undefined;
    let manifestMessages = 0;
    let progressMessages = 0;
    let terminalReason: unknown;
    let transportFailure: CliError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let windowsTreeTermination: Promise<void> | undefined;
    let windowsResponseCleanup = false;
    let terminating = false;
    let settled = false;
    let stderrTail: Buffer = Buffer.alloc(0);
    const signal = options.signal;

    const terminate = () => {
      if (terminating) return;
      terminating = true;
      if (process.platform === "win32") {
        windowsTreeTermination ??= terminateWindowsProcessTree(child);
        return;
      }
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), terminateGraceMs);
    };
    const abort = () => {
      if (signal === undefined || terminalReason !== undefined) return;
      terminalReason = abortReason(signal);
      terminate();
    };
    const failTransport = (messageText: string) => {
      transportFailure ??= transportError(messageText);
      terminate();
    };
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", abort);
      stderrTail = Buffer.alloc(0);
    };
    const rejectAfterCleanup = (error: unknown) => {
      cleanupWorkerOutputs(message);
      reject(error);
    };

    signal?.addEventListener("abort", abort, { once: true });
    timeoutTimer = setTimeout(() => {
      if (terminalReason !== undefined || settled) return;
      terminalReason = new CliError(
        EXIT.extractor,
        `repository analysis timed out after ${Math.ceil(timeoutMs / 1000)}s`,
      );
      terminate();
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = appendCappedTail(stderrTail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("message", (value: unknown) => {
      if (settled || terminalReason !== undefined) return;
      if (!isRepositoryAnalysisWorkerResponse(value)) {
        failTransport("repository analysis worker sent an invalid response");
        return;
      }
      if (value.type === "progress") {
        progressMessages += 1;
        if (progressMessages > MAX_REPOSITORY_WORKER_PROGRESS_EVENTS) {
          failTransport("repository analysis worker exceeded the progress event limit");
          return;
        }
        if (response !== undefined
          || message.type !== "analyze"
          || message.progressContext === null
          || value.id !== message.id
          || !isDeepStrictEqual(value.progress.version, message.progressContext.version)
          || !isDeepStrictEqual(value.progress.revision, message.progressContext.revision)) {
          failTransport("repository analysis worker sent progress for an invalid revision");
          return;
        }
        try {
          const result = options.progress?.onProgress(value.progress);
          sinkPromiseLike(result);
        } catch {
          // Progress is observational; a consumer cannot change or fail graph extraction.
        }
        return;
      }
      if (value.type === "manifest") {
        manifestMessages += 1;
        if (manifestMessages > 1
          || response !== undefined
          || message.type !== "analyze"
          || !message.earlyManifest
          || message.request.changedSince === null
          || value.id !== message.id) {
          failTransport("repository analysis worker sent an invalid early manifest");
          return;
        }
        try {
          const result = options.onChangedManifest?.(value.manifest);
          sinkPromiseLike(result);
        } catch {
          // The early manifest is observational; a consumer cannot change graph extraction.
        }
        return;
      }
      if (response !== undefined) {
        failTransport("repository analysis worker sent more than one terminal response");
        return;
      }
      response = value;
      if (process.platform === "win32") {
        windowsResponseCleanup = true;
        windowsTreeTermination ??= terminateWindowsProcessTree(child);
      }
    });
    child.once("error", () => {
      if (terminalReason === undefined) failTransport("repository analysis worker process failed");
    });
    child.once("close", (code, closeSignal) => {
      const finishClose = async (treeFailure?: CliError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (treeFailure) {
          rejectAfterCleanup(treeFailure);
          return;
        }
        if (terminalReason !== undefined) {
          rejectAfterCleanup(terminalReason);
          return;
        }
        if (transportFailure) {
          rejectAfterCleanup(transportFailure);
          return;
        }
        const cleanResponseExit = code === 0 && closeSignal === null;
        if ((!cleanResponseExit && !windowsResponseCleanup) || response === undefined) {
          const exitSummary = closeSignal === null
            ? `exit ${code ?? "unknown"}`
            : `signal ${closeSignal}`;
          rejectAfterCleanup(transportError(
            `repository analysis worker exited without a valid response (${exitSummary})`,
          ));
          return;
        }
        if (response.type === "error") {
          rejectAfterCleanup(errorFromRepositoryAnalysisWorker(response.error, options.token));
          return;
        }
        try {
          await verifyWorkerResult(response.result, message, signal);
          resolve(response.result);
        } catch {
          rejectAfterCleanup(signal?.aborted
            ? abortReason(signal)
            : transportError("could not verify repository analysis worker artifact"));
        }
      };
      if (windowsTreeTermination) {
        void windowsTreeTermination.then(
          () => void finishClose(),
          () => void finishClose(transportError("could not terminate repository analysis worker tree")),
        );
      } else {
        void killRemainingProcessTree(child, processTreeKillWaitMs).then(
          () => void finishClose(),
          () => void finishClose(transportError("could not confirm repository analysis worker tree termination")),
        );
      }
    });

    // Close the pre-fork/listener race before sending work.
    if (signal?.aborted) abort();
    try {
      child.send(message, (error) => {
        if (error && !settled && terminalReason === undefined) {
          failTransport("could not send repository analysis worker request");
        }
      });
    } catch {
      failTransport("could not send repository analysis worker request");
    }
  });
}

function sinkPromiseLike(value: unknown): void {
  if (
    (typeof value !== "object" || value === null)
    && typeof value !== "function"
  ) {
    return;
  }
  try {
    if (typeof (value as { then?: unknown }).then === "function") {
      void Promise.resolve(value).catch(() => {});
    }
  } catch {
    // Progress observers cannot fail repository analysis.
  }
}

async function verifyWorkerResult(
  result: RepositoryAnalysisWorkerFileResult,
  request: RepositoryAnalysisWorkerRequest,
  signal?: AbortSignal,
): Promise<void> {
  if (result.operation !== request.type || result.id !== request.id
    || result.artifactPath !== request.artifactOutputPath) {
    throw new Error("repository analysis worker result coordinates do not match");
  }
  const material = await verifyRepositoryArtifactFile(
    request.artifactOutputPath,
    result.artifactBytes,
    result.artifactSha256,
    result.graphSummary,
    signal,
  );
  if (material === null) throw new Error("repository analysis worker artifact digest does not match");
  if (request.type === "analyze" && request.branchVariant !== null) {
    if (result.branchVariant === null
      || result.branchVariant.artifactPath !== request.branchVariant.artifactOutputPath
      || !isDeepStrictEqual(result.branchVariant.graphSummary, result.graphSummary)
      || !isExpectedBranchTarget(result.target, result.branchVariant.target, request.branchVariant.branch)) {
      throw new Error("repository analysis worker branch variant coordinates do not match");
    }
    const variant = await verifyRepositoryArtifactFile(
      request.branchVariant.artifactOutputPath,
      result.branchVariant.artifactBytes,
      result.branchVariant.artifactSha256,
      result.branchVariant.graphSummary,
      signal,
    );
    if (variant === null) throw new Error("repository analysis worker branch variant digest does not match");
  } else if (result.branchVariant !== null) {
    throw new Error("repository analysis worker returned an unexpected branch variant");
  }
}

/** Stream verification keeps the graph out of the parent heap while proving the child attestation. */
async function measureArtifact(
  path: string,
  signal?: AbortSignal,
): Promise<{ byteDigest: string; byteLength: number }> {
  if (signal?.aborted) throw abortReason(signal);
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    if (signal?.aborted) throw abortReason(signal);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    hash.update(bytes);
  }
  return { byteDigest: hash.digest("hex"), byteLength };
}

/** Verify an immutable cache artifact without parsing or retaining its graph in the parent. */
export async function verifyRepositoryArtifactFile(
  path: string,
  expectedBytes: number,
  expectedDigest: string,
  summary: WebGraphArtifactSummary,
  signal?: AbortSignal,
): Promise<VerifiedFileArtifactMaterial | null> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    return null;
  }
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.size !== expectedBytes) return null;
    const measured = await measureArtifact(path, signal);
    const after = lstatSync(path);
    if (!after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || measured.byteLength !== expectedBytes
      || measured.byteDigest !== expectedDigest) return null;
    return verifiedArtifactFile(path, expectedDigest, summary);
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    return null;
  }
}

function isExpectedBranchTarget(primary: Target, variant: Target, branch: string): boolean {
  if (primary.vcs === undefined) return false;
  return isDeepStrictEqual(variant, {
    ...primary,
    vcs: { ...primary.vcs, branch },
  });
}

function publicResult(
  result: RepositoryAnalysisWorkerFileResult,
  artifactOutputPath: string,
): RepositoryAnalysisChildResult {
  const material = verifiedArtifactFile(
    artifactOutputPath,
    result.artifactSha256,
    result.graphSummary,
  );
  return {
    material,
    byteLength: result.artifactBytes,
    branchVariant: publicBranchVariant(result.branchVariant),
    summary: result.graphSummary,
    target: result.target,
    changedFiles: result.changedFiles,
    initialGraphSeedFiles: result.initialGraphSeedFiles,
    emptySideHints: result.emptySideHints,
    sourceFiles: result.sourceFiles,
    changedSinceBaseRef: result.changedSinceBaseRef,
    warnings: result.warnings,
  };
}

function publicBranchVariant(
  result: RepositoryAnalysisWorkerBranchVariantResult | null,
): RepositoryAnalysisBranchVariantResult | null {
  if (result === null) return null;
  return {
    material: verifiedArtifactFile(
      result.artifactPath,
      result.artifactSha256,
      result.graphSummary,
    ),
    byteLength: result.artifactBytes,
    summary: result.graphSummary,
    target: result.target,
  };
}

function cleanupWorkerOutputs(request: RepositoryAnalysisWorkerRequest): void {
  rmSync(request.artifactOutputPath, { force: true });
  if (request.type === "analyze" && request.branchVariant !== null) {
    rmSync(request.branchVariant.artifactOutputPath, { force: true });
  }
}

function configuredAnalysisTimeoutMs(): number {
  const value = Number.parseInt(process.env.MERIDIAN_REPOSITORY_ANALYSIS_TIMEOUT_MS ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_ANALYSIS_TIMEOUT_MS;
}

function signalProcessTree(child: ReturnType<typeof fork>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

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
    if (isNoSuchProcess(error)) return Promise.resolve();
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
      }
      if (Date.now() >= deadline) {
        rejectExit(new Error("repository analysis process group remained alive"));
        return;
      }
      setTimeout(poll, PROCESS_TREE_POLL_MS);
    };
    poll();
  });
}

function defaultWorkerEntry(): URL {
  if (import.meta.url.endsWith(".ts")) {
    return new URL("../repository-analysis-worker.ts", import.meta.url);
  }
  return new URL("./repository-analysis-worker.js", import.meta.url);
}

function sourceWorkerExecArgv(): string[] {
  const require = createRequire(import.meta.url);
  return ["--import", pathToFileURL(require.resolve("tsx")).href];
}

function repositoryWorkerEnvironment(sourceMode: boolean): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.GITHUB_TOKEN;
  delete environment.GH_TOKEN;
  // Ambient Node hooks are not part of the worker's content-addressed runtime provenance.
  // Explicit source-mode loaders and the heap reservation remain in execArgv above.
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  for (const name of Object.keys(environment)) {
    if (name.startsWith("TSX_")) delete environment[name];
  }
  if (sourceMode) environment.TSX_TSCONFIG_PATH = sourceWorkerTsconfig();
  return environment;
}

function sourceWorkerTsconfig(): string {
  return fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
}

function sourceWorkerCwd(): string {
  return dirname(sourceWorkerTsconfig());
}

function appendCappedTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.byteLength >= MAX_REPOSITORY_WORKER_STDERR_BYTES) {
    return Buffer.from(chunk.subarray(chunk.byteLength - MAX_REPOSITORY_WORKER_STDERR_BYTES));
  }
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= MAX_REPOSITORY_WORKER_STDERR_BYTES
    ? combined
    : Buffer.from(combined.subarray(combined.byteLength - MAX_REPOSITORY_WORKER_STDERR_BYTES));
}

function workerId(value: string | undefined): string {
  const id = value ?? "analysis";
  if (!WORKER_ID.test(id)) throw new TypeError("repository analysis worker id is invalid");
  return id;
}

function nonNegativeOption(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < 0) throw new RangeError(`${label} must be non-negative`);
  return selected;
}

function positiveOption(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0) throw new RangeError(`${label} must be positive`);
  return selected;
}

function isTypeScriptEntry(entry: string | URL): boolean {
  return (entry instanceof URL ? entry.pathname : entry).endsWith(".ts");
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
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
