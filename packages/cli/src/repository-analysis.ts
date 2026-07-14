/**
 * The one product analysis profile used by every generated repository graph.
 *
 * `extractToArtifact` remains a lower-level testing/internal primitive. Product callers come
 * through this service so scope and graph semantics cannot drift between headless export, a local
 * folder, a cached remote checkout, and a pull-request checkout. Workspace discovery is expressed
 * by deliberately passing neither `project` nor `include` to the extractor.
 */

import type { GraphArtifact } from "@meridian/core";
import { extractToArtifact } from "./extract-pipeline";
import type { PipelineResult } from "./extract-pipeline";
import type { GitDiffExecutor } from "./git-diff";

/** Bump when the fixed product profile or its interpretation changes, invalidating graph caches. */
export const REPOSITORY_ANALYSIS_VERSION = 4;

export const REPOSITORY_ANALYSIS_POLICY = Object.freeze({
  scope: "workspace",
  depth: "function",
  includeExternal: true,
  includeUnresolved: false,
  excludeTests: false,
  valueRefs: false,
  materializeBoundary: true,
} as const);

export interface RepositoryAnalysisRequest {
  absoluteRoot: string;
  cwd: string;
  /** Display name for the artifact; remote callers use the repository label, not a checkout dir. */
  targetName?: string;
  /** Source revision supplied by a caller that resolved the Git checkout. */
  vcs?: GraphArtifact["target"]["vcs"];
  /** Optional review context; it changes annotations, not the fixed extraction profile. */
  changedSince?: string;
  changedSinceTimeoutMs?: number;
  changedSinceGitExecutor?: GitDiffExecutor;
  /** Internal extractor-selection hints for an intentionally empty immutable PR side. */
  hintedFiles?: readonly string[];
  /** Allow a deliberately empty immutable PR side to produce a valid zero-node artifact. */
  allowEmpty?: boolean;
}

/** Analyze a repository with the fixed product profile and workspace auto-discovery. */
export function analyzeRepository(request: RepositoryAnalysisRequest): Promise<PipelineResult> {
  return extractToArtifact({
    absoluteRoot: request.absoluteRoot,
    cwd: request.cwd,
    depth: REPOSITORY_ANALYSIS_POLICY.depth,
    includeExternal: REPOSITORY_ANALYSIS_POLICY.includeExternal,
    includeUnresolved: REPOSITORY_ANALYSIS_POLICY.includeUnresolved,
    materializeBoundary: REPOSITORY_ANALYSIS_POLICY.materializeBoundary,
    excludeTests: REPOSITORY_ANALYSIS_POLICY.excludeTests,
    valueRefs: REPOSITORY_ANALYSIS_POLICY.valueRefs,
    changedSince: request.changedSince,
    changedSinceTimeoutMs: request.changedSinceTimeoutMs,
    changedSinceGitExecutor: request.changedSinceGitExecutor,
    hintedFiles: request.hintedFiles,
    allowEmpty: request.allowEmpty,
    targetName: request.targetName,
    vcs: request.vcs,
  });
}
