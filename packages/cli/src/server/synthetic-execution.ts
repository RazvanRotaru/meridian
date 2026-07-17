/**
 * Public orchestration for local, opt-in synthetic execution.
 *
 * Repository configuration chooses an exported function/factory and JSON input. Local execution
 * uses a scrubbed, permission-gated runner child; untrusted PR execution enters through the OCI
 * backend exported below. There is deliberately no unrestricted PR fallback.
 */

import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  boundedSyntheticJsonValueSchema,
  SYNTHETIC_MANIFEST_VERSION,
  syntheticFieldWatchersSchema,
  syntheticInputOverridesSchema,
  syntheticExecutionManifestSchema,
  syntheticExecutionSchema,
} from "@meridian/core";
import type {
  GraphArtifact,
  JsonValue,
  SyntheticExecution,
  SyntheticExecutionManifest,
  SyntheticExecutionManifestEntry,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
  SyntheticScenarioDescriptor,
} from "@meridian/core";
import { executeSyntheticChild, executeSyntheticChildInsideOci, nodePermissionFlag } from "./synthetic-child";
import { compileInstrumentedProjectInSandbox, syntheticWorkerBundlePath } from "./synthetic-compiler-child";
import { SyntheticExecutionError } from "./synthetic-error";
import { syntheticSourceFingerprint } from "./synthetic-fingerprint";
import { discoverSyntheticManifestFiles } from "./synthetic-manifest-files";
import { compileInstrumentedProject } from "./synthetic-project";
import {
  parseSyntheticWorkerError,
  SYNTHETIC_ARTIFACT_FILE_RESULT_PREFIX,
} from "./synthetic-worker-job";

export { SyntheticExecutionError } from "./synthetic-error";
export type { SyntheticExecutionErrorCode } from "./synthetic-error";
export { syntheticSourceFingerprint } from "./synthetic-fingerprint";
export { runSyntheticScenarioInOci, syntheticPrSandboxRuntimeSupported } from "./synthetic-oci";
export type { RunSyntheticScenarioInOciRequest } from "./synthetic-oci";

export const SYNTHETIC_MANIFEST_FILE = "meridian.synthetic.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_FILE_JOB_BYTES = 1024 * 1024;
const MAX_ARTIFACT_FILE_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_FILE_STDERR_BYTES = 64 * 1024;
const ARTIFACT_FILE_TIMEOUT_MS = 30_000;
const ARTIFACT_FILE_TERMINATE_GRACE_MS = 1_000;
const ARTIFACT_FILE_TREE_WAIT_MS = 5_000;
const PROCESS_TREE_POLL_MS = 25;
const SYNTHETIC_EXECUTION_RESULT_KEYS = new Set([
  "executionVersion", "scenarioId", "rootId", "generatedAt", "input", "outcome", "output",
  "trace", "snapshots", "inputOverrideResults", "watchHits", "stop", "warnings",
]);

/** Servers use this to avoid advertising an action that the local runtime cannot isolate. */
export function syntheticExecutionRuntimeSupported(): boolean {
  return nodePermissionFlag() !== null;
}

/** Defense-in-depth compiler-child availability. This is not sufficient for untrusted PRs; those
 * must use syntheticPrSandboxRuntimeSupported and runSyntheticScenarioInOci. */
export function syntheticSandboxCompilationRuntimeSupported(): boolean {
  return nodePermissionFlag() !== null && syntheticWorkerBundlePath() !== null;
}

export interface RunSyntheticScenarioRequest {
  sourceRoot: string;
  artifact: GraphArtifact;
  scenarioId: string;
  /** Root selected when the browser advertised this scenario. Rechecking after the manifest is
   * reread closes the boot-to-run replacement race. */
  expectedRootId?: string;
  /** Source/config fingerprint advertised with the scenario. A mismatch means the graph must be
   * refreshed before any project compilation is attempted. */
  expectedSourceFingerprint?: string;
  input?: JsonValue;
  inputOverrides?: SyntheticInputOverride[];
  watchers?: SyntheticFieldWatcher[];
  /** A separate permission-gated compiler child for defense in depth. Untrusted PRs must use the
   * OCI API instead; this option never falls back to parent compilation. */
  compilationMode?: "trusted-parent" | "sandboxed-child";
}

export interface RunSyntheticScenarioFromArtifactFileRequest
  extends Omit<RunSyntheticScenarioRequest, "artifact" | "compilationMode"> {
  /** Immutable graph file. Only the short-lived worker opens and validates it. */
  artifactPath: string;
  signal?: AbortSignal;
}

export interface SyntheticArtifactFileWorkerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  terminateGraceMs?: number;
  processTreeWaitMs?: number;
  /** Focused tests may substitute a worker; production always uses the packaged bundle. */
  workerPath?: string;
  workerExecArgv?: readonly string[];
}

/** Missing configuration is ordinary capability absence; malformed configuration is actionable. */
export function loadSyntheticScenarios(sourceRoot: string): SyntheticScenarioDescriptor[] {
  const manifest = readManifest(sourceRoot, false);
  return manifest?.scenarios.map(({ invoke: _invoke, ...descriptor }) => descriptor) ?? [];
}

export async function runSyntheticScenario(request: RunSyntheticScenarioRequest): Promise<SyntheticExecution> {
  return runSyntheticScenarioWithIsolation(request, false);
}

/** Execute a trusted local scenario without admitting the complete graph to the long-lived server. */
export async function runSyntheticScenarioFromArtifactFile(
  request: RunSyntheticScenarioFromArtifactFileRequest,
  options: SyntheticArtifactFileWorkerOptions = {},
): Promise<SyntheticExecution> {
  if (!syntheticExecutionRuntimeSupported()) {
    throw new SyntheticExecutionError(
      "unsupported-runtime",
      422,
      "Synthetic execution requires Node 25 or newer with filesystem and network permission controls.",
    );
  }
  const sourceRoot = canonicalDirectory(request.sourceRoot);
  const artifactPath = canonicalArtifactFile(request.artifactPath);
  const worker = options.workerPath
    ? { path: options.workerPath, execArgv: options.workerExecArgv ?? [] }
    : localArtifactWorker();
  if (worker === null) {
    throw new SyntheticExecutionError("unsupported-runtime", 422, "Synthetic execution worker is unavailable.");
  }
  const {
    sourceRoot: _sourceRoot,
    artifactPath: _artifactPath,
    signal: _signal,
    ...job
  } = request;
  const serialized = JSON.stringify(job);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ARTIFACT_FILE_JOB_BYTES) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution request is too large.");
  }
  const stdout = await runSyntheticArtifactFileWorker(worker.path, sourceRoot, artifactPath, serialized, {
    ...options,
    workerExecArgv: worker.execArgv,
    signal: request.signal ?? options.signal,
  });
  return parseSyntheticArtifactFileResult(stdout);
}

/** Strict worker result boundary, exported for focused protocol tests. */
export function parseSyntheticArtifactFileResult(stdout: string): SyntheticExecution {
  const marker = stdout.lastIndexOf(SYNTHETIC_ARTIFACT_FILE_RESULT_PREFIX);
  if (marker < 0) {
    throw new SyntheticExecutionError("invalid-result", 500, "Synthetic execution worker returned no result.");
  }
  const line = stdout.slice(marker + SYNTHETIC_ARTIFACT_FILE_RESULT_PREFIX.length).split(/\r?\n/, 1)[0];
  try {
    const envelope = JSON.parse(line) as unknown;
    if (!isRecord(envelope)
      || Object.keys(envelope).length !== 2
      || envelope.ok !== true
      || !isRecord(envelope.result)
      || Object.keys(envelope.result).some((key) => !SYNTHETIC_EXECUTION_RESULT_KEYS.has(key))) throw new Error();
    const parsed = syntheticExecutionSchema.safeParse(envelope.result);
    if (!parsed.success) throw new Error();
    return parsed.data;
  } catch {
    throw new SyntheticExecutionError("invalid-result", 500, "Synthetic execution worker returned malformed data.");
  }
}

export function runSyntheticArtifactFileWorker(
  workerPath: string,
  sourceRoot: string,
  artifactPath: string,
  job: string,
  options: SyntheticArtifactFileWorkerOptions = {},
): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  const timeoutMs = positiveDuration(options.timeoutMs, ARTIFACT_FILE_TIMEOUT_MS);
  const terminateGraceMs = nonNegativeDuration(options.terminateGraceMs, ARTIFACT_FILE_TERMINATE_GRACE_MS);
  const processTreeWaitMs = positiveDuration(options.processTreeWaitMs, ARTIFACT_FILE_TREE_WAIT_MS);
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, [
      ...(options.workerExecArgv ?? []),
      "--max-old-space-size=768",
      "--disable-proto=delete",
      workerPath,
      "run-file",
      "-",
      sourceRoot,
      artifactPath,
    ], {
      detached: process.platform !== "win32",
      cwd: sourceRoot,
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: sourceRoot, TMPDIR: tmpdir() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderrBytes = 0;
    let settled = false;
    let terminalError: unknown;
    let terminating = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let windowsTreeTermination: Promise<void> | undefined;
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      if (process.platform === "win32") {
        windowsTreeTermination = terminateWindowsProcessTree(child);
        return;
      }
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), terminateGraceMs);
    };
    const fail = (error: SyntheticExecutionError) => {
      if (settled || terminalError !== undefined) return;
      terminalError = error;
      terminate();
    };
    const abort = () => {
      if (settled || terminalError !== undefined) return;
      terminalError = abortReason(options.signal!);
      terminate();
    };
    const timer = setTimeout(() => fail(new SyntheticExecutionError(
      "execution-failed",
      422,
      "Synthetic execution exceeded the 30 second time limit.",
    )), timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_ARTIFACT_FILE_STDOUT_BYTES) {
        fail(new SyntheticExecutionError("execution-failed", 422, "Synthetic execution produced too much output."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_ARTIFACT_FILE_STDERR_BYTES) {
        fail(new SyntheticExecutionError("execution-failed", 422, "Synthetic execution produced too much diagnostic output."));
      }
    });
    child.on("error", () => fail(new SyntheticExecutionError(
      "execution-failed",
      500,
      "Synthetic execution worker could not be started.",
    )));
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      const treeStopped = windowsTreeTermination ?? killRemainingProcessTree(child, processTreeWaitMs);
      void treeStopped.then(() => {
        if (settled) return;
        settled = true;
        if (terminalError !== undefined) {
          rejectWorker(terminalError);
        } else if (code !== 0) {
          rejectWorker(parseSyntheticWorkerError(stdout, "compiler")
            ?? new SyntheticExecutionError("execution-failed", 422, "Synthetic execution failed in the isolated worker."));
        } else {
          resolveWorker(stdout);
        }
      }, () => {
        if (settled) return;
        settled = true;
        rejectWorker(new SyntheticExecutionError(
          "execution-failed",
          500,
          "Synthetic execution worker process tree could not be terminated.",
        ));
      });
    });
    child.stdin.on("error", () => fail(new SyntheticExecutionError(
      "execution-failed",
      500,
      "Synthetic execution request could not be delivered to the worker.",
    )));
    child.stdin.end(job, "utf8");
  });
}

function localArtifactWorker(): { path: string; execArgv: readonly string[] } | null {
  const bundle = syntheticWorkerBundlePath();
  if (bundle !== null) return { path: bundle, execArgv: [] };
  if (!import.meta.url.endsWith(".ts")) return null;
  try {
    const path = realpathSync.native(fileURLToPath(new URL("../synthetic-oci-worker.ts", import.meta.url)));
    const require = createRequire(import.meta.url);
    return { path, execArgv: ["--import", pathToFileURL(require.resolve("tsx")).href] };
  } catch {
    return null;
  }
}

function signalProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid || process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

function terminateWindowsProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
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

function killRemainingProcessTree(child: ReturnType<typeof spawn>, waitMs: number): Promise<void> {
  const pid = child.pid;
  if (!pid || process.platform === "win32") return Promise.resolve();
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (isNoSuchProcess(error)) return Promise.resolve();
  }
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
        rejectExit(new Error("synthetic worker process group remained alive after SIGKILL"));
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

function positiveDuration(value: number | undefined, fallback: number): number {
  const effective = value ?? fallback;
  if (!Number.isFinite(effective) || effective <= 0) throw new RangeError("worker duration must be positive");
  return effective;
}

function nonNegativeDuration(value: number | undefined, fallback: number): number {
  const effective = value ?? fallback;
  if (!Number.isFinite(effective) || effective < 0) throw new RangeError("worker duration must be non-negative");
  return effective;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function canonicalArtifactFile(path: string): string {
  try {
    const canonical = realpathSync.native(resolve(path));
    const entry = statSync(canonical);
    if (!entry.isFile() || entry.size < 1) throw new Error();
    return canonical;
  } catch {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution artifact is unavailable.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Worker-only entry point. The caller must already be inside the hardened OCI boundary. */
export async function runSyntheticScenarioInsideOci(
  request: RunSyntheticScenarioRequest,
): Promise<SyntheticExecution> {
  return runSyntheticScenarioWithIsolation({ ...request, compilationMode: "trusted-parent" }, true);
}

async function runSyntheticScenarioWithIsolation(
  request: RunSyntheticScenarioRequest,
  insideOci: boolean,
): Promise<SyntheticExecution> {
  const permissionFlag = nodePermissionFlag();
  if (permissionFlag === null && !insideOci) {
    throw new SyntheticExecutionError(
      "unsupported-runtime",
      422,
      "Synthetic execution requires Node 25 or newer with filesystem and network permission controls.",
    );
  }
  const sourceRoot = canonicalDirectory(request.sourceRoot);
  const manifest = readManifest(sourceRoot, true)!;
  const scenario = manifest.scenarios.find((candidate) => candidate.id === request.scenarioId);
  if (!scenario) {
    throw new SyntheticExecutionError("scenario-not-found", 404, `Unknown synthetic scenario '${request.scenarioId}'.`);
  }
  if (request.expectedRootId !== undefined && scenario.rootId !== request.expectedRootId) {
    throw new SyntheticExecutionError("invalid-request", 409, "Synthetic scenario changed after it was selected; reload the graph.");
  }
  validateScenarioAgainstArtifact(scenario, request.artifact);
  assertExpectedSourceFingerprint(request, sourceRoot);
  const parsedInput = boundedSyntheticJsonValueSchema.safeParse(
    request.input === undefined ? scenario.defaultInput : request.input,
  );
  if (!parsedInput.success) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic scenario input must be bounded JSON data.");
  }
  const parsedOverrides = syntheticInputOverridesSchema.safeParse(request.inputOverrides ?? []);
  const parsedWatchers = syntheticFieldWatchersSchema.safeParse(request.watchers ?? []);
  if (!parsedOverrides.success || !parsedWatchers.success) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic runtime controls must be bounded and valid.");
  }

  const tempRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "meridian-synthetic-")));
  try {
    const compilation = request.compilationMode === "sandboxed-child"
      ? await compileInstrumentedProjectInSandbox(permissionFlag!, sourceRoot, tempRoot, request.artifact, scenario)
      : compileInstrumentedProject(sourceRoot, tempRoot, request.artifact, scenario);
    // Recheck immediately before execution so an ordinary editor save during compilation cannot
    // run an artifact assembled from mixed inputs. The OCI worker repeats this check internally.
    assertExpectedSourceFingerprint(request, sourceRoot);
    const runnerConfig = {
      scenario,
      input: parsedInput.data,
      inputOverrides: parsedOverrides.data,
      watchers: parsedWatchers.data,
      entryModule: `./${compilation.entryModule}`,
      nodeNames: compilation.nodeNames,
      warnings: compilation.warnings,
    };
    const raw = insideOci
      ? await executeSyntheticChildInsideOci(tempRoot, runnerConfig)
      : await executeSyntheticChild(permissionFlag!, tempRoot, runnerConfig);
    const parsed = syntheticExecutionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SyntheticExecutionError("invalid-result", 500, "Synthetic runner returned an invalid execution result.");
    }
    return parsed.data;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertExpectedSourceFingerprint(request: RunSyntheticScenarioRequest, sourceRoot: string): void {
  if (request.expectedSourceFingerprint !== undefined
    && syntheticSourceFingerprint(sourceRoot, request.artifact) !== request.expectedSourceFingerprint) {
    throw new SyntheticExecutionError("invalid-request", 409, "Synthetic scenario source changed after it was selected; reload the graph.");
  }
}

function readManifest(sourceRoot: string, required: boolean): SyntheticExecutionManifest | null {
  const root = canonicalDirectory(sourceRoot);
  const files = discoverSyntheticManifestFiles(root);
  if (files.length === 0) {
    if (required) {
      throw new SyntheticExecutionError("scenario-not-found", 404, "This source does not define synthetic execution scenarios.");
    }
    return null;
  }
  try {
    const scenarios: SyntheticExecutionManifestEntry[] = [];
    for (const file of files) {
      if (statSync(file.absolutePath).size > MAX_MANIFEST_BYTES) {
        throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest is too large.");
      }
      const parsed = syntheticExecutionManifestSchema.safeParse(JSON.parse(readFileSync(file.absolutePath, "utf8")));
      if (!parsed.success) {
        throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest is invalid.");
      }
      scenarios.push(...parsed.data.scenarios.map((scenario) => rebaseScenario(scenario, file.logicalDirectory)));
    }
    const combined = syntheticExecutionManifestSchema.safeParse({
      manifestVersion: SYNTHETIC_MANIFEST_VERSION,
      scenarios,
    });
    if (!combined.success) {
      throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest is invalid.");
    }
    return combined.data;
  } catch (error) {
    if (error instanceof SyntheticExecutionError) throw error;
    throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest could not be read.");
  }
}

function rebaseScenario(
  scenario: SyntheticExecutionManifestEntry,
  directory: string,
): SyntheticExecutionManifestEntry {
  if (directory === "") return scenario;
  const separator = scenario.rootId.indexOf(":");
  if (separator < 1) {
    throw new SyntheticExecutionError("invalid-manifest", 400, "Synthetic execution manifest is invalid.");
  }
  return {
    ...scenario,
    rootId: `${scenario.rootId.slice(0, separator + 1)}${posix.join(directory, scenario.rootId.slice(separator + 1))}`,
    invoke: {
      ...scenario.invoke,
      module: posix.join(directory, scenario.invoke.module),
    },
  };
}

function canonicalDirectory(path: string): string {
  try {
    const canonical = realpathSync.native(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution source root is unavailable.");
  }
}

function validateScenarioAgainstArtifact(scenario: SyntheticExecutionManifestEntry, artifact: GraphArtifact): void {
  if (artifact.target.language !== "typescript" && artifact.target.language !== "javascript") {
    throw new SyntheticExecutionError("unsupported-scenario", 422, "Synthetic execution POC currently supports TypeScript only.");
  }
  const root = artifact.nodes.find((node) => node.id === scenario.rootId);
  if (!root || (root.kind !== "function" && root.kind !== "method")) {
    throw new SyntheticExecutionError("unsupported-scenario", 422, "Synthetic scenario root is not a callable in this graph.");
  }
}
