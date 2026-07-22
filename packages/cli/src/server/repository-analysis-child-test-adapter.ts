/**
 * Test-only in-process adapter for the disposable repository-analysis boundary.
 *
 * Production web code must use `repository-analysis-child.ts`. Focused cache and handler tests
 * inject this adapter so their existing `analyzeRepository` mocks keep exercising the exact
 * compact-facts and on-disk artifact contract without forking a source worker.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { validateArtifact, type GraphArtifact } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { analyzeRepository, type RepositoryAnalysisRequest } from "../repository-analysis";
import { runGit } from "./git-exec";
import { writeValidatedRepositoryArtifact } from "./repository-analysis-artifact-writer";
import type {
  RepositoryAnalysisChildOptions,
  RepositoryAnalysisChildResult,
  RepositoryArtifactRestampRequest,
  SerializableRepositoryAnalysisRequest,
} from "./repository-analysis-child";
import {
  boundedRepositoryWorkerWarnings,
  changedMetadataForWorker,
  emptySideHintsForWorker,
  syntheticSourceFilesForWorker,
} from "./repository-analysis-worker-job";
import { verifiedArtifactFile } from "./web-graph-store";
import { WebError } from "./web-error";

export async function runRepositoryAnalysisChildInProcess(
  input: SerializableRepositoryAnalysisRequest,
  options: RepositoryAnalysisChildOptions,
): Promise<RepositoryAnalysisChildResult> {
  throwIfTestAborted(options.signal);
  const request = analysisRequest(input, options.token);
  const { artifact, extractors, warnings } = await analyzeRepository(request);
  throwIfTestAborted(options.signal);
  const changed = changedMetadataForWorker(artifact, request.changedSince);
  // Older focused tests mocked the pre-worker return shape and omitted `extractors`. Production
  // can never take this branch; infer extension-only selectors so those tests still exercise the
  // populated-side hint handoff instead of weakening the child contract.
  const selectedExtractors = extractors ?? testExtractorSelectors(artifact, changed.changedFiles);
  const emptySideHints = emptySideHintsForWorker(artifact, changed.changedFiles, selectedExtractors);
  const sourceFiles = syntheticSourceFilesForWorker(artifact);
  const written = writeValidatedRepositoryArtifact(options.artifactOutputPath, artifact);
  const branchVariant = options.branchVariant === undefined
    ? null
    : writeBranchVariant(artifact, options.branchVariant);
  return {
    material: verifiedArtifactFile(options.artifactOutputPath, written.byteDigest, written.summary),
    byteLength: written.byteLength,
    branchVariant,
    summary: written.summary,
    target: artifact.target,
    changedFiles: changed.changedFiles,
    emptySideHints,
    sourceFiles,
    changedSinceBaseRef: changed.changedSinceBaseRef,
    warnings: boundedRepositoryWorkerWarnings(warnings, options.token),
  };
}

function testExtractorSelectors(
  artifact: GraphArtifact,
  changedFiles: readonly { path: string; previousPath?: string }[],
): Array<{ extensions: string[] }> {
  const extensions = new Set([
    ...artifact.nodes.map((node) => extname(node.location.file).toLowerCase()),
    ...changedFiles.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])])
      .map((path) => extname(path).toLowerCase()),
  ].filter((extension) => extension.length > 0));
  return [
    [".ts", ".tsx"],
    [".py"],
  ].filter((group) => group.some((extension) => extensions.has(extension)))
    .map((group) => ({ extensions: group }));
}

export async function runRepositoryArtifactRestampChildInProcess(
  request: RepositoryArtifactRestampRequest,
  options: RepositoryAnalysisChildOptions,
): Promise<RepositoryAnalysisChildResult> {
  throwIfTestAborted(options.signal);
  const input = lstatSync(request.inputArtifactPath);
  if (!input.isFile()) throw new CliError(EXIT.validation, "restamp input is not a regular artifact file");
  const bytes = readFileSync(request.inputArtifactPath);
  if (createHash("sha256").update(bytes).digest("hex") !== request.expectedInputDigest) {
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
  const artifact = withBranch(validation.artifact, request.branch);
  const changed = changedMetadataForWorker(artifact);
  const sourceFiles = syntheticSourceFilesForWorker(artifact);
  const written = writeValidatedRepositoryArtifact(options.artifactOutputPath, artifact);
  throwIfTestAborted(options.signal);
  return {
    material: verifiedArtifactFile(options.artifactOutputPath, written.byteDigest, written.summary),
    byteLength: written.byteLength,
    branchVariant: null,
    summary: written.summary,
    target: artifact.target,
    changedFiles: changed.changedFiles,
    emptySideHints: [],
    sourceFiles,
    changedSinceBaseRef: changed.changedSinceBaseRef,
    warnings: boundedRepositoryWorkerWarnings(validation.warnings.map((warning) => warning.message)),
  };
}

function analysisRequest(
  input: SerializableRepositoryAnalysisRequest,
  token: string | undefined,
): RepositoryAnalysisRequest {
  const request: RepositoryAnalysisRequest = {
    absoluteRoot: input.absoluteRoot,
    cwd: input.cwd,
    hintedFiles: input.hintedFiles ?? [],
    allowEmpty: input.allowEmpty ?? false,
    ...(input.targetName === undefined ? {} : { targetName: input.targetName }),
    ...(input.vcs === undefined ? {} : { vcs: input.vcs }),
    ...(input.changedSince === undefined ? {} : { changedSince: input.changedSince }),
    ...(input.changedSinceTimeoutMs === undefined ? {} : {
      changedSinceTimeoutMs: input.changedSinceTimeoutMs,
    }),
  };
  if (token && input.changedSince) {
    request.changedSinceGitExecutor = async (absoluteRoot, args, timeoutMs) => {
      try {
        return await runGit(args, { cwd: absoluteRoot, token, timeoutMs });
      } catch (error) {
        if (error instanceof WebError) throw new CliError(EXIT.io, error.message);
        throw error;
      }
    };
  }
  return request;
}

function writeBranchVariant(
  artifact: GraphArtifact,
  request: NonNullable<RepositoryAnalysisChildOptions["branchVariant"]>,
) {
  const variant = withBranch(artifact, request.branch);
  const written = writeValidatedRepositoryArtifact(request.artifactOutputPath, variant);
  return {
    material: verifiedArtifactFile(request.artifactOutputPath, written.byteDigest, written.summary),
    byteLength: written.byteLength,
    summary: written.summary,
    target: variant.target,
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

function throwIfTestAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}
