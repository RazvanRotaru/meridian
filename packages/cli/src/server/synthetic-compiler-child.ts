/** Defense-in-depth compiler child for trusted/local callers.
 *
 * Node's permission model is not a hostile-code security boundary. Untrusted PRs must use the OCI
 * backend; this child still keeps project compilation out of the long-lived web server and grants
 * the compiler source-read/output-write access only.
 */

import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphArtifact, SyntheticExecutionManifestEntry } from "@meridian/core";
import type { NodePermissionFlag } from "./synthetic-child";
import { SyntheticExecutionError } from "./synthetic-error";
import type { CompilationResult } from "./synthetic-project";
import { parseSyntheticWorkerError } from "./synthetic-worker-job";

export const SYNTHETIC_COMPILATION_RESULT_PREFIX = "__MERIDIAN_SYNTHETIC_COMPILATION__=";
const MAX_JOB_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const HEAP_MB = 128;

export async function compileInstrumentedProjectInSandbox(
  permissionFlag: NodePermissionFlag,
  sourceRoot: string,
  outputRoot: string,
  artifact: GraphArtifact,
  scenario: SyntheticExecutionManifestEntry,
): Promise<CompilationResult> {
  const workerPath = syntheticWorkerBundlePath();
  if (workerPath === null) {
    throw new SyntheticExecutionError("unsupported-runtime", 422, "Synthetic compiler worker is unavailable.");
  }
  const job = JSON.stringify({ artifact, scenario });
  if (Buffer.byteLength(job, "utf8") > MAX_JOB_BYTES) {
    throw new SyntheticExecutionError("invalid-request", 400, "Synthetic compiler job is too large.");
  }
  const jobPath = join(outputRoot, "__meridian_compile_job.json");
  writeFileSync(jobPath, job, { encoding: "utf8", mode: 0o600 });
  const stdout = await runCompilerChild(permissionFlag, sourceRoot, outputRoot, workerPath, jobPath);
  return parseCompilationResult(stdout, outputRoot);
}

export function syntheticWorkerBundlePath(): string | null {
  const directory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(directory, "synthetic-oci-worker.js"),
    join(directory, "../../dist/synthetic-oci-worker.js"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return realpathSync.native(candidate);
    } catch {
      // Try the next packaged/development location.
    }
  }
  return null;
}

function runCompilerChild(
  permissionFlag: NodePermissionFlag,
  sourceRoot: string,
  outputRoot: string,
  workerPath: string,
  jobPath: string,
): Promise<string> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [
      permissionFlag,
      `--allow-fs-read=${sourceRoot}`,
      `--allow-fs-read=${outputRoot}`,
      `--allow-fs-read=${workerPath}`,
      `--allow-fs-write=${outputRoot}`,
      `--max-old-space-size=${HEAP_MB}`,
      "--disable-proto=delete",
      workerPath,
      "compile",
      jobPath,
      sourceRoot,
      outputRoot,
    ], {
      cwd: outputRoot,
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: outputRoot, TMPDIR: outputRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: SyntheticExecutionError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      rejectChild(error);
    };
    const timer = setTimeout(() => fail(new SyntheticExecutionError(
      "compile-failed",
      422,
      "Synthetic compilation exceeded the 10 second time limit.",
    )), TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        fail(new SyntheticExecutionError("compile-failed", 422, "Synthetic compiler produced too much output."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        fail(new SyntheticExecutionError("compile-failed", 422, "Synthetic compiler produced too much diagnostic output."));
      }
    });
    child.on("error", () => fail(new SyntheticExecutionError(
      "compile-failed",
      500,
      "Synthetic compiler process could not be started.",
    )));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectChild(parseSyntheticWorkerError(stdout, "compiler")
          ?? new SyntheticExecutionError("compile-failed", 422, "Synthetic compilation failed in the isolated process."));
        return;
      }
      resolveChild(stdout);
    });
  });
}

function parseCompilationResult(stdout: string, outputRoot: string): CompilationResult {
  const marker = stdout.lastIndexOf(SYNTHETIC_COMPILATION_RESULT_PREFIX);
  if (marker < 0) {
    throw new SyntheticExecutionError("invalid-result", 500, "Synthetic compiler process returned no result.");
  }
  const line = stdout.slice(marker + SYNTHETIC_COMPILATION_RESULT_PREFIX.length).split(/\r?\n/, 1)[0];
  try {
    const envelope = JSON.parse(line) as unknown;
    if (!isRecord(envelope)
      || !hasExactKeys(envelope, ["ok", "result"])
      || envelope.ok !== true
      || !isCompilationResult(envelope.result, outputRoot)) throw new Error();
    return envelope.result;
  } catch {
    throw new SyntheticExecutionError("invalid-result", 500, "Synthetic compiler process returned malformed data.");
  }
}

function isCompilationResult(value: unknown, outputRoot: string): value is CompilationResult {
  if (!isRecord(value) || !hasExactKeys(value, ["entryModule", "nodeNames", "warnings"])) return false;
  if (typeof value.entryModule !== "string" || value.entryModule.length < 1 || value.entryModule.length > 2_048) return false;
  const entryPath = resolve(outputRoot, value.entryModule);
  if (!isWithin(outputRoot, entryPath) || !existsSync(entryPath)) return false;
  if (!isRecord(value.nodeNames) || Object.keys(value.nodeNames).length > 16_384) return false;
  if (Object.entries(value.nodeNames).some(([key, name]) => key.length > 4_096 || typeof name !== "string" || name.length > 4_096)) return false;
  return Array.isArray(value.warnings)
    && value.warnings.length <= 128
    && value.warnings.every((warning) => typeof warning === "string" && warning.length <= 4_096);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}
