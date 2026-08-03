/** Lightweight product-analysis contract shared by the web parent and disposable worker. */

import type { ExtractionProgress, GraphArtifact } from "@meridian/core";
import type { TypeScriptRevisionShardPolicy } from "@meridian/extractor-typescript";
import type { GitDiffExecutor } from "./git-diff";

/**
 * Bump when the fixed product profile or its interpretation changes, invalidating graph caches.
 * Version 9 adds formatting-only syntax proofs. Version 10 distinguishes
 * executable-comment-only edits from physically comment-only source rows. Version 11 resolves
 * calls through any-typed storage when an adjacent construction of the same receiver proves one
 * directly invoked member.
 */
export const REPOSITORY_ANALYSIS_VERSION = 11;

export const REPOSITORY_ANALYSIS_POLICY = Object.freeze({
  scope: "workspace",
  depth: "function",
  includeExternal: true,
  includeUnresolved: false,
  excludeTests: false,
  valueRefs: true,
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
  /** Non-semantic extractor observations; never serialized or included in cache identity. */
  onExtractionProgress?: (progress: ExtractionProgress) => void;
  /**
   * Internal worker capability selected by the server. Public HTTP requests never populate it;
   * the private worker protocol transfers and strictly validates it out-of-band.
   */
  typeScriptRevisionShards?: TypeScriptRevisionShardPolicy;
}
