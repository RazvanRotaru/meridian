/**
 * Standalone child-process entry for CPU-heavy graph extraction.
 *
 * It accepts exactly one request over Node's private IPC channel and emits exactly one response.
 * There is intentionally no stdout/stderr logging here: an extractor failure can contain local
 * paths or credentials, and only the explicitly safe `CliError` carrier crosses the boundary.
 */

import { extractToArtifact } from "../extract-pipeline";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import type { PipelineRequest } from "../extract-pipeline";
import { CliError, EXIT } from "../errors";
import { runGit } from "./git-exec";
import { graphSummaryFor } from "./inspection-snapshot-store";
import {
  GRAPH_PROJECTION_DIRECTORY,
  writeGraphProjectionBundle,
} from "./graph-projection-bundle";
import { writeSyntheticCapabilitySidecar } from "./synthetic-capability-sidecar";
import { WebError } from "./web-error";
import {
  extractionWorkerFailure,
  boundedWorkerWarnings,
  changedSinceWorkerMetadata,
  isExtractionWorkerRequest,
  representativeHintedFiles,
  type ExtractionWorkerRequestMessage,
  type ExtractionWorkerResponseMessage,
} from "./extraction-worker-protocol";

let finished = false;

if (typeof process.send !== "function") {
  // This file is a fork-only executable. Stay silent if it is invoked directly.
  process.exitCode = 1;
} else {
  process.once("message", (value: unknown) => {
    void handleRequest(value);
  });
  process.once("disconnect", () => {
    if (!finished) process.exit(1);
  });
}

async function handleRequest(value: unknown): Promise<void> {
  if (!isExtractionWorkerRequest(value)) {
    reply({ type: "error", error: { kind: "internal" } });
    return;
  }

  try {
    const pipelineRequest = requestWithCredentialAwareGit(value);
    const { artifact, warnings } = await extractToArtifact(pipelineRequest);
    const serialized = JSON.stringify(artifact);
    await writeFile(value.artifactOutputPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const projectionDirectory = join(dirname(value.artifactOutputPath), GRAPH_PROJECTION_DIRECTORY);
    writeGraphProjectionBundle(projectionDirectory, artifact);
    const syntheticCapability = writeSyntheticCapabilitySidecar(
      value.artifactOutputPath,
      value.request.absoluteRoot,
      artifact,
    );
    reply({
      type: "result",
      result: resultFor(
        value.artifactOutputPath,
        projectionDirectory,
        artifact,
        boundedWorkerWarnings([
          ...warnings,
          ...(syntheticCapability.warning ? [syntheticCapability.warning] : []),
        ], value.token),
        serialized,
        value.request,
      ),
    });
  } catch (error) {
    reply({ type: "error", error: extractionWorkerFailure(error, value.token) });
  }
}

function resultFor(
  artifactPath: string,
  projectionDirectory: string,
  artifact: GraphArtifact,
  warnings: string[],
  serialized: string,
  request: ExtractionWorkerRequestMessage["request"],
): Extract<ExtractionWorkerResponseMessage, { type: "result" }>["result"] {
  const changedSince = changedSinceWorkerMetadata(artifact, request);
  const hintedFiles = representativeHintedFiles(artifact, changedSince.changedFiles);
  return {
    kind: "file",
    artifactPath,
    artifactBytes: Buffer.byteLength(serialized),
    artifactSha256: createHash("sha256").update(serialized).digest("hex"),
    projectionDirectory,
    graphSummary: graphSummaryFor(artifact),
    changedFiles: changedSince.changedFiles,
    hintedFiles,
    ...(changedSince.changedSinceBaseRef
      ? { changedSinceBaseRef: changedSince.changedSinceBaseRef }
      : {}),
    ...(typeof artifact.target.vcs?.commit === "string"
      ? { vcsCommit: artifact.target.vcs.commit }
      : {}),
    warnings,
  };
}

function requestWithCredentialAwareGit(message: ExtractionWorkerRequestMessage): PipelineRequest {
  if (!message.token || !message.request.changedSince) return message.request;
  return {
    ...message.request,
    changedSinceGitExecutor: async (absoluteRoot, args, timeoutMs) => {
      try {
        return await runGit(args, {
          cwd: absoluteRoot,
          token: message.token,
          timeoutMs,
          // The parent worker owns the detached process group and kills all inherited helpers
          // before it releases the scheduler slot.
          isolateProcessGroup: false,
        });
      } catch (error) {
        // `runGit` scrubs credentials and WebError is explicitly browser-safe. Re-wrap it in the
        // CLI error vocabulary so the parent can preserve a useful, known-safe failure.
        if (error instanceof WebError) throw new CliError(EXIT.io, error.message);
        throw error;
      }
    },
  };
}

function reply(message: ExtractionWorkerResponseMessage): void {
  if (finished || typeof process.send !== "function" || !process.connected) {
    process.exitCode = 1;
    return;
  }
  process.send(message, (error) => {
    finished = true;
    process.exitCode = error ? 1 : 0;
    if (process.connected) process.disconnect?.();
  });
}
