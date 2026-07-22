/** One-shot child entry for CPU- and heap-heavy repository artifact work. */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { validateArtifact, type GraphArtifact } from "@meridian/core";
import { CliError, EXIT } from "./errors";
import { analyzeRepository, type RepositoryAnalysisRequest } from "./repository-analysis";
import { runGit } from "./server/git-exec";
import { writeValidatedRepositoryArtifact } from "./server/repository-analysis-artifact-writer";
import {
  boundedRepositoryWorkerWarnings,
  changedMetadataForWorker,
  emptySideHintsForWorker,
  isRepositoryAnalysisWorkerRequest,
  repositoryAnalysisWorkerFailure,
  syntheticSourceFilesForWorker,
  type RepositoryAnalysisWorkerFileResult,
  type RepositoryAnalysisWorkerRequest,
  type RepositoryAnalysisWorkerResponse,
} from "./server/repository-analysis-worker-job";
import { WebError } from "./server/web-error";
import { withReviewFingerprints } from "./server/review-fingerprints";

let finished = false;

if (typeof process.send !== "function") {
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
  if (!isRepositoryAnalysisWorkerRequest(value)) {
    reply({ type: "error", error: { kind: "internal" } });
    return;
  }
  try {
    const result = value.type === "analyze"
      ? await analyzeToFile(value)
      : restampToFile(value);
    reply({ type: "result", result });
  } catch (error) {
    rmSync(value.artifactOutputPath, { force: true });
    if (value.type === "analyze" && value.branchVariant !== null) {
      rmSync(value.branchVariant.artifactOutputPath, { force: true });
    }
    reply({ type: "error", error: repositoryAnalysisWorkerFailure(
      error,
      value.type === "analyze" ? value.token : undefined,
    ) });
  }
}

async function analyzeToFile(
  message: Extract<RepositoryAnalysisWorkerRequest, { type: "analyze" }>,
): Promise<RepositoryAnalysisWorkerFileResult> {
  const request = analysisRequest(message);
  const analyzed = await analyzeRepository(request);
  const artifact = message.reviewFingerprints !== null
    ? withReviewFingerprints(analyzed.artifact, request.absoluteRoot, message.reviewFingerprints)
    : analyzed.artifact;
  const { extractors, warnings } = analyzed;
  const changed = changedMetadataForWorker(artifact, request.changedSince);
  const emptySideHints = emptySideHintsForWorker(artifact, changed.changedFiles, extractors);
  const sourceFiles = syntheticSourceFilesForWorker(artifact);
  const written = writeValidatedRepositoryArtifact(message.artifactOutputPath, artifact);
  const branchVariant = message.branchVariant === null
    ? null
    : branchVariantFor(message.branchVariant, artifact);
  return {
    kind: "file",
    operation: "analyze",
    id: message.id,
    artifactPath: message.artifactOutputPath,
    artifactBytes: written.byteLength,
    artifactSha256: written.byteDigest,
    branchVariant,
    graphSummary: written.summary,
    target: artifact.target,
    changedFiles: changed.changedFiles,
    emptySideHints,
    sourceFiles,
    changedSinceBaseRef: changed.changedSinceBaseRef,
    warnings: boundedRepositoryWorkerWarnings(warnings, message.token),
  };
}

function analysisRequest(
  message: Extract<RepositoryAnalysisWorkerRequest, { type: "analyze" }>,
): RepositoryAnalysisRequest {
  const input = message.request;
  const request: RepositoryAnalysisRequest = {
    absoluteRoot: input.absoluteRoot,
    cwd: input.cwd,
    hintedFiles: input.hintedFiles,
    allowEmpty: input.allowEmpty,
    ...(input.targetName === null ? {} : { targetName: input.targetName }),
    ...(input.vcs === null ? {} : { vcs: input.vcs }),
    ...(input.changedSince === null ? {} : { changedSince: input.changedSince }),
    ...(input.changedSinceTimeoutMs === null ? {} : {
      changedSinceTimeoutMs: input.changedSinceTimeoutMs,
    }),
  };
  if (message.token && input.changedSince) {
    request.changedSinceGitExecutor = async (absoluteRoot, args, timeoutMs) => {
      try {
        return await runGit(args, {
          cwd: absoluteRoot,
          token: message.token,
          timeoutMs,
        });
      } catch (error) {
        if (error instanceof WebError) throw new CliError(EXIT.io, error.message);
        throw error;
      }
    };
  }
  return request;
}

function restampToFile(
  message: Extract<RepositoryAnalysisWorkerRequest, { type: "restamp" }>,
): RepositoryAnalysisWorkerFileResult {
  const input = lstatSync(message.inputArtifactPath);
  if (!input.isFile()) throw new CliError(EXIT.validation, "restamp input is not a regular artifact file");
  const bytes = readFileSync(message.inputArtifactPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== message.expectedInputDigest) {
    throw new CliError(EXIT.validation, "restamp input artifact digest does not match");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CliError(EXIT.validation, "restamp input is not a valid graph artifact");
  }
  const validation = validateArtifact(candidate);
  if (!validation.ok || validation.artifact === undefined) {
    throw new CliError(EXIT.validation, "restamp input is not a valid graph artifact");
  }
  const artifact = withBranch(validation.artifact, message.branch);
  const changed = changedMetadataForWorker(artifact);
  const sourceFiles = syntheticSourceFilesForWorker(artifact);
  const written = writeValidatedRepositoryArtifact(message.artifactOutputPath, artifact);
  return {
    kind: "file",
    operation: "restamp",
    id: message.id,
    artifactPath: message.artifactOutputPath,
    artifactBytes: written.byteLength,
    artifactSha256: written.byteDigest,
    branchVariant: null,
    graphSummary: written.summary,
    target: artifact.target,
    changedFiles: changed.changedFiles,
    emptySideHints: [],
    sourceFiles,
    changedSinceBaseRef: changed.changedSinceBaseRef,
    warnings: boundedRepositoryWorkerWarnings(validation.warnings.map((warning) => warning.message)),
  };
}

function branchVariantFor(
  request: NonNullable<Extract<RepositoryAnalysisWorkerRequest, { type: "analyze" }>["branchVariant"]>,
  artifact: GraphArtifact,
): NonNullable<RepositoryAnalysisWorkerFileResult["branchVariant"]> {
  const branchArtifact = withBranch(artifact, request.branch);
  const written = writeValidatedRepositoryArtifact(request.artifactOutputPath, branchArtifact);
  return {
    artifactPath: request.artifactOutputPath,
    artifactBytes: written.byteLength,
    artifactSha256: written.byteDigest,
    graphSummary: written.summary,
    target: branchArtifact.target,
  };
}

function withBranch(artifact: GraphArtifact, branch: string | null): GraphArtifact {
  const vcs = artifact.target.vcs;
  if (!vcs) {
    if (branch !== null) throw new CliError(EXIT.validation, "cannot add branch provenance without VCS coordinates");
    return artifact;
  }
  if (branch === null) {
    if (vcs.branch === undefined) return artifact;
    const { branch: _branch, ...withoutBranch } = vcs;
    return { ...artifact, target: { ...artifact.target, vcs: withoutBranch } };
  }
  if (vcs.branch === branch) return artifact;
  return { ...artifact, target: { ...artifact.target, vcs: { ...vcs, branch } } };
}

function reply(message: RepositoryAnalysisWorkerResponse): void {
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
