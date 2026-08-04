/**
 * `@meridian/extractor-typescript` — the ts-morph `LanguageExtractor`.
 *
 * Produces raw graph nodes + edges in the `@meridian/core` model; the CLI wraps them in an
 * artifact header. Register `createTypeScriptExtractor()` with core's `ExtractorRegistry`.
 */

export { TypeScriptExtractor, createTypeScriptExtractor } from "./extractor";
export {
  MAX_INITIAL_PROJECTION_SELECTED_FILES,
  selectInitialTypeScriptProjectionFiles,
} from "./initial-projection-files";
export type {
  InitialTypeScriptProjectionFiles,
  InitialTypeScriptProjectionOptions,
} from "./initial-projection-files";
export { indexTypeScriptWorkspaceSources } from "./source-index";
export type {
  TypeScriptSourceIndex,
  TypeScriptSourceIndexLimits,
  TypeScriptSourceIndexOptions,
  TypeScriptSourceTopologyFile,
} from "./source-index";
export {
  TYPESCRIPT_REVISION_SHARD_MODES,
  extractTypeScriptRevisionWithPolicy,
  isTypeScriptRevisionShardPolicy,
  requireTypeScriptRevisionShardPolicy,
  typeScriptRevisionShardDecision,
} from "./revision-shards";
export type {
  RevisionShardAdmissionCapability,
  RevisionShardAdmissionSigner,
  RevisionShardAdmissionVerifier,
} from "./incremental-poc/admission";
export { isRevisionShardAdmissionCapability } from "./incremental-poc/admission";
export type {
  TypeScriptRevisionShardDecision,
  TypeScriptRevisionShardMode,
  TypeScriptRevisionShardPolicy,
  TypeScriptRevisionShardRuntimeFingerprint,
} from "./revision-shards";
