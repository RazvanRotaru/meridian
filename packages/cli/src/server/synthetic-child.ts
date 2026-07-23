/** Launch and police the plain-JavaScript synthetic runner child. */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { SyntheticExecutionError } from "./synthetic-error";
import { runnerSource, SYNTHETIC_RESULT_PREFIX, type RunnerConfig } from "./synthetic-runner-source";

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const HEAP_MB = 128;

export type NodePermissionFlag = "--permission" | "--experimental-permission";

export function syntheticAbortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function nodePermissionFlag(): NodePermissionFlag | null {
  // Node 20/22's permission model did not gate sockets. Requiring the explicit network grant flag
  // proves this runtime has the newer deny-by-default network boundary; we intentionally never
  // pass that flag to the child.
  if (!process.allowedNodeEnvironmentFlags.has("--allow-net")) return null;
  if (process.allowedNodeEnvironmentFlags.has("--permission")) return "--permission";
  if (process.allowedNodeEnvironmentFlags.has("--experimental-permission")) return "--experimental-permission";
  return null;
}

export async function executeSyntheticChild(
  permissionFlag: NodePermissionFlag,
  outputRoot: string,
  config: RunnerConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  return executeChild(permissionFlag, outputRoot, config, signal);
}

/** The OCI container is the outer security boundary. This entry point is intentionally separate
 * from the local permission-model runner so an ordinary caller cannot accidentally turn off the
 * host-side permission flags. */
export async function executeSyntheticChildInsideOci(
  outputRoot: string,
  config: RunnerConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  return executeChild(null, outputRoot, config, signal);
}

async function executeChild(
  permissionFlag: NodePermissionFlag | null,
  outputRoot: string,
  config: RunnerConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(syntheticAbortReason(signal));
  const runnerPath = join(outputRoot, "__meridian_runner.mjs");
  writeFileSync(runnerPath, runnerSource(config), "utf8");
  return new Promise((resolveExecution, rejectExecution) => {
    const child = spawn(process.execPath, [
      ...(permissionFlag === null ? [] : [permissionFlag, `--allow-fs-read=${outputRoot}`]),
      `--max-old-space-size=${HEAP_MB}`,
      "--disable-proto=delete",
      runnerPath,
    ], {
      cwd: outputRoot,
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: outputRoot, TMPDIR: outputRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderrBytes = 0;
    let settled = false;
    let terminalReason: unknown;
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
      "Synthetic execution exceeded the 10 second time limit.",
    )), TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (terminalReason !== undefined) return;
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        terminate(new SyntheticExecutionError("execution-failed", 422, "Synthetic execution produced too much output."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (terminalReason !== undefined) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        terminate(new SyntheticExecutionError("execution-failed", 422, "Synthetic execution produced too much diagnostic output."));
      }
    });
    child.on("error", () => terminate(terminalReason ?? new SyntheticExecutionError(
      "execution-failed",
      500,
      "Synthetic execution process could not be started.",
    )));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (terminalReason !== undefined) {
        rejectExecution(terminalReason);
        return;
      }
      if (code !== 0) {
        rejectExecution(new SyntheticExecutionError("execution-failed", 422, "Synthetic execution failed in the isolated process."));
        return;
      }
      parseResult(stdout, resolveExecution, rejectExecution);
    });
    if (signal?.aborted) abort();
  });
}

function parseResult(
  stdout: string,
  resolveExecution: (value: unknown) => void,
  rejectExecution: (error: SyntheticExecutionError) => void,
): void {
  const marker = stdout.lastIndexOf(SYNTHETIC_RESULT_PREFIX);
  if (marker < 0) {
    rejectExecution(new SyntheticExecutionError("invalid-result", 500, "Synthetic execution process returned no result."));
    return;
  }
  const line = stdout.slice(marker + SYNTHETIC_RESULT_PREFIX.length).split(/\r?\n/, 1)[0];
  try {
    const envelope = JSON.parse(line) as { ok?: boolean; result?: unknown };
    if (envelope.ok !== true) {
      rejectExecution(new SyntheticExecutionError("execution-failed", 422, "Synthetic scenario could not be invoked."));
      return;
    }
    resolveExecution(envelope.result);
  } catch {
    rejectExecution(new SyntheticExecutionError("invalid-result", 500, "Synthetic execution process returned malformed data."));
  }
}
