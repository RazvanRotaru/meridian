/**
 * `@meridian/extractor-typescript` — the ts-morph `LanguageExtractor`.
 *
 * Produces raw graph nodes + edges in the `@meridian/core` model; the CLI wraps them in an
 * artifact header. Register `createTypeScriptExtractor()` with core's `ExtractorRegistry`.
 */

export { TypeScriptExtractor, createTypeScriptExtractor } from "./extractor";
export {
  TYPESCRIPT_REVISION_SHARD_MODES,
  extractTypeScriptRevisionWithPolicy,
  requireTypeScriptRevisionShardPolicy,
  typeScriptRevisionShardDecision,
} from "./revision-shards";
export type {
  TypeScriptRevisionShardDecision,
  TypeScriptRevisionShardMode,
  TypeScriptRevisionShardPolicy,
  TypeScriptRevisionShardRuntimeFingerprint,
} from "./revision-shards";
