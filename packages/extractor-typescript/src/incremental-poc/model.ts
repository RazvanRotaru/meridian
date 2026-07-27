import type {
  ExtractOptions,
  ExtractionProgress,
  ExtractionResult,
} from "@meridian/core";
import type { WorkspaceUnit } from "../workspace-units";
import type { TypeScriptConfigInputFingerprint } from "./config-inputs";

export const POC_SHARD_VERSION = 6 as const;
export const POC_MANIFEST_VERSION = 1 as const;

export interface GitBlobIdentity {
  path: string;
  oid: string;
  mode: string;
  byteSize: number;
}

export interface GitSymlinkInputFingerprint {
  path: string;
  linkBlobOid: string;
  linkByteSize: number;
  target: string;
  resolvedPath: string;
  resolvedBlobOid: string;
  resolvedMode: "100644" | "100755";
  resolvedByteSize: number;
}

export interface ProgramInputFingerprint {
  address: string;
  digest: string;
  kind: "unit-source" | "workspace-source" | "dependency";
  impliedNodeFormat: number | null;
  isDefaultLibrary: boolean;
  isExternalLibrary: boolean;
  trackedBlobOid: string | null;
}

export interface FilesystemInputFingerprint {
  address: string;
  digest: string | null;
  kind: "package-manifest";
  trackedBlobOid: string | null;
}

export interface ResolutionTargetFingerprint {
  address: string;
  extension: string | null;
  isExternalLibraryImport: boolean;
  packageId: {
    name: string;
    subModuleName: string;
    version: string;
  } | null;
  resolvedUsingTsExtension: boolean;
  trackedBlobOid: string | null;
}

export interface ResolutionLookupInputFingerprint {
  address: string;
  purpose: "failed-lookup" | "affecting";
  state: "absent" | "file" | "directory" | "symlink" | "other";
  digest: string | null;
  trackedBlobOid: string | null;
}

export interface ModuleResolutionFingerprint {
  containingFile: string;
  mode: number | null;
  specifier: string;
  target: ResolutionTargetFingerprint | null;
  hasCompleteLookupProof: boolean;
  alternateResult: string | null;
}

export interface TypeReferenceResolutionFingerprint {
  containingFile: string;
  mode: number | null;
  specifier: string;
  target: ResolutionTargetFingerprint | null;
  hasCompleteLookupProof: boolean;
  alternateResult: string | null;
}

export interface ReuseEligibilityFingerprint {
  eligible: boolean;
  reasons: string[];
}

export interface ExtractorProvenance {
  extractorVersion: string;
  analysisPolicyVersion: string;
  schemaVersion: string;
  shardSchemaVersion: typeof POC_SHARD_VERSION;
  tsMorphVersion: string;
  typescriptVersion: string;
}

export interface AnalysisPolicyFingerprint {
  depth: NonNullable<ExtractOptions["depth"]>;
  exclude: string[];
  includeExternal: boolean;
  includeUnresolved: boolean;
  emitImportEdges: boolean;
  valueRefs: boolean;
}

export interface WorkspaceUnitFingerprint {
  dir: string;
  name: string | null;
  entryFile: string | null;
  sourceDir: string;
  include: string[];
  exclude: string[];
}

export interface StructuralMemberBoundaryFingerprint {
  path: string;
  isMember: boolean;
}

export interface UnitInputFingerprint {
  version: typeof POC_SHARD_VERSION;
  unit: WorkspaceUnitFingerprint;
  sourceBlobs: GitBlobIdentity[];
  typescriptConfig: TypeScriptConfigInputFingerprint;
  programInputs: ProgramInputFingerprint[];
  filesystemInputs: FilesystemInputFingerprint[];
  moduleResolutions: ModuleResolutionFingerprint[];
  typeReferenceResolutions: TypeReferenceResolutionFingerprint[];
  resolutionLookupInputs: ResolutionLookupInputFingerprint[];
  structuralMemberBoundaries: StructuralMemberBoundaryFingerprint[] | null;
  reuseEligibility: ReuseEligibilityFingerprint;
  compilerOptionsDigest: string;
  policy: AnalysisPolicyFingerprint;
  provenance: ExtractorProvenance;
}

export interface RevisionUnitManifest {
  unitId: string;
  shardKey: string;
  sourceBlobs: GitBlobIdentity[];
  reuseEligibility: ReuseEligibilityFingerprint;
}

export interface RevisionManifest {
  version: typeof POC_MANIFEST_VERSION;
  treeOid: string;
  workspaceDigest: string;
  policy: AnalysisPolicyFingerprint;
  provenance: ExtractorProvenance;
  units: RevisionUnitManifest[];
  normalizedResultDigest: string;
}

export interface RevisionExtractionRequest {
  root: string;
  treeOid: string;
  cacheDir: string;
  extractorVersion: string;
  analysisPolicyVersion: string;
  /**
   * Exact-tree files that may extend a manifest-derived workspace scope. This is the same
   * presentation-independent input used by canonical PR extraction; deleted files must already
   * have been removed by the caller.
   */
  supplementalFiles?: string[];
  /** Observational only. It never participates in shard or manifest identity. */
  onProgress?: (progress: ExtractionProgress) => void;
  /** Benchmark-only; production avoids recursively scanning the shared cache on the hot path. */
  measureCacheBytes?: boolean;
  options?: Omit<
    ExtractOptions,
    "root" | "project" | "include" | "supplementalFiles" | "onProgress"
  >;
}

export interface RevisionExtractionMetrics {
  processId: number;
  totalMs: number;
  fingerprintMs: number;
  unitExtractionMs: number;
  stitchMs: number;
  totalUnits: number;
  reusedUnits: number;
  rebuiltUnits: number;
  reuseRatio: number;
  totalSourceBytes: number;
  reusedSourceBytes: number;
  byteReuseRatio: number;
  reuseEligibleUnits: number;
  conservativelyRebuiltUnits: number;
  peakRssBytes: number;
  cacheBytes: number | null;
}

export interface RevisionExtractionRun {
  result: ExtractionResult;
  manifest: RevisionManifest;
  manifestPath: string;
  metrics: RevisionExtractionMetrics;
}

export function unitFingerprint(unit: WorkspaceUnit): WorkspaceUnitFingerprint {
  return {
    dir: unit.dir,
    name: unit.name,
    entryFile: unit.entryFile,
    sourceDir: unit.sourceDir,
    include: [...unit.include],
    exclude: [...unit.exclude],
  };
}
