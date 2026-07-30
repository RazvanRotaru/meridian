import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION, type ExtractOptions } from "@meridian/core";
import { ts } from "ts-morph";
import {
  posixDirname,
  relativeToRoot,
  toPosix,
} from "../paths";
import type { LoadedProject } from "../project-loader";
import type { Workspace, WorkspaceUnit } from "../workspace-units";
import { DEFAULT_EXCLUDES } from "../glob";
import {
  canonicalJson,
  canonicalJsonSha256,
  compareCanonicalStrings,
  sha256Hex,
} from "./canonical-json";
import {
  POC_SHARD_VERSION,
  type AnalysisPolicyFingerprint,
  type ExtractorProvenance,
  type FilesystemInputFingerprint,
  type GitBlobIdentity,
  type ModuleResolutionFingerprint,
  type ProgramInputFingerprint,
  type ResolutionLookupInputFingerprint,
  type ResolutionLookupProofFingerprint,
  type ResolutionTargetFingerprint,
  type ReuseEligibilityFingerprint,
  type RevisionExtractionRequest,
  type StructuralMemberBoundaryFingerprint,
  type TypeReferenceResolutionFingerprint,
  type UnitInputFingerprint,
  unitFingerprint,
} from "./model";
import { typeScriptConfigInputs } from "./config-inputs";

const TS_MORPH_VERSION = installedPackageVersion("ts-morph");

export function analysisPolicy(options: RevisionExtractionRequest["options"]): AnalysisPolicyFingerprint {
  return {
    depth: options?.depth ?? "function",
    exclude: [...(options?.exclude ?? DEFAULT_EXCLUDES)],
    includeExternal: options?.includeExternal ?? false,
    includeUnresolved: options?.includeUnresolved ?? false,
    emitImportEdges: options?.emitImportEdges ?? true,
    valueRefs: options?.valueRefs ?? false,
  };
}

export function extractorProvenance(request: RevisionExtractionRequest): ExtractorProvenance {
  requireVersion("extractorVersion", request.extractorVersion);
  requireVersion("analysisPolicyVersion", request.analysisPolicyVersion);
  return {
    extractorVersion: request.extractorVersion,
    analysisPolicyVersion: request.analysisPolicyVersion,
    schemaVersion: SCHEMA_VERSION,
    shardSchemaVersion: POC_SHARD_VERSION,
    tsMorphVersion: TS_MORPH_VERSION,
    typescriptVersion: ts.version,
  };
}

export function workspaceDigest(workspace: Workspace): string {
  return canonicalJsonSha256({
    units: workspace.units.map(unitFingerprint),
    memberPaths: workspace.memberPaths === undefined ? null : [...workspace.memberPaths].sort(),
  });
}

/** Stable content address for one package-manifest filesystem observation. */
export function filesystemInputKey(input: FilesystemInputFingerprint): string {
  return canonicalJsonSha256(input);
}

/** Stable content address for one TypeScript resolver lookup observation. */
export function resolutionLookupInputKey(input: ResolutionLookupInputFingerprint): string {
  return canonicalJsonSha256(input);
}

/** Stable content address for one exact resolver/triple-slash lookup proof. */
export function resolutionLookupProofKey(input: ResolutionLookupProofFingerprint): string {
  return canonicalJsonSha256(input);
}

export interface UnitInputFingerprintProgressPosition {
  current: number;
  total: number;
  path: string;
}

export interface UnitInputFingerprintRequest {
  root: string;
  unit: WorkspaceUnit;
  loaded: LoadedProject;
  treeBlobs: readonly GitBlobIdentity[];
  treeBlobIndex?: ReadonlyMap<string, GitBlobIdentity>;
  policy: AnalysisPolicyFingerprint;
  provenance: ExtractorProvenance;
  /** Presentation-only compiler-program traversal; null clears the file before global proof work. */
  onProgramInputProgress?: (position: UnitInputFingerprintProgressPosition | null) => unknown;
}

export interface UnitInputFingerprintCatalogs {
  /** Exact object instance from which these ephemeral catalogs were derived. */
  owner: UnitInputFingerprint;
  filesystemInputs: ReadonlyMap<string, FilesystemInputFingerprint>;
  resolutionLookupProofs: ReadonlyMap<string, ResolutionLookupProofFingerprint>;
  resolutionLookupInputs: ReadonlyMap<string, ResolutionLookupInputFingerprint>;
}

export interface UnitInputFingerprintWithCatalogs {
  fingerprint: UnitInputFingerprint;
  /**
   * Ephemeral exact content-address catalogs produced while constructing `fingerprint`. They are
   * an optimization only: persisted identity remains the plain fingerprint, and callers without
   * these catalogs recompute and validate the same addresses.
   */
  catalogs: UnitInputFingerprintCatalogs;
}

export function unitInputFingerprint(
  inputs: UnitInputFingerprintRequest,
): UnitInputFingerprint {
  return unitInputFingerprintWithCatalogs(inputs).fingerprint;
}

export function unitInputFingerprintWithCatalogs(
  inputs: UnitInputFingerprintRequest,
): UnitInputFingerprintWithCatalogs {
  const treeBlobIndex = inputs.treeBlobIndex
    ?? new Map(inputs.treeBlobs.map((blob) => [blob.path, blob]));
  // One fingerprint is one immutable observation snapshot. A popular module may be the target of
  // thousands of resolutions; read and hash its bytes once instead of once per incoming edge.
  const fileCache: FingerprintFileCache = new Map();
  const typescriptConfig = typeScriptConfigInputs(
    inputs.root,
    inputs.unit.dir,
    inputs.treeBlobs,
    treeBlobIndex,
  );
  const packageManifestObservationCache = new Map<string, FilesystemInputFingerprint>();
  const filesystemInputCatalog = new Map<string, FilesystemInputFingerprint>();
  const resolutionLookupCache: ResolutionLookupCache = {
    observations: new Map(),
    failedLists: new WeakMap(),
    affectingLists: new WeakMap(),
    resolutions: new WeakMap(),
    proofKeys: new WeakMap(),
    emptyProofKey: null,
  };
  const resolutionLookupCatalog = new Map<string, ResolutionLookupInputFingerprint>();
  const resolutionLookupProofCatalog = new Map<string, ResolutionLookupProofFingerprint>();
  const programInputs = compilerProgramInputs(
    inputs.root,
    inputs.loaded,
    treeBlobIndex,
    packageManifestObservationCache,
    filesystemInputCatalog,
    resolutionLookupCache,
    resolutionLookupCatalog,
    resolutionLookupProofCatalog,
    fileCache,
    inputs.onProgramInputProgress,
  );
  const filesystemInputs = sortedFingerprintCatalog(filesystemInputCatalog);
  assertReferencedInputKeys(
    programInputs.flatMap((input) => input.filesystemInputKeys),
    filesystemInputCatalog,
    "program filesystem input",
  );
  const moduleResolutions = compilerModuleResolutions(
    inputs.root,
    inputs.loaded,
    treeBlobIndex,
    resolutionLookupCache,
    resolutionLookupCatalog,
    resolutionLookupProofCatalog,
    fileCache,
  );
  const typeReferenceResolutions = compilerTypeReferenceResolutions(
    inputs.root,
    inputs.loaded,
    treeBlobIndex,
    resolutionLookupCache,
    resolutionLookupCatalog,
    resolutionLookupProofCatalog,
    fileCache,
  );
  const resolutionLookupProofs = sortedFingerprintCatalog(resolutionLookupProofCatalog);
  const resolutionLookupInputs = sortedFingerprintCatalog(resolutionLookupCatalog);
  const unattributedResolutionLookupInputKeys: string[] = [];
  assertExactResolutionLookupCatalogs({
    programInputs,
    moduleResolutions,
    typeReferenceResolutions,
    proofs: resolutionLookupProofCatalog,
    inputs: resolutionLookupCatalog,
    unattributedInputKeys: unattributedResolutionLookupInputKeys,
  });
  assertReferencedInputKeys(
    [
      ...programInputs.map((input) => input.resolutionLookupProofKey),
      ...moduleResolutions.map((resolution) => resolution.resolutionLookupProofKey),
      ...typeReferenceResolutions.map(
        (resolution) => resolution.resolutionLookupProofKey,
      ),
    ],
    resolutionLookupProofCatalog,
    "resolution lookup proof",
  );
  assertReferencedInputKeys(
    [
      ...resolutionLookupProofs.flatMap((proof) => proof.resolutionLookupInputKeys),
      ...unattributedResolutionLookupInputKeys,
    ],
    resolutionLookupCatalog,
    "resolution lookup input",
  );
  const fingerprint: UnitInputFingerprint = {
    version: POC_SHARD_VERSION,
    unit: unitFingerprint(inputs.unit),
    sourceBlobs: selectedSourceBlobs(
      inputs.root,
      inputs.loaded,
      treeBlobIndex,
      fileCache,
    ),
    typescriptConfig,
    programInputs,
    filesystemInputs,
    moduleResolutions,
    typeReferenceResolutions,
    resolutionLookupProofs,
    resolutionLookupInputs,
    unattributedResolutionLookupInputKeys,
    structuralMemberBoundaries: structuralMemberBoundaries(inputs.loaded),
    reuseEligibility: reuseEligibility({
      programInputs,
      filesystemInputs,
      moduleResolutions,
      typeReferenceResolutions,
      resolutionLookupInputs,
      configReuseEligibility: typescriptConfig.reuseEligibility,
    }),
    compilerOptionsDigest: compilerOptionsDigest(inputs.root, inputs.loaded),
    policy: inputs.policy,
    provenance: inputs.provenance,
  };
  return {
    fingerprint,
    catalogs: {
      owner: fingerprint,
      filesystemInputs: filesystemInputCatalog,
      resolutionLookupProofs: resolutionLookupProofCatalog,
      resolutionLookupInputs: resolutionLookupCatalog,
    },
  };
}

function structuralMemberBoundaries(
  loaded: LoadedProject,
): StructuralMemberBoundaryFingerprint[] | null {
  if (loaded.memberPaths === undefined) return null;
  const packagePaths = new Set<string>();
  for (const sourceFile of loaded.sourceFiles) {
    let directory = posixDirname(loaded.relativePathOf(sourceFile));
    while (directory.length > 0) {
      packagePaths.add(directory);
      directory = posixDirname(directory);
    }
  }
  return [...packagePaths]
    .sort(compareCanonicalStrings)
    .map((path) => ({
      path,
      isMember: loaded.memberPaths!.has(path),
    }));
}

export function extractOptions(
  root: string,
  policy: AnalysisPolicyFingerprint,
  execution?: Pick<RevisionExtractionRequest, "supplementalFiles" | "onProgress">,
): ExtractOptions {
  return {
    root,
    supplementalFiles: execution?.supplementalFiles,
    depth: policy.depth,
    exclude: policy.exclude,
    includeExternal: policy.includeExternal,
    includeUnresolved: policy.includeUnresolved,
    emitImportEdges: policy.emitImportEdges,
    valueRefs: policy.valueRefs,
    onProgress: execution?.onProgress,
  };
}

function selectedSourceBlobs(
  root: string,
  loaded: LoadedProject,
  byPath: ReadonlyMap<string, GitBlobIdentity>,
  fileCache: FingerprintFileCache,
): GitBlobIdentity[] {
  return loaded.sourceFiles
    .map((sourceFile) => ({
      absolute: toPosix(sourceFile.getFilePath()),
      relative: relativeToRoot(root, sourceFile.getFilePath()),
    }))
    .sort((left, right) => compareCanonicalStrings(left.relative, right.relative))
    .map(({ absolute, relative }) => {
      const blob = byPath.get(relative);
      if (blob === undefined) {
        throw new Error(`selected TypeScript source is not an exact Git-tree blob: ${relative}`);
      }
      const actualOid = observedGitBlobOid(absolute, blob.oid.length, fileCache);
      if (actualOid !== blob.oid) {
        throw new Error(`selected TypeScript source bytes differ from Git tree: ${relative}`);
      }
      return copyBlob(blob);
    });
}

function packageManifestInputKeys(
  root: string,
  sourcePath: string,
  byPath: ReadonlyMap<string, GitBlobIdentity>,
  observationCache: Map<string, FilesystemInputFingerprint>,
  catalog: Map<string, FilesystemInputFingerprint>,
  fileCache: FingerprintFileCache,
): string[] {
  const keys: string[] = [];
  let directory = dirname(toPosix(sourcePath));
  while (directory === root || !relativeToRoot(root, directory).startsWith("..")) {
    const path = toPosix(join(directory, "package.json"));
    let input = observationCache.get(path);
    if (input === undefined) {
      input = packageManifestInput(root, path, byPath, fileCache);
      observationCache.set(path, input);
    }
    const key = filesystemInputKey(input);
    recordContentAddressedFingerprint(catalog, key, input, "filesystem input");
    keys.push(key);
    if (directory === root) break;
    directory = dirname(directory);
  }
  return sortedUniqueKeys(keys);
}

function packageManifestInput(
  root: string,
  path: string,
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  fileCache: FingerprintFileCache,
): FilesystemInputFingerprint {
  const relative = relativeToRoot(root, path);
  const address = `repo:${relative}`;
  if (!existsSync(path)) {
    return { address, digest: null, kind: "package-manifest", trackedBlobOid: null };
  }
  if (!lstatSync(path).isFile()) {
    throw new Error(`package manifest input is not a regular file: ${relative}`);
  }
  const bytes = observedFile(path, fileCache).bytes;
  const trackedBlob = treeBlobs.get(relative);
  if (trackedBlob !== undefined) verifyObservedGitBlob(path, trackedBlob, fileCache);
  return {
    address,
    digest: sha256Hex(bytes),
    kind: "package-manifest",
    trackedBlobOid: trackedBlob?.oid ?? null,
  };
}

function compilerProgramInputs(
  root: string,
  loaded: LoadedProject,
  byPath: ReadonlyMap<string, GitBlobIdentity>,
  packageManifestObservationCache: Map<string, FilesystemInputFingerprint>,
  filesystemInputCatalog: Map<string, FilesystemInputFingerprint>,
  lookupCache: ResolutionLookupCache,
  lookupCatalog: Map<string, ResolutionLookupInputFingerprint>,
  proofCatalog: Map<string, ResolutionLookupProofFingerprint>,
  fileCache: FingerprintFileCache,
  onProgress: ((position: UnitInputFingerprintProgressPosition | null) => unknown) | undefined,
): ProgramInputFingerprint[] {
  const selected = new Set(loaded.sourceFiles.map((file) => toPosix(file.getFilePath())));
  const program = loaded.project.getProgram().compilerObject;
  const sourceFiles = program.getSourceFiles();
  const programInputs = sourceFiles.map((sourceFile, index) => {
    const path = toPosix(sourceFile.fileName);
    if (onProgress !== undefined) {
      reportUnitInputFingerprintProgress(onProgress, {
        current: index + 1,
        total: sourceFiles.length,
        path,
      });
    }
    const trackedBlob = trackedBlobFor(root, path, byPath);
    if (trackedBlob !== null) {
      verifyObservedGitBlob(path, trackedBlob, fileCache);
    }
    return {
      address: portableFingerprintAddress(root, path),
      digest: sha256Hex(sourceFile.text),
      kind: programInputKind(root, path, selected),
      filesystemInputKeys: packageManifestInputKeys(
        root,
        path,
        byPath,
        packageManifestObservationCache,
        filesystemInputCatalog,
        fileCache,
      ),
      resolutionLookupProofKey: recordProgramTripleSlashLookupProof(
        root,
        sourceFile,
        byPath,
        lookupCache,
        lookupCatalog,
        proofCatalog,
        fileCache,
      ),
      impliedNodeFormat: sourceFile.impliedNodeFormat ?? null,
      isDefaultLibrary: program.isSourceFileDefaultLibrary(sourceFile),
      isExternalLibrary: program.isSourceFileFromExternalLibrary(sourceFile),
      trackedBlobOid: trackedBlob?.oid ?? null,
    };
  });
  // Canonical sorting and the remaining resolution/catalog reducers have no truthful current file.
  if (onProgress !== undefined) reportUnitInputFingerprintProgress(onProgress, null);
  return sortByCanonicalJson(programInputs);
}

/** Fingerprint progress is observational and can never affect immutable inputs or extraction. */
function reportUnitInputFingerprintProgress(
  observer: ((position: UnitInputFingerprintProgressPosition | null) => unknown) | undefined,
  position: UnitInputFingerprintProgressPosition | null,
): void {
  try {
    const result = observer?.(position);
    if (
      ((typeof result === "object" && result !== null) || typeof result === "function")
      && typeof (result as { then?: unknown }).then === "function"
    ) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Reading/adopting an adversarial thenable and synchronous observers are both isolated.
  }
}

function compilerOptionsDigest(root: string, loaded: LoadedProject): string {
  return canonicalJsonSha256(portableValue(loaded.project.getCompilerOptions(), root));
}

interface ProgramResolutionAccess extends ts.Program {
  forEachResolvedModule(
    callback: (
      resolution: ModuleResolutionWithLookupInputs,
      name: string,
      mode: ts.ResolutionMode,
      filePath: ts.Path,
    ) => void,
  ): void;
  forEachResolvedTypeReferenceDirective(
    callback: (
      resolution: TypeReferenceResolutionWithLookupInputs,
      name: string,
      mode: ts.ResolutionMode,
      filePath: ts.Path,
    ) => void,
  ): void;
}

interface ResolutionLookupInputs {
  readonly failedLookupLocations?: readonly string[];
  readonly affectingLocations?: readonly string[];
  readonly alternateResult?: unknown;
}

type ModuleResolutionWithLookupInputs =
  ts.ResolvedModuleWithFailedLookupLocations & ResolutionLookupInputs;
type TypeReferenceResolutionWithLookupInputs =
  ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations & ResolutionLookupInputs;

interface ContentAddressedResolutionLookupObservation {
  input: ResolutionLookupInputFingerprint;
  key: string;
}

interface ResolutionLookupCache {
  /**
   * The observation identity already includes purpose and normalized path. Cache its content key
   * with the immutable observation so a popular failed path is not canonicalized and hashed once
   * per import.
   */
  observations: Map<string, ContentAddressedResolutionLookupObservation>;
  /**
   * TypeScript deliberately shares lookup arrays between resolver-cache entries. Memoizing each
   * immutable array turns repeated traversal of the same failed-path proof into one traversal.
   * Purpose uses a separate WeakMap because it participates in every observation key.
   */
  failedLists: WeakMap<readonly string[], string[]>;
  affectingLists: WeakMap<readonly string[], string[]>;
  /** One resolver result object can be reused for many containing files. */
  resolutions: WeakMap<ResolutionLookupInputs, string>;
  /** Shared canonical input-key arrays map to the same already-hashed proof address. */
  proofKeys: WeakMap<readonly string[], string>;
  /** Sources/resolutions without observations all use one canonical empty proof. */
  emptyProofKey: string | null;
}

function recordProgramTripleSlashLookupProof(
  root: string,
  sourceFile: ts.SourceFile,
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  cache: ResolutionLookupCache,
  catalog: Map<string, ResolutionLookupInputFingerprint>,
  proofCatalog: Map<string, ResolutionLookupProofFingerprint>,
  fileCache: FingerprintFileCache,
): string {
  const paths = sourceFile.referencedFiles.map((reference) => (
    ts.resolveTripleslashReference(reference.fileName, sourceFile.fileName)
  ));
  const resolutionLookupInputKeys = recordResolutionLookupList(
    root,
    paths,
    "affecting",
    treeBlobs,
    cache,
    catalog,
    fileCache,
  );
  return recordResolutionLookupProofValue(
    resolutionLookupInputKeys,
    proofCatalog,
    cache,
  );
}

function recordResolutionLookupProofValue(
  resolutionLookupInputKeys: readonly string[],
  catalog: Map<string, ResolutionLookupProofFingerprint>,
  cache: ResolutionLookupCache,
): string {
  const cached = resolutionLookupInputKeys.length === 0
    ? cache.emptyProofKey
    : cache.proofKeys.get(resolutionLookupInputKeys);
  if (cached !== null && cached !== undefined) return cached;
  const proof: ResolutionLookupProofFingerprint = {
    resolutionLookupInputKeys: sortedUniqueKeys(resolutionLookupInputKeys),
  };
  const key = resolutionLookupProofKey(proof);
  recordContentAddressedFingerprint(catalog, key, proof, "resolution lookup proof");
  if (resolutionLookupInputKeys.length === 0) cache.emptyProofKey = key;
  else cache.proofKeys.set(resolutionLookupInputKeys, key);
  return key;
}

function compilerModuleResolutions(
  root: string,
  loaded: LoadedProject,
  byPath: ReadonlyMap<string, GitBlobIdentity>,
  lookupCache: ResolutionLookupCache,
  lookupCatalog: Map<string, ResolutionLookupInputFingerprint>,
  proofCatalog: Map<string, ResolutionLookupProofFingerprint>,
  fileCache: FingerprintFileCache,
): ModuleResolutionFingerprint[] {
  const program = loaded.project.getProgram().compilerObject as ProgramResolutionAccess;
  requireResolutionIntrospection(program);
  const resolutions: ModuleResolutionFingerprint[] = [];
  program.forEachResolvedModule((resolution, specifier, mode, containingFile) => {
    const resolutionLookupProofKey = recordResolutionLookupProof(
      root,
      resolution,
      byPath,
      lookupCache,
      lookupCatalog,
      proofCatalog,
      fileCache,
    );
    resolutions.push({
      containingFile: portableFingerprintAddress(root, toPosix(containingFile)),
      mode: mode ?? null,
      specifier,
      target: resolution.resolvedModule === undefined
        ? null
        : moduleResolutionTarget(root, resolution.resolvedModule, byPath, fileCache),
      resolutionLookupProofKey,
      hasCompleteLookupProof: hasCompleteLookupProof(
        resolution,
        resolution.resolvedModule !== undefined,
      ),
      alternateResult: typeof resolution.alternateResult === "string"
        ? portableResolutionText(root, resolution.alternateResult)
        : null,
    });
  });
  return sortByCanonicalJson(resolutions);
}

function compilerTypeReferenceResolutions(
  root: string,
  loaded: LoadedProject,
  byPath: ReadonlyMap<string, GitBlobIdentity>,
  lookupCache: ResolutionLookupCache,
  lookupCatalog: Map<string, ResolutionLookupInputFingerprint>,
  proofCatalog: Map<string, ResolutionLookupProofFingerprint>,
  fileCache: FingerprintFileCache,
): TypeReferenceResolutionFingerprint[] {
  const program = loaded.project.getProgram().compilerObject as ProgramResolutionAccess;
  requireResolutionIntrospection(program);
  const resolutions: TypeReferenceResolutionFingerprint[] = [];
  program.forEachResolvedTypeReferenceDirective((resolution, specifier, mode, containingFile) => {
    const resolutionLookupProofKey = recordResolutionLookupProof(
      root,
      resolution,
      byPath,
      lookupCache,
      lookupCatalog,
      proofCatalog,
      fileCache,
    );
    resolutions.push({
      containingFile: portableFingerprintAddress(root, toPosix(containingFile)),
      mode: mode ?? null,
      specifier,
      target: resolution.resolvedTypeReferenceDirective === undefined
        ? null
        : typeReferenceResolutionTarget(
            root,
            resolution.resolvedTypeReferenceDirective,
            byPath,
            fileCache,
          ),
      resolutionLookupProofKey,
      hasCompleteLookupProof: hasCompleteLookupProof(
        resolution,
        resolution.resolvedTypeReferenceDirective !== undefined,
      ),
      alternateResult: typeof resolution.alternateResult === "string"
        ? portableResolutionText(root, resolution.alternateResult)
        : null,
    });
  });
  return sortByCanonicalJson(resolutions);
}

function recordResolutionLookupProof(
  root: string,
  resolution: ResolutionLookupInputs,
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  cache: ResolutionLookupCache,
  catalog: Map<string, ResolutionLookupInputFingerprint>,
  proofCatalog: Map<string, ResolutionLookupProofFingerprint>,
  fileCache: FingerprintFileCache,
): string {
  const cached = cache.resolutions.get(resolution);
  if (cached !== undefined) return cached;

  const failedKeys = recordResolutionLookupList(
    root,
    resolution.failedLookupLocations,
    "failed-lookup",
    treeBlobs,
    cache,
    catalog,
    fileCache,
  );
  const affectingKeys = recordResolutionLookupList(
    root,
    resolution.affectingLocations,
    "affecting",
    treeBlobs,
    cache,
    catalog,
    fileCache,
  );
  const alternateKey = typeof resolution.alternateResult === "string"
    ? recordResolutionLookupInput(
      root,
      resolution.alternateResult,
      "failed-lookup",
      treeBlobs,
      cache,
      catalog,
      fileCache,
    )
    : null;

  // TypeScript's watch program treats an alternate resolution target as another failed lookup
  // location. If that path appears later, the owning resolution can change even when the ordinary
  // failedLookupLocations list is unchanged.
  const resolutionLookupInputKeys = affectingKeys.length === 0 && alternateKey === null
    ? failedKeys
    : failedKeys.length === 0 && alternateKey === null
      ? affectingKeys
      : sortedUniqueKeys([
          ...failedKeys,
          ...affectingKeys,
          ...(alternateKey === null ? [] : [alternateKey]),
        ]);
  const key = recordResolutionLookupProofValue(
    resolutionLookupInputKeys,
    proofCatalog,
    cache,
  );
  cache.resolutions.set(resolution, key);
  return key;
}

function recordResolutionLookupList(
  root: string,
  paths: readonly string[] | undefined,
  purpose: ResolutionLookupInputFingerprint["purpose"],
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  cache: ResolutionLookupCache,
  catalog: Map<string, ResolutionLookupInputFingerprint>,
  fileCache: FingerprintFileCache,
): string[] {
  if (paths === undefined || paths.length === 0) return [];
  const listCache = purpose === "failed-lookup"
    ? cache.failedLists
    : cache.affectingLists;
  const cached = listCache.get(paths);
  if (cached !== undefined) return cached;
  const keys = sortedUniqueKeys(paths.map((path) =>
    recordResolutionLookupInput(
      root,
      path,
      purpose,
      treeBlobs,
      cache,
      catalog,
      fileCache,
    )));
  listCache.set(paths, keys);
  return keys;
}

function recordResolutionLookupInput(
  root: string,
  path: string,
  purpose: ResolutionLookupInputFingerprint["purpose"],
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  cache: ResolutionLookupCache,
  catalog: Map<string, ResolutionLookupInputFingerprint>,
  fileCache: FingerprintFileCache,
): string {
  const normalizedPath = toPosix(path);
  const observationKey = `${purpose}\0${normalizedPath}`;
  const cached = cache.observations.get(observationKey);
  if (cached !== undefined) return cached.key;
  const input = resolutionLookupInput(
    root,
    normalizedPath,
    purpose,
    treeBlobs,
    fileCache,
  );
  const key = resolutionLookupInputKey(input);
  recordContentAddressedFingerprint(catalog, key, input, "resolution lookup input");
  cache.observations.set(observationKey, { input, key });
  return key;
}

function hasCompleteLookupProof(
  resolution: ResolutionLookupInputs,
  resolved: boolean,
): boolean {
  if (resolution.failedLookupLocations === undefined) return false;
  return resolved || resolution.failedLookupLocations.length > 0;
}

function portableResolutionText(root: string, value: string): string {
  return toPosix(value).replaceAll(toPosix(root), "<root>");
}

function resolutionLookupInput(
  root: string,
  pathInput: string,
  purpose: ResolutionLookupInputFingerprint["purpose"],
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  fileCache: FingerprintFileCache,
): ResolutionLookupInputFingerprint {
  const path = toPosix(pathInput);
  const address = portableFingerprintAddress(root, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT" || filesystemErrorCode(error) === "ENOTDIR") {
      return {
        address,
        purpose,
        state: "absent",
        digest: null,
        trackedBlobOid: null,
      };
    }
    throw error;
  }
  const trackedBlob = trackedBlobFor(root, path, treeBlobs);
  if (stat.isFile()) {
    const observation = observedFile(path, fileCache);
    if (trackedBlob !== null) verifyObservedGitBlob(path, trackedBlob, fileCache);
    return {
      address,
      purpose,
      state: "file",
      digest: observation.sha256,
      trackedBlobOid: trackedBlob?.oid ?? null,
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      address,
      purpose,
      state: "symlink",
      digest: sha256Hex(readlinkSync(path, "utf8")),
      trackedBlobOid: null,
    };
  }
  return {
    address,
    purpose,
    state: stat.isDirectory() ? "directory" : "other",
    digest: null,
    trackedBlobOid: null,
  };
}

function moduleResolutionTarget(
  root: string,
  resolved: ts.ResolvedModuleFull,
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  fileCache: FingerprintFileCache,
): ResolutionTargetFingerprint {
  return resolutionTarget(root, resolved.resolvedFileName, treeBlobs, fileCache, {
    extension: resolved.extension,
    isExternalLibraryImport: resolved.isExternalLibraryImport ?? false,
    packageId: resolved.packageId ?? null,
    resolvedUsingTsExtension: resolved.resolvedUsingTsExtension ?? false,
  });
}

function typeReferenceResolutionTarget(
  root: string,
  resolved: ts.ResolvedTypeReferenceDirective,
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  fileCache: FingerprintFileCache,
): ResolutionTargetFingerprint | null {
  if (resolved.resolvedFileName === undefined) return null;
  return resolutionTarget(root, resolved.resolvedFileName, treeBlobs, fileCache, {
    extension: null,
    isExternalLibraryImport: resolved.isExternalLibraryImport ?? false,
    packageId: resolved.packageId ?? null,
    resolvedUsingTsExtension: false,
  });
}

function resolutionTarget(
  root: string,
  path: string,
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  fileCache: FingerprintFileCache,
  metadata: Omit<ResolutionTargetFingerprint, "address" | "trackedBlobOid">,
): ResolutionTargetFingerprint {
  const normalizedPath = toPosix(path);
  const trackedBlob = trackedBlobFor(root, normalizedPath, treeBlobs);
  if (trackedBlob !== null) {
    verifyObservedGitBlob(normalizedPath, trackedBlob, fileCache);
  }
  return {
    address: portableFingerprintAddress(root, normalizedPath),
    ...metadata,
    packageId: metadata.packageId === null ? null : {
      name: metadata.packageId.name,
      subModuleName: metadata.packageId.subModuleName,
      version: metadata.packageId.version,
    },
    trackedBlobOid: trackedBlob?.oid ?? null,
  };
}

function reuseEligibility(inputs: {
  programInputs: readonly ProgramInputFingerprint[];
  filesystemInputs: readonly FilesystemInputFingerprint[];
  moduleResolutions: readonly ModuleResolutionFingerprint[];
  typeReferenceResolutions: readonly TypeReferenceResolutionFingerprint[];
  resolutionLookupInputs: readonly ResolutionLookupInputFingerprint[];
  configReuseEligibility: ReuseEligibilityFingerprint;
}): ReuseEligibilityFingerprint {
  const reasons = new Set<string>();
  for (const reason of inputs.configReuseEligibility.reasons) {
    reasons.add(reason);
  }
  for (const input of inputs.programInputs) {
    if (input.trackedBlobOid === null && !input.isDefaultLibrary) {
      reasons.add(input.kind === "dependency"
        ? "external-dependency-program-input"
        : "non-tree-program-input");
    }
  }
  for (const input of inputs.filesystemInputs) {
    if (input.digest !== null && input.trackedBlobOid === null) {
      reasons.add("non-tree-package-manifest");
    }
  }
  addResolutionEligibilityReasons(reasons, inputs.moduleResolutions, "module");
  addResolutionEligibilityReasons(reasons, inputs.typeReferenceResolutions, "type-reference");
  addResolutionLookupEligibilityReasons(reasons, inputs.resolutionLookupInputs);
  const sortedReasons = [...reasons].sort(compareCanonicalStrings);
  return { eligible: sortedReasons.length === 0, reasons: sortedReasons };
}

function addResolutionEligibilityReasons(
  reasons: Set<string>,
  resolutions: readonly (ModuleResolutionFingerprint | TypeReferenceResolutionFingerprint)[],
  kind: "module" | "type-reference",
): void {
  for (const resolution of resolutions) {
    // Every run reconstructs the current Project before consulting the shard store. A positive
    // resolution is therefore re-resolved and its current target enters the key; failed lookup
    // paths are required only when the current result is null. A future no-Project fast path must
    // use a stricter gate that proves the complete negative-read set for positive targets too.
    if (resolution.target === null && !resolution.hasCompleteLookupProof) {
      reasons.add(`unresolved-${kind}-without-lookup-proof`);
    }
    if (resolution.target !== null && resolution.target.trackedBlobOid === null) {
      reasons.add(`non-tree-${kind}-target`);
    }
  }
}

function addResolutionLookupEligibilityReasons(
  reasons: Set<string>,
  inputs: readonly ResolutionLookupInputFingerprint[],
): void {
  for (const input of inputs) {
    if (input.purpose === "failed-lookup" && input.state !== "absent") {
      reasons.add("non-absent-failed-resolution-lookup");
    }
    if (
      input.purpose === "affecting"
      && input.state === "file"
      && input.trackedBlobOid === null
    ) {
      reasons.add("non-tree-resolution-affecting-input");
    }
    if (
      input.purpose === "affecting"
      && input.state !== "absent"
      && input.state !== "file"
    ) {
      reasons.add("unsupported-resolution-affecting-input");
    }
  }
}

function gitBlobOid(bytes: Buffer, oidLength: number): string {
  const algorithm = oidLength === 40 ? "sha1" : oidLength === 64 ? "sha256" : null;
  if (algorithm === null) throw new Error(`unsupported Git object id length: ${oidLength}`);
  return createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function trackedBlobFor(
  root: string,
  path: string,
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
): GitBlobIdentity | null {
  const relative = relativeToRoot(root, path);
  if (relative === ".." || relative.startsWith("../")) return null;
  return treeBlobs.get(relative) ?? null;
}

interface FingerprintFileObservation {
  bytes: Buffer;
  sha256: string;
  gitBlobOids: Map<number, string>;
}

type FingerprintFileCache = Map<string, FingerprintFileObservation>;

function observedFile(
  path: string,
  cache: FingerprintFileCache,
): FingerprintFileObservation {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const bytes = readFileSync(path);
  const observed = {
    bytes,
    sha256: sha256Hex(bytes),
    gitBlobOids: new Map<number, string>(),
  };
  cache.set(path, observed);
  return observed;
}

function observedGitBlobOid(
  path: string,
  oidLength: number,
  cache: FingerprintFileCache,
): string {
  const observation = observedFile(path, cache);
  const cached = observation.gitBlobOids.get(oidLength);
  if (cached !== undefined) return cached;
  const oid = gitBlobOid(observation.bytes, oidLength);
  observation.gitBlobOids.set(oidLength, oid);
  return oid;
}

function verifyObservedGitBlob(
  path: string,
  blob: GitBlobIdentity,
  cache: FingerprintFileCache,
): void {
  if (observedGitBlobOid(path, blob.oid.length, cache) !== blob.oid) {
    throw new Error(`compiler input bytes differ from Git tree: ${path}`);
  }
}

/**
 * Canonical compiler-file identity shared by the unit fingerprint and semantic program graph.
 * Keeping one implementation is important: graph attribution must never rejoin observations with
 * a merely similar path-normalization rule.
 */
export function portableFingerprintAddress(root: string, path: string): string {
  const dependencyAt = path.lastIndexOf("/node_modules/");
  if (dependencyAt >= 0) {
    return `dependency:${path.slice(dependencyAt + 1)}`;
  }
  const rel = relativeToRoot(root, path);
  return rel !== ".." && !rel.startsWith("../") ? `repo:${rel}` : `external:${path}`;
}

function programInputKind(
  root: string,
  path: string,
  selected: ReadonlySet<string>,
): ProgramInputFingerprint["kind"] {
  if (selected.has(path)) return "unit-source";
  const rel = relativeToRoot(root, path);
  return path.includes("/node_modules/") || rel === ".." || rel.startsWith("../")
    ? "dependency"
    : "workspace-source";
}

function portableValue(value: unknown, root: string): unknown {
  if (typeof value === "string") return toPosix(value).replaceAll(toPosix(root), "<root>");
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => portableValue(entry, root));
  if (typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => key !== "configFile" && entry !== undefined && typeof entry !== "function")
      .map(([key, entry]) => [key, portableValue(entry, root)]),
  );
}

function copyBlob(blob: GitBlobIdentity): GitBlobIdentity {
  return { path: blob.path, oid: blob.oid, mode: blob.mode, byteSize: blob.byteSize };
}

/**
 * Canonical JSON remains the ordering authority, but serializing both operands from inside an
 * O(n log n) comparator made large TypeScript programs spend tens of seconds recreating identical
 * strings. Decorate once, sort the immutable keys, then discard the non-semantic decoration.
 */
function sortByCanonicalJson<T>(values: readonly T[]): T[] {
  return values
    .map((value) => ({ key: canonicalJson(value), value }))
    .sort((left, right) => compareCanonicalStrings(left.key, right.key))
    .map(({ value }) => value);
}

function sortedUniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort(compareCanonicalStrings);
}

function recordContentAddressedFingerprint<T>(
  catalog: Map<string, T>,
  key: string,
  input: T,
  label: string,
): void {
  const existing = catalog.get(key);
  if (existing === undefined) {
    catalog.set(key, input);
    return;
  }
  if (canonicalJson(existing) !== canonicalJson(input)) {
    throw new Error(`${label} content-key collision: ${key}`);
  }
}

function sortedFingerprintCatalog<T>(catalog: ReadonlyMap<string, T>): T[] {
  return sortByCanonicalJson([...catalog.values()]);
}

function assertReferencedInputKeys<T>(
  references: readonly string[],
  catalog: ReadonlyMap<string, T>,
  label: string,
): void {
  const referenced = new Set(references);
  for (const key of referenced) {
    if (!catalog.has(key)) {
      throw new Error(`${label} reference is missing from its flattened catalog: ${key}`);
    }
  }
  for (const key of catalog.keys()) {
    if (!referenced.has(key)) {
      throw new Error(`${label} catalog entry has no owner reference: ${key}`);
    }
  }
}

function assertExactResolutionLookupCatalogs(inputs: {
  programInputs: readonly ProgramInputFingerprint[];
  moduleResolutions: readonly ModuleResolutionFingerprint[];
  typeReferenceResolutions: readonly TypeReferenceResolutionFingerprint[];
  proofs: ReadonlyMap<string, ResolutionLookupProofFingerprint>;
  inputs: ReadonlyMap<string, ResolutionLookupInputFingerprint>;
  unattributedInputKeys: readonly string[];
}): void {
  const referencedProofKeys = new Set([
    ...inputs.programInputs.map((input) => input.resolutionLookupProofKey),
    ...inputs.moduleResolutions.map((resolution) => resolution.resolutionLookupProofKey),
    ...inputs.typeReferenceResolutions.map(
      (resolution) => resolution.resolutionLookupProofKey,
    ),
  ]);
  const referencedInputKeys = new Set(inputs.unattributedInputKeys);
  for (const proofKey of referencedProofKeys) {
    const proof = inputs.proofs.get(proofKey);
    if (proof === undefined) {
      throw new Error(`resolution lookup proof reference is missing: ${proofKey}`);
    }
    if (resolutionLookupProofKey(proof) !== proofKey) {
      throw new Error(`resolution lookup proof content address is invalid: ${proofKey}`);
    }
    if (
      canonicalJson(proof.resolutionLookupInputKeys)
      !== canonicalJson(sortedUniqueKeys(proof.resolutionLookupInputKeys))
    ) {
      throw new Error(`resolution lookup proof is not sorted and unique: ${proofKey}`);
    }
    for (const inputKey of proof.resolutionLookupInputKeys) {
      referencedInputKeys.add(inputKey);
    }
  }
  assertReferencedInputKeys(
    [...referencedProofKeys],
    inputs.proofs,
    "resolution lookup proof",
  );
  for (const [inputKey, input] of inputs.inputs) {
    if (resolutionLookupInputKey(input) !== inputKey) {
      throw new Error(`resolution lookup input content address is invalid: ${inputKey}`);
    }
  }
  assertReferencedInputKeys(
    [...referencedInputKeys],
    inputs.inputs,
    "resolution lookup input",
  );
}

function requireResolutionIntrospection(
  program: ProgramResolutionAccess,
): void {
  if (typeof program.forEachResolvedModule !== "function"
    || typeof program.forEachResolvedTypeReferenceDirective !== "function") {
    throw new Error("TypeScript runtime does not expose the resolver state required by this POC");
  }
}

function requireVersion(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be an explicit non-empty version`);
}

function installedPackageVersion(packageName: "ts-morph"): string {
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(
    readFileSync(require.resolve(`${packageName}/package.json`), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${packageName} package version is unavailable`);
  }
  return manifest.version;
}

function filesystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
