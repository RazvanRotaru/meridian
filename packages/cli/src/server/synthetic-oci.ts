/** Host-side OCI boundary for compiling and executing untrusted PR source. */

import { randomUUID } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { syntheticExecutionSchema } from "@meridian/core";
import type { SyntheticExecution } from "@meridian/core";
import { SyntheticExecutionError } from "./synthetic-error";
import type { RunSyntheticScenarioRequest } from "./synthetic-execution";
import { syntheticSourceFingerprint } from "./synthetic-fingerprint";
import { syntheticWorkerBundlePath } from "./synthetic-compiler-child";
import { syntheticAbortReason } from "./synthetic-child";
import { parseSyntheticWorkerError } from "./synthetic-worker-job";

export const SYNTHETIC_OCI_IMAGE = "node:22";
export const SYNTHETIC_OCI_RESULT_PREFIX = "__MERIDIAN_SYNTHETIC_OCI__=";
const MAX_JOB_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 25_000;
const CONTAINER_CLEANUP_OBSERVATIONS = 10;
const CONTAINER_CLEANUP_INTERVAL_MS = 100;
const CONTAINER_CLEANUP_COMMAND_TIMEOUT_MS = 1_000;
const REQUIRED_FINAL_ABSENCE_OBSERVATIONS = 2;
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

export interface RunSyntheticScenarioInOciRequest extends RunSyntheticScenarioRequest {
  /** Required for PR execution. Both the host and the container recheck it. */
  expectedSourceFingerprint: string;
}

export interface SyntheticOciContainerCleanupOperations {
  forceRemove(containerName: string): Promise<void>;
  observe(containerName: string): Promise<"present" | "absent" | "unknown">;
  wait(delayMs: number): Promise<void>;
}

const DOCKER_CONTAINER_CLEANUP: SyntheticOciContainerCleanupOperations = {
  async forceRemove(containerName) {
    await runDockerCleanupCommand(["rm", "--force", containerName]);
  },
  async observe(containerName) {
    const observation = await runDockerCleanupCommand(
      ["container", "ls", "--all", "--quiet", "--filter", `name=^/${containerName}$`],
    );
    if (!observation.ok) return "unknown";
    return observation.stdout.trim() === "" ? "absent" : "present";
  },
  wait(delayMs) {
    return new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
  },
};

function runDockerCleanupCommand(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolveCommand) => {
    execFile("docker", args, {
      env: DOCKER_ENV,
      encoding: "utf8",
      timeout: CONTAINER_CLEANUP_COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024,
    }, (error, stdout) => {
      resolveCommand({ ok: error === null, stdout });
    });
  });
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
  if (request.signal?.aborted) throw syntheticAbortReason(request.signal);
  const sourceRoot = canonicalDirectory(request.sourceRoot);
  if (syntheticSourceFingerprint(sourceRoot, request.artifact) !== request.expectedSourceFingerprint) {
    throw new SyntheticExecutionError("invalid-request", 409, "Synthetic scenario source changed after it was selected; reload the graph.");
  }
  const workerPath = syntheticWorkerBundlePath();
  if (workerPath === null || !syntheticPrSandboxRuntimeSupported()) {
    throw new SyntheticExecutionError(
      "unsupported-runtime",
      422,
      `PR synthetic execution requires Docker and the preinstalled ${SYNTHETIC_OCI_IMAGE} sandbox image.`,
    );
  }
  assertMountPath(sourceRoot);
  assertMountPath(workerPath);
  const containerUser = syntheticOciContainerUser();
  if (containerUser === null) {
    throw new SyntheticExecutionError("unsupported-runtime", 422, "PR synthetic execution refuses a root Docker host identity.");
  }
  const { sourceRoot: _sourceRoot, compilationMode: _compilationMode, signal, ...job } = request;
  const serialized = JSON.stringify(job);
  if (Buffer.byteLength(serialized, "utf8") > MAX_JOB_BYTES) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic OCI job is too large.");
  }
  const containerName = `meridian-synthetic-${randomUUID()}`;
  const args = buildSyntheticOciDockerArgs(containerName, sourceRoot, workerPath, containerUser);
  const stdout = await runDockerContainer(containerName, args, serialized, signal);
  return parseSyntheticOciResult(stdout);
}

/** Exported for a focused security regression test; callers should use runSyntheticScenarioInOci. */
export function buildSyntheticOciDockerArgs(
  containerName: string,
  sourceRoot: string,
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
  ];
}

function runDockerContainer(
  containerName: string,
  args: string[],
  job: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(syntheticAbortReason(signal));
  return new Promise((resolveContainer, rejectContainer) => {
    const child = spawn("docker", args, {
      env: DOCKER_ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderrBytes = 0;
    let settled = false;
    let terminalReason: unknown;
    let containerCleanupRequired = child.pid !== undefined;
    child.once("spawn", () => { containerCleanupRequired = true; });
    const terminate = (error: unknown) => {
      if (settled || terminalReason !== undefined) return;
      terminalReason = error;
      clearTimeout(timer);
      child.kill("SIGKILL");
    };
    const abort = () => {
      if (signal !== undefined) terminate(syntheticAbortReason(signal));
    };
    const timer = setTimeout(() => terminate(new SyntheticExecutionError(
      "execution-failed",
      422,
      "Synthetic OCI execution exceeded the 25 second time limit.",
    )), TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (terminalReason !== undefined) return;
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        terminate(new SyntheticExecutionError("execution-failed", 422, "Synthetic OCI execution produced too much output."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (terminalReason !== undefined) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        terminate(new SyntheticExecutionError("execution-failed", 422, "Synthetic OCI execution produced too much diagnostic output."));
      }
    });
    // Docker can close its input while an abort or an early container failure races the job write.
    // The process close event remains the sole owner of the public outcome; consume the stream
    // error here so EPIPE cannot escape as an uncaught process exception.
    child.stdin.on("error", () => {});
    child.on("error", () => {
      if (child.pid === undefined) containerCleanupRequired = false;
      if (terminalReason !== undefined) return;
      // A spawn failure cannot have submitted a container create request. Preserve the established
      // unsupported-runtime result instead of replacing it with an unverifiable cleanup error.
      containerCleanupRequired = false;
      terminate(new SyntheticExecutionError(
        "unsupported-runtime",
        422,
        "Docker could not start the synthetic OCI sandbox.",
      ));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (terminalReason !== undefined) {
        if (!containerCleanupRequired) {
          rejectContainer(terminalReason);
          return;
        }
        // Killing the Docker client does not synchronously cancel a daemon-side create request.
        // Begin cleanup only after the client has exited, then keep removing the exact container
        // name throughout a bounded quiescence window so a container that appears after the first
        // `rm` cannot survive cancellation.
        void verifySyntheticOciContainerRemoved(containerName).then(
          () => rejectContainer(terminalReason),
          (cleanupError: unknown) => rejectContainer(cleanupError),
        );
        return;
      }
      if (code !== 0) {
        rejectContainer(parseSyntheticWorkerError(stdout, "OCI")
          ?? new SyntheticExecutionError("execution-failed", 422, "Synthetic execution failed inside the OCI sandbox."));
        return;
      }
      resolveContainer(stdout);
    });
    child.stdin.end(job, "utf8");
    if (signal?.aborted) abort();
  });
}

/** Force-remove a cancelled OCI sandbox and prove it stays absent for a bounded quiescence
 * window. Exported only so the daemon create/remove race can be covered deterministically. */
export async function verifySyntheticOciContainerRemoved(
  containerName: string,
  operations: SyntheticOciContainerCleanupOperations = DOCKER_CONTAINER_CLEANUP,
): Promise<void> {
  let finalAbsenceObservations = 0;
  for (let attempt = 0; attempt < CONTAINER_CLEANUP_OBSERVATIONS; attempt += 1) {
    try {
      await operations.forceRemove(containerName);
    } catch {
      // The subsequent daemon-backed observation decides whether cleanup is complete. A failed
      // removal is retried for the remainder of the bounded window.
    }
    let observation: "present" | "absent" | "unknown" = "unknown";
    try {
      observation = await operations.observe(containerName);
    } catch {
      // Treat an observation failure as unknown rather than mistaking daemon unavailability for
      // proof that the container is absent.
    }
    finalAbsenceObservations = observation === "absent"
      ? finalAbsenceObservations + 1
      : 0;
    if (attempt + 1 < CONTAINER_CLEANUP_OBSERVATIONS) {
      try {
        await operations.wait(CONTAINER_CLEANUP_INTERVAL_MS);
      } catch {
        break;
      }
    }
  }
  if (finalAbsenceObservations >= REQUIRED_FINAL_ABSENCE_OBSERVATIONS) return;
  throw new SyntheticExecutionError(
    "execution-failed",
    500,
    "Synthetic OCI sandbox cleanup could not be verified.",
  );
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

function assertMountPath(path: string): void {
  if (path.includes(",") || path.includes("\n") || path.includes("\r") || path.includes("\0")) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic sandbox mount path is unsupported.");
  }
}
