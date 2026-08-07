/** Lightweight product-analysis contract shared by the web parent and disposable worker. */

import type { ChangedFileManifestEntry, ExtractionProgress, GraphArtifact } from "@meridian/core";
import type { TypeScriptRevisionShardPolicy } from "@meridian/extractor-typescript";
import type { GitDiffExecutor } from "./git-diff";

/**
 * Bump when the fixed product profile or its interpretation changes, invalidating graph caches.
 * Version 9 adds formatting-only syntax proofs. Version 10 distinguishes
 * executable-comment-only edits from physically comment-only source rows. Version 11 resolves
 * calls through any-typed storage when an adjacent construction of the same receiver proves one
 * directly invoked member. Version 12 persists the exact bounded initial-graph seed set used for
 * durable partial projection replay. Version 13 preserves the detected mixed-language target
 * identity across independently extracted slices. Version 14 emits TypeScript type aliases as
 * graph declarations so type-reference edges and symbol search resolve them consistently. Version
 * 15 includes meaningful module-scope inline callbacks passed to value-producing calls. Version
 * 16 materializes object-literal declarations through transparent TypeScript expression wrappers.
 */
export const REPOSITORY_ANALYSIS_VERSION = 16;

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
  /**
   * Internal cold-PR fast path. The disposable worker first discovers the complete weak
   * TypeScript file neighbourhood for these roots, then runs the ordinary extractor against that
   * bounded file set. Omitting `seedFiles` uses the verified HEAD changed-file manifest. This is
   * never accepted from HTTP and never replaces the canonical repository analysis contract.
   */
  initialGraph?: {
    depth: number;
    seedFiles?: readonly string[];
    /**
     * Server-proven selection from the exact-revision source topology. These three fields are an
     * all-or-nothing capability: ordinary provisional extraction omits them and performs its own
     * scan, while later expansion supplies sorted paths and bypasses that repository-wide scan.
     */
    selectedFiles?: readonly string[];
    /** Hidden exact-ID allocator stabilizers; must contain every selected file. */
    extractionFiles?: readonly string[];
    frontierFiles?: readonly string[];
    /** Stable logical identity shared by independently extracted slices of one exact revision. */
    lineage?: {
      graphId: string;
      generation: string;
    };
  };
  /** Non-semantic extractor observations; never serialized or included in cache identity. */
  onExtractionProgress?: (progress: ExtractionProgress) => void;
  /**
   * One observation of the exact, fully verified changed-file manifest. The pipeline emits it after
   * the diff transaction is complete and before language extraction starts. A consumer cannot
   * mutate graph semantics through this hook.
   */
  onChangedManifest?: (manifest: readonly ChangedFileManifestEntry[]) => void;
  /**
   * Internal worker capability selected by the server. Public HTTP requests never populate it;
   * the private worker protocol transfers and strictly validates it out-of-band.
   */
  typeScriptRevisionShards?: TypeScriptRevisionShardPolicy;
}
