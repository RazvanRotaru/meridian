/**
 * File-only boundary for mock telemetry derived from a complete graph.
 *
 * The long-lived server sends paths and a small selector to a short-lived child. The child alone
 * decodes the artifact and writes a bounded JSON response; the parent validates and streams that
 * file without ever receiving a GraphArtifact over IPC.
 */

import { fork } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isStandaloneMockWorkerResponse,
  MAX_STANDALONE_MOCK_RESPONSE_BYTES,
  type StandaloneMockTelemetryKind,
  type StandaloneMockWorkerRequest,
  type StandaloneMockWorkerResponse,
} from "./standalone-view-mock-worker-protocol.js";
import { WebError } from "./web-error";

export {
  isStandaloneMockWorkerRequest,
  MAX_STANDALONE_MOCK_RESPONSE_BYTES,
  type StandaloneMockTelemetryKind,
  type StandaloneMockWorkerRequest,
  type StandaloneMockWorkerResponse,
} from "./standalone-view-mock-worker-protocol.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunStandaloneMockTelemetryRequest {
  artifactPath: string;
  scratchRoot: string;
  kind: StandaloneMockTelemetryKind;
  environment: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test/dev override. Production resolves the separately bundled child entry. */
  workerEntry?: string | URL;
}

export interface StandaloneMockTelemetryFile {
  path: string;
  bytes: number;
  cleanup(): void;
}

export type StandaloneMockTelemetryRunner = (
  request: RunStandaloneMockTelemetryRequest,
) => Promise<StandaloneMockTelemetryFile>;

export async function runStandaloneMockTelemetry(
  request: RunStandaloneMockTelemetryRequest,
): Promise<StandaloneMockTelemetryFile> {
  if (request.signal?.aborted) throw abortReason(request.signal);
  mkdirSync(request.scratchRoot, { recursive: true, mode: 0o700 });
  const jobRoot = mkdtempSync(join(request.scratchRoot, "mock-telemetry-"));
  const outputPath = join(jobRoot, "response.json");
  try {
    const result = await runWorker({
      type: "render",
      kind: request.kind,
      artifactPath: request.artifactPath,
      outputPath,
      environment: request.environment,
    }, request);
    if (result.outputPath !== outputPath
      || !Number.isSafeInteger(result.bytes)
      || result.bytes < 1
      || result.bytes > MAX_STANDALONE_MOCK_RESPONSE_BYTES) {
      throw new WebError(500, "mock telemetry worker returned invalid output metadata");
    }
    const entry = lstatSync(outputPath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== result.bytes) {
      throw new WebError(500, "mock telemetry worker output failed verification");
    }
    let cleaned = false;
    return {
      path: outputPath,
      bytes: result.bytes,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        rmSync(jobRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(jobRoot, { recursive: true, force: true });
    throw error;
  }
}

export function streamStandaloneMockTelemetry(
  response: ServerResponse,
  file: StandaloneMockTelemetryFile,
): Promise<void> {
  return new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(file.path);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      response.off("finish", onFinish);
      response.off("close", onClose);
      file.cleanup();
      error ? rejectStream(error) : resolveStream();
    };
    const onFinish = () => finish();
    const onClose = () => finish();
    response.once("finish", onFinish);
    response.once("close", onClose);
    stream.once("error", (error) => finish(error));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": file.bytes,
    });
    stream.pipe(response);
  });
}

function runWorker(
  payload: StandaloneMockWorkerRequest,
  options: Pick<RunStandaloneMockTelemetryRequest, "signal" | "timeoutMs" | "workerEntry">,
): Promise<Extract<StandaloneMockWorkerResponse, { type: "result" }>> {
  return new Promise((resolveWorker, rejectWorker) => {
    const workerEntry = options.workerEntry ?? defaultWorkerEntry();
    const child = fork(workerEntry, {
      execArgv: isTypeScriptEntry(workerEntry) && !supportsNativeTypeStripping()
        ? sourceWorkerExecArgv()
        : [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let response: StandaloneMockWorkerResponse | undefined;
    let terminal: unknown;
    let settled = false;
    const timeout = setTimeout(() => {
      terminal = new WebError(504, "mock telemetry generation timed out");
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref?.();
    const abort = () => {
      terminal = abortReason(options.signal);
      child.kill("SIGKILL");
    };
    const finish = (error?: unknown, result?: Extract<StandaloneMockWorkerResponse, { type: "result" }>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      error === undefined ? resolveWorker(result as Extract<StandaloneMockWorkerResponse, { type: "result" }>) : rejectWorker(error);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => {
      terminal ??= new WebError(500, "could not start mock telemetry worker");
    });
    child.on("message", (value: unknown) => {
      if (!isStandaloneMockWorkerResponse(value) || response !== undefined) {
        terminal ??= new WebError(500, "mock telemetry worker violated its protocol");
        child.kill("SIGKILL");
        return;
      }
      response = value;
    });
    child.once("close", (code) => {
      if (terminal !== undefined) {
        finish(terminal);
        return;
      }
      if (code !== 0 || response === undefined) {
        finish(new WebError(500, "mock telemetry worker failed"));
        return;
      }
      if (response.type === "error") {
        finish(new WebError(
          response.reason === "too-large" ? 413 : 500,
          response.reason === "too-large"
            ? "mock telemetry response exceeded the 16 MiB limit"
            : "mock telemetry worker rejected the artifact",
        ));
        return;
      }
      finish(undefined, response);
    });
    child.send(payload, (error) => {
      if (!error) return;
      terminal ??= new WebError(500, "could not send work to mock telemetry worker");
      child.kill("SIGKILL");
    });
    if (options.signal?.aborted) abort();
  });
}

function defaultWorkerEntry(): URL {
  if (import.meta.url.endsWith(".ts")) return new URL("./standalone-view-mock-worker-child.ts", import.meta.url);
  const candidates = [
    new URL("./standalone-view-mock-worker-child.js", import.meta.url),
    new URL("./server/standalone-view-mock-worker-child.js", import.meta.url),
  ];
  return candidates.find((candidate) => existsSync(fileURLToPath(candidate))) ?? candidates[0];
}

function sourceWorkerExecArgv(): string[] {
  const require = createRequire(import.meta.url);
  return ["--import", pathToFileURL(require.resolve("tsx")).href];
}

function isTypeScriptEntry(entry: string | URL): boolean {
  return (entry instanceof URL ? entry.pathname : entry).endsWith(".ts");
}

function supportsNativeTypeStripping(): boolean {
  return "typescript" in process.features && process.features.typescript === "strip";
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
