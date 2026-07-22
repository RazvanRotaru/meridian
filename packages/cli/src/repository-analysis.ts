/**
 * The one product analysis profile used by every generated repository graph.
 *
 * `extractToArtifact` remains a lower-level testing/internal primitive. Product callers come
 * through this service so scope and graph semantics cannot drift between headless export, a local
 * folder, a cached remote checkout, and a pull-request checkout. Workspace discovery is expressed
 * by deliberately passing neither `project` nor `include` to the extractor.
 */

import { extractToArtifact } from "./extract-pipeline";
import type { PipelineResult } from "./extract-pipeline";
import {
  REPOSITORY_ANALYSIS_POLICY,
  type RepositoryAnalysisRequest,
} from "./repository-analysis-contract";

export {
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "./repository-analysis-contract";
export type { RepositoryAnalysisRequest } from "./repository-analysis-contract";

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
