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

export function unitInputFingerprint(inputs: {
  root: string;
  unit: WorkspaceUnit;
  loaded: LoadedProject;
  treeBlobs: readonly GitBlobIdentity[];
  policy: AnalysisPolicyFingerprint;
  provenance: ExtractorProvenance;
}): UnitInputFingerprint {
  const typescriptConfig = typeScriptConfigInputs(
    inputs.root,
    inputs.unit.dir,
    inputs.treeBlobs,
  );
  const programInputs = compilerProgramInputs(inputs.root, inputs.loaded, inputs.treeBlobs);
  const filesystemInputs = packageManifestInputs(inputs.root, inputs.loaded, inputs.treeBlobs);
  const resolutionLookupCache = new Map<string, ResolutionLookupInputFingerprint>();
  const moduleResolutions = compilerModuleResolutions(
    inputs.root,
    inputs.loaded,
    inputs.treeBlobs,
    resolutionLookupCache,
  );
  const typeReferenceResolutions = compilerTypeReferenceResolutions(
    inputs.root,
    inputs.loaded,
    inputs.treeBlobs,
    resolutionLookupCache,
  );
  const resolutionLookupInputs = sortedResolutionLookupInputs(resolutionLookupCache.values());
  return {
    version: POC_SHARD_VERSION,
    unit: unitFingerprint(inputs.unit),
    sourceBlobs: selectedSourceBlobs(inputs.root, inputs.loaded, inputs.treeBlobs),
    typescriptConfig,
    programInputs,
    filesystemInputs,
    moduleResolutions,
    typeReferenceResolutions,
    resolutionLookupInputs,
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
  treeBlobs: readonly GitBlobIdentity[],
): GitBlobIdentity[] {
  const byPath = new Map(treeBlobs.map((blob) => [blob.path, blob]));
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
      const actualOid = gitBlobOid(readFileSync(absolute), blob.oid.length);
      if (actualOid !== blob.oid) {
        throw new Error(`selected TypeScript source bytes differ from Git tree: ${relative}`);
      }
      return copyBlob(blob);
    });
}

function packageManifestInputs(
  root: string,
  loaded: LoadedProject,
  treeBlobs: readonly GitBlobIdentity[],
): FilesystemInputFingerprint[] {
  const paths = new Set<string>();
  for (const sourceFile of loaded.project.getProgram().compilerObject.getSourceFiles()) {
    let directory = dirname(toPosix(sourceFile.fileName));
    while (directory === root || !relativeToRoot(root, directory).startsWith("..")) {
      paths.add(join(directory, "package.json"));
      if (directory === root) break;
      directory = dirname(directory);
    }
  }
  const byPath = new Map(treeBlobs.map((blob) => [blob.path, blob]));
  return [...paths]
    .map((path) => packageManifestInput(root, toPosix(path), byPath))
    .sort((left, right) => compareCanonicalStrings(left.address, right.address));
}

function packageManifestInput(
  root: string,
  path: string,
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
): FilesystemInputFingerprint {
  const relative = relativeToRoot(root, path);
  const address = `repo:${relative}`;
  if (!existsSync(path)) {
    return { address, digest: null, kind: "package-manifest", trackedBlobOid: null };
  }
  if (!lstatSync(path).isFile()) {
    throw new Error(`package manifest input is not a regular file: ${relative}`);
  }
  const bytes = readFileSync(path);
  const trackedBlob = treeBlobs.get(relative);
  if (trackedBlob !== undefined) verifyGitBlobBytes(path, bytes, trackedBlob);
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
  treeBlobs: readonly GitBlobIdentity[],
): ProgramInputFingerprint[] {
  const selected = new Set(loaded.sourceFiles.map((file) => toPosix(file.getFilePath())));
  const program = loaded.project.getProgram().compilerObject;
  const byPath = new Map(treeBlobs.map((blob) => [blob.path, blob]));
  return program.getSourceFiles()
    .map((sourceFile) => {
      const path = toPosix(sourceFile.fileName);
      const trackedBlob = trackedBlobFor(root, path, byPath);
      if (trackedBlob !== null) {
        verifyGitBlobBytes(path, readFileSync(path), trackedBlob);
      }
      return {
        address: portableAddress(root, path),
        digest: sha256Hex(sourceFile.text),
        kind: programInputKind(root, path, selected),
        impliedNodeFormat: sourceFile.impliedNodeFormat ?? null,
        isDefaultLibrary: program.isSourceFileDefaultLibrary(sourceFile),
        isExternalLibrary: program.isSourceFileFromExternalLibrary(sourceFile),
        trackedBlobOid: trackedBlob?.oid ?? null,
      };
    })
    .sort(compareProgramInput);
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

function compilerModuleResolutions(
  root: string,
  loaded: LoadedProject,
  treeBlobs: readonly GitBlobIdentity[],
  lookupCache: Map<string, ResolutionLookupInputFingerprint>,
): ModuleResolutionFingerprint[] {
  const program = loaded.project.getProgram().compilerObject as ProgramResolutionAccess;
  requireResolutionIntrospection(program);
  const byPath = new Map(treeBlobs.map((blob) => [blob.path, blob]));
  const resolutions: ModuleResolutionFingerprint[] = [];
  program.forEachResolvedModule((resolution, specifier, mode, containingFile) => {
    recordResolutionLookupInputs(root, resolution, byPath, lookupCache);
    resolutions.push({
      containingFile: portableAddress(root, toPosix(containingFile)),
      mode: mode ?? null,
      specifier,
      target: resolution.resolvedModule === undefined
        ? null
        : moduleResolutionTarget(root, resolution.resolvedModule, byPath),
      hasCompleteLookupProof: hasCompleteLookupProof(
        resolution,
        resolution.resolvedModule !== undefined,
      ),
      alternateResult: typeof resolution.alternateResult === "string"
        ? portableResolutionText(root, resolution.alternateResult)
        : null,
    });
  });
  return resolutions.sort(compareResolution);
}

function compilerTypeReferenceResolutions(
  root: string,
  loaded: LoadedProject,
  treeBlobs: readonly GitBlobIdentity[],
  lookupCache: Map<string, ResolutionLookupInputFingerprint>,
): TypeReferenceResolutionFingerprint[] {
  const program = loaded.project.getProgram().compilerObject as ProgramResolutionAccess;
  requireResolutionIntrospection(program);
  const byPath = new Map(treeBlobs.map((blob) => [blob.path, blob]));
  const resolutions: TypeReferenceResolutionFingerprint[] = [];
  program.forEachResolvedTypeReferenceDirective((resolution, specifier, mode, containingFile) => {
    recordResolutionLookupInputs(root, resolution, byPath, lookupCache);
    resolutions.push({
      containingFile: portableAddress(root, toPosix(containingFile)),
      mode: mode ?? null,
      specifier,
      target: resolution.resolvedTypeReferenceDirective === undefined
        ? null
        : typeReferenceResolutionTarget(
            root,
            resolution.resolvedTypeReferenceDirective,
            byPath,
          ),
      hasCompleteLookupProof: hasCompleteLookupProof(
        resolution,
        resolution.resolvedTypeReferenceDirective !== undefined,
      ),
      alternateResult: typeof resolution.alternateResult === "string"
        ? portableResolutionText(root, resolution.alternateResult)
        : null,
    });
  });
  return resolutions.sort(compareResolution);
}

function recordResolutionLookupInputs(
  root: string,
  resolution: ResolutionLookupInputs,
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  inputs: Map<string, ResolutionLookupInputFingerprint>,
): void {
  for (const path of resolution.failedLookupLocations ?? []) {
    recordResolutionLookupInput(root, path, "failed-lookup", treeBlobs, inputs);
  }
  for (const path of resolution.affectingLocations ?? []) {
    recordResolutionLookupInput(root, path, "affecting", treeBlobs, inputs);
  }
}

function recordResolutionLookupInput(
  root: string,
  path: string,
  purpose: ResolutionLookupInputFingerprint["purpose"],
  treeBlobs: ReadonlyMap<string, GitBlobIdentity>,
  inputs: Map<string, ResolutionLookupInputFingerprint>,
): void {
  const normalizedPath = toPosix(path);
  const key = `${purpose}\0${normalizedPath}`;
  if (!inputs.has(key)) {
    inputs.set(
      key,
      resolutionLookupInput(root, normalizedPath, purpose, treeBlobs),
    );
  }
}

function sortedResolutionLookupInputs(
  inputs: Iterable<ResolutionLookupInputFingerprint>,
): ResolutionLookupInputFingerprint[] {
  return [...inputs].sort((left, right) => (
    compareCanonicalStrings(canonicalJson(left), canonicalJson(right))
  ));
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
): ResolutionLookupInputFingerprint {
  const path = toPosix(pathInput);
  const address = portableAddress(root, path);
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
    const bytes = readFileSync(path);
    if (trackedBlob !== null) verifyGitBlobBytes(path, bytes, trackedBlob);
    return {
      address,
      purpose,
      state: "file",
      digest: sha256Hex(bytes),
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
): ResolutionTargetFingerprint {
  return resolutionTarget(root, resolved.resolvedFileName, treeBlobs, {
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
): ResolutionTargetFingerprint | null {
  if (resolved.resolvedFileName === undefined) return null;
  return resolutionTarget(root, resolved.resolvedFileName, treeBlobs, {
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
  metadata: Omit<ResolutionTargetFingerprint, "address" | "trackedBlobOid">,
): ResolutionTargetFingerprint {
  const normalizedPath = toPosix(path);
  const trackedBlob = trackedBlobFor(root, normalizedPath, treeBlobs);
  if (trackedBlob !== null) {
    verifyGitBlobBytes(normalizedPath, readFileSync(normalizedPath), trackedBlob);
  }
  return {
    address: portableAddress(root, normalizedPath),
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

function verifyGitBlobBytes(path: string, bytes: Buffer, blob: GitBlobIdentity): void {
  if (gitBlobOid(bytes, blob.oid.length) !== blob.oid) {
    throw new Error(`compiler input bytes differ from Git tree: ${path}`);
  }
}

function portableAddress(root: string, path: string): string {
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

function compareProgramInput(
  left: ProgramInputFingerprint,
  right: ProgramInputFingerprint,
): number {
  return compareCanonicalStrings(canonicalJson(left), canonicalJson(right));
}

function compareResolution(
  left: ModuleResolutionFingerprint | TypeReferenceResolutionFingerprint,
  right: ModuleResolutionFingerprint | TypeReferenceResolutionFingerprint,
): number {
  return compareCanonicalStrings(canonicalJson(left), canonicalJson(right));
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
