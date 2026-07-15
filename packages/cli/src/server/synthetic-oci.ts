/** Host-side OCI boundary for compiling and executing untrusted PR source. */

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { syntheticExecutionSchema } from "@meridian/core";
import type { SyntheticExecution } from "@meridian/core";
import { SyntheticExecutionError } from "./synthetic-error";
import type { RunSyntheticScenarioRequest } from "./synthetic-execution";
import { syntheticWorkerBundlePath } from "./synthetic-compiler-child";
import { parseSyntheticWorkerError } from "./synthetic-worker-job";

export const SYNTHETIC_OCI_IMAGE = "node:22";
export const SYNTHETIC_OCI_RESULT_PREFIX = "__MERIDIAN_SYNTHETIC_OCI__=";
const MAX_JOB_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 25_000;
const DOCKER_ENV = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
// Docker's client config can inject proxy variables into every new container, including proxy URLs
// with embedded credentials. Explicit empty values win over that ambient config. NODE_OPTIONS is
// also cleared so the selected image cannot preload code before the bundled worker starts.
const SCRUBBED_CONTAINER_ENV = [
  "HTTP_PROXY=", "http_proxy=",
  "HTTPS_PROXY=", "https_proxy=",
  "FTP_PROXY=", "ftp_proxy=",
  "ALL_PROXY=", "all_proxy=",
  "NO_PROXY=", "no_proxy=",
  "NODE_OPTIONS=",
] as const;

export interface RunSyntheticScenarioInOciRequest extends Omit<RunSyntheticScenarioRequest, "artifact"> {
  /** Immutable graph file mounted read-only; the host server never opens or decodes it. */
  artifactPath: string;
  /** Required for PR execution. Both the host and the container recheck it. */
  expectedSourceFingerprint: string;
  signal?: AbortSignal;
}

/** True only when the complete OCI boundary is ready. Images are never pulled implicitly. */
export function syntheticPrSandboxRuntimeSupported(): boolean {
  if (syntheticWorkerBundlePath() === null || syntheticOciContainerUser() === null) return false;
  const daemon = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    env: DOCKER_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  if (daemon.status !== 0 || daemon.error !== undefined || daemon.stdout.trim() === "") return false;
  const image = spawnSync("docker", ["image", "inspect", SYNTHETIC_OCI_IMAGE], {
    env: DOCKER_ENV,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 2_000,
  });
  return image.status === 0 && image.error === undefined;
}

/** Compile and execute a scenario inside a disposable, networkless, non-root container. There is
 * deliberately no process-only fallback for this API. */
export async function runSyntheticScenarioInOci(
  request: RunSyntheticScenarioInOciRequest,
): Promise<SyntheticExecution> {
  const sourceRoot = canonicalDirectory(request.sourceRoot);
  const artifactPath = canonicalFile(request.artifactPath);
  const workerPath = syntheticWorkerBundlePath();
  if (workerPath === null || !syntheticPrSandboxRuntimeSupported()) {
    throw new SyntheticExecutionError(
      "unsupported-runtime",
      422,
      `PR synthetic execution requires Docker and the preinstalled ${SYNTHETIC_OCI_IMAGE} sandbox image.`,
    );
  }
  assertMountPath(sourceRoot);
  assertMountPath(artifactPath);
  assertMountPath(workerPath);
  const containerUser = syntheticOciContainerUser();
  if (containerUser === null) {
    throw new SyntheticExecutionError("unsupported-runtime", 422, "PR synthetic execution refuses a root Docker host identity.");
  }
  const {
    sourceRoot: _sourceRoot,
    artifactPath: _artifactPath,
    compilationMode: _compilationMode,
    signal: _signal,
    ...job
  } = request;
  const serialized = JSON.stringify(job);
  if (Buffer.byteLength(serialized, "utf8") > MAX_JOB_BYTES) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic OCI job is too large.");
  }
  const containerName = `meridian-synthetic-${randomUUID()}`;
  const args = buildSyntheticOciDockerArgs(containerName, sourceRoot, artifactPath, workerPath, containerUser);
  const stdout = await runDockerContainer(containerName, args, serialized, request.signal);
  return parseSyntheticOciResult(stdout);
}

/** Exported for a focused security regression test; callers should use runSyntheticScenarioInOci. */
export function buildSyntheticOciDockerArgs(
  containerName: string,
  sourceRoot: string,
  artifactPath: string,
  workerPath: string,
  containerUser: string,
): string[] {
  return [
    "run",
    "--pull=never",
    "--rm",
    "--interactive",
    "--name", containerName,
    "--network=none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--memory", "512m",
    "--cpus", "1",
    "--ulimit", "nofile=256:256",
    "--ipc=none",
    "--log-driver=none",
    "--user", containerUser,
    "--workdir=/tmp",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=192m,mode=1777",
    "--mount", `type=bind,src=${sourceRoot},dst=/source,readonly`,
    "--mount", `type=bind,src=${artifactPath},dst=/artifact.json,readonly`,
    "--mount", `type=bind,src=${workerPath},dst=/opt/meridian/synthetic-oci-worker.js,readonly`,
    "--env", "LANG=C",
    "--env", "LC_ALL=C",
    "--env", "TZ=UTC",
    "--env", "HOME=/tmp",
    ...SCRUBBED_CONTAINER_ENV.flatMap((value) => ["--env", value]),
    "--entrypoint=node",
    SYNTHETIC_OCI_IMAGE,
    "--max-old-space-size=192",
    "--disable-proto=delete",
    "/opt/meridian/synthetic-oci-worker.js",
    "run-oci",
    "-",
    "/source",
    "/artifact.json",
  ];
}

function runDockerContainer(
  containerName: string,
  args: string[],
  job: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolveContainer, rejectContainer) => {
    const child = spawn("docker", args, {
      env: DOCKER_ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderrBytes = 0;
    let settled = false;
    const forceRemove = () => {
      spawnSync("docker", ["rm", "--force", containerName], {
        env: DOCKER_ENV,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 2_000,
      });
    };
    const abort = () => fail(abortReason(signal!));
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      forceRemove();
      cleanup();
      rejectContainer(error);
    };
    const timer = setTimeout(() => fail(new SyntheticExecutionError(
      "execution-failed",
      422,
      "Synthetic OCI execution exceeded the 25 second time limit.",
    )), TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        fail(new SyntheticExecutionError("execution-failed", 422, "Synthetic OCI execution produced too much output."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        fail(new SyntheticExecutionError("execution-failed", 422, "Synthetic OCI execution produced too much diagnostic output."));
      }
    });
    child.on("error", () => fail(new SyntheticExecutionError(
      "unsupported-runtime",
      422,
      "Docker could not start the synthetic OCI sandbox.",
    )));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (code !== 0) {
        rejectContainer(parseSyntheticWorkerError(stdout, "OCI")
          ?? new SyntheticExecutionError("execution-failed", 422, "Synthetic execution failed inside the OCI sandbox."));
        return;
      }
      resolveContainer(stdout);
    });
    child.stdin.end(job, "utf8");
  });
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Match the source checkout owner so a 0700 prepared clone remains private from other host
 * users while readable inside Docker. Root hosts are refused rather than mapped into a container. */
export function syntheticOciContainerUser(): string | null {
  if (typeof process.getuid !== "function") return "65532:65532";
  const uid = process.getuid();
  if (uid === 0) return null;
  const gid = typeof process.getgid === "function" ? process.getgid() : uid;
  return `${uid}:${gid}`;
}

/** Strict result boundary, exported for focused protocol tests. */
export function parseSyntheticOciResult(stdout: string): SyntheticExecution {
  const marker = stdout.lastIndexOf(SYNTHETIC_OCI_RESULT_PREFIX);
  if (marker < 0) {
    throw new SyntheticExecutionError("invalid-result", 500, "Synthetic OCI worker returned no result.");
  }
  const line = stdout.slice(marker + SYNTHETIC_OCI_RESULT_PREFIX.length).split(/\r?\n/, 1)[0];
  try {
    const envelope = JSON.parse(line) as unknown;
    if (!isRecord(envelope)
      || !hasExactKeys(envelope, ["ok", "result"])
      || envelope.ok !== true
      || !isRecord(envelope.result)
      || Object.keys(envelope.result).some((key) => !EXECUTION_RESULT_KEYS.has(key))) throw new Error();
    const parsed = syntheticExecutionSchema.safeParse(envelope.result);
    if (parsed === null || !parsed.success) throw new Error();
    return parsed.data;
  } catch {
    throw new SyntheticExecutionError("invalid-result", 500, "Synthetic OCI worker returned malformed data.");
  }
}

const EXECUTION_RESULT_KEYS = new Set([
  "executionVersion", "scenarioId", "rootId", "generatedAt", "input", "outcome", "output",
  "trace", "snapshots", "inputOverrideResults", "watchHits", "stop", "warnings",
]);

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalDirectory(path: string): string {
  try {
    const canonical = realpathSync.native(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error();
    return canonical;
  } catch {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution source root is unavailable.");
  }
}

function canonicalFile(path: string): string {
  try {
    const canonical = realpathSync.native(resolve(path));
    const entry = statSync(canonical);
    if (!entry.isFile() || entry.size < 1) throw new Error();
    return canonical;
  } catch {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic execution artifact is unavailable.");
  }
}

function assertMountPath(path: string): void {
  if (path.includes(",") || path.includes("\n") || path.includes("\r") || path.includes("\0")) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic sandbox mount path is unsupported.");
  }
}
