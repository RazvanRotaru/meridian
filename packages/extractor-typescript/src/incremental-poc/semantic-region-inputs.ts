/**
 * Complete, target-derived inputs for experimental sub-unit TypeScript reuse.
 *
 * The exact target compiler program is observed before selected extraction files are projected
 * into independently addressed regions. A file can reuse its immutable semantic contribution
 * only when its own exact compiler input, every directly observed declaration provider input, and
 * the normalized result of the compiler queries used by the cached lanes are unchanged.
 *
 * Ambient, augmentation, and default-library changes therefore cause target re-observation, but
 * do not automatically invalidate every region. The recomputed observation is the fixed point:
 * propagation stops at files whose actual binding/type/export decisions remain unchanged. Missing
 * compiler input or observation coverage fails closed to whole-unit extraction. Structure,
 * implementation members, Promise resources, flows, ports/RPC, ordering, and stitching are never
 * cached by this layer.
 */

import { performance } from "node:perf_hooks";
import { ts, type SourceFile } from "ts-morph";
import type { LoadedProject } from "../project-loader";
import { relativeToRoot, toPosix } from "../paths";
import {
  canonicalJson,
  canonicalJsonSha256,
  compareCanonicalStrings,
} from "./canonical-json";
import {
  filesystemInputKey,
  portableFingerprintAddress,
  resolutionLookupInputKey,
  resolutionLookupProofKey,
  type UnitInputFingerprintCatalogs,
} from "./fingerprints";
import type {
  FilesystemInputFingerprint,
  GitBlobIdentity,
  ModuleResolutionFingerprint,
  ProgramInputFingerprint,
  ResolutionLookupInputFingerprint,
  ResolutionLookupProofFingerprint,
  TypeReferenceResolutionFingerprint,
  UnitInputFingerprint,
} from "./model";
import {
  SEMANTIC_PROGRAM_GRAPH_VERSION,
  type SemanticProgramComponentInput,
  type SemanticProgramDependency,
  type SemanticProgramNode,
  type SemanticProgramProviderKey,
} from "./semantic-program-graph";
import {
  collectSemanticCompilerObservations,
  SEMANTIC_COMPILER_OBSERVATION_VERSION,
  type SemanticCompilerFileObservation,
  type SemanticCompilerObservationResult,
} from "./semantic-compiler-observations";
import {
  planSemanticRegions,
  REQUIRED_SEMANTIC_REGION_EVIDENCE,
  SEMANTIC_REGION_PLAN_VERSION,
  type SemanticRegionPlan,
} from "./semantic-regions";

export const SEMANTIC_REGION_INPUT_VERSION = 6 as const;

const WHOLE_UNIT_FALLBACK_CANONICAL_INPUT = canonicalJson({
  cacheable: false,
  kind: "whole-unit-fallback",
  version: SEMANTIC_REGION_INPUT_VERSION,
});
const WHOLE_UNIT_FALLBACK_SENTINEL = "non-cacheable-whole-unit-fallback";

export interface SemanticRegionContextV2 {
  version: typeof SEMANTIC_REGION_INPUT_VERSION;
  unit: UnitInputFingerprint["unit"];
  typescriptConfig: UnitInputFingerprint["typescriptConfig"];
  /**
   * Inputs that could not be assigned to one exact compiler source stay global. A normal eligible
   * TypeScript 6 program has no program-input remainder and only explicitly unattributed lookup
   * observations here.
   */
  unattributedProgramInputs: ProgramInputFingerprint[];
  unattributedFilesystemInputs: FilesystemInputFingerprint[];
  unattributedModuleResolutions: ModuleResolutionFingerprint[];
  unattributedTypeReferenceResolutions: TypeReferenceResolutionFingerprint[];
  unattributedResolutionLookupInputs: ResolutionLookupInputFingerprint[];
  compilerOptionsDigest: string;
  policy: UnitInputFingerprint["policy"];
  provenance: UnitInputFingerprint["provenance"];
  workspaceDigest: string;
  evidence: typeof REQUIRED_SEMANTIC_REGION_EVIDENCE;
  plannerVersion: typeof SEMANTIC_REGION_PLAN_VERSION;
  programGraphVersion: typeof SEMANTIC_PROGRAM_GRAPH_VERSION;
  compilerObservationVersion: typeof SEMANTIC_COMPILER_OBSERVATION_VERSION;
}

export interface SemanticRegionProgramComponentV2 {
  componentId: string;
  /** Exact canonical source/resolution inputs owned once by this full-program SCC. */
  componentInput: SemanticProgramComponentInput;
  /** Recursive keys for every direct provider SCC, selected or external-only. */
  providerComponentKeys: SemanticProgramProviderKey[];
}

export interface SemanticRegionInputV2 {
  version: typeof SEMANTIC_REGION_INPUT_VERSION;
  regionId: string;
  /** Selected exact-tree blobs whose semantic contribution is persisted in this shard. */
  files: GitBlobIdentity[];
  programComponent: SemanticRegionProgramComponentV2;
  dependencyRegionKeys: Array<{
    regionId: string;
    key: string;
  }>;
  /** Observationally useful subset of providerComponentKeys; identity uses both fields. */
  directExternalProviderKeys: string[];
  contextDigest: string;
}

export interface AddressedSemanticRegion {
  id: string;
  /** Canonical selected-region membership; target materialization order is derived separately. */
  files: string[];
  dependencyRegionIds: string[];
  key: string;
  inputs: SemanticRegionInputV2;
}

export interface AddressedSemanticRegionPlan {
  plan: SemanticRegionPlan;
  context: SemanticRegionContextV2;
  contextDigest: string;
  regions: AddressedSemanticRegion[];
  evaluationOrder: string[];
  regionByFile: ReadonlyMap<string, AddressedSemanticRegion>;
}

interface SemanticGlobalRemainder {
  programInputs: ProgramInputFingerprint[];
  filesystemInputs: FilesystemInputFingerprint[];
  moduleResolutions: ModuleResolutionFingerprint[];
  typeReferenceResolutions: TypeReferenceResolutionFingerprint[];
  resolutionLookupInputs: ResolutionLookupInputFingerprint[];
}

interface PreparedSemanticProgram {
  nodes: SemanticProgramNode[];
  remainder: SemanticGlobalRemainder;
  unsafeReasons: string[];
}

interface SemanticProgramNodeInputV2 {
  version: typeof SEMANTIC_REGION_INPUT_VERSION;
  address: string;
  programInputs: ProgramInputFingerprint[];
  /**
   * Content addresses are the exact immutable values here. The catalog is validated against the
   * unit fingerprint once; copying the full lookup payload into every owning file would add no
   * identity information and makes warm addressing scale with repeated JSON serialization.
   */
  filesystemInputKeys: string[];
  moduleResolutions: ModuleResolutionFingerprint[];
  typeReferenceResolutions: TypeReferenceResolutionFingerprint[];
  resolutionLookupInputKeys: string[];
}

interface CompilerObservedSemanticFileInputV3 {
  version: typeof SEMANTIC_REGION_INPUT_VERSION;
  address: string;
  /** Exact digest of the source's complete compiler-program/fingerprint input. */
  localProgramInputDigest: string;
  compilerObservation: Pick<
    SemanticCompilerFileObservation,
    "version" | "digest" | "queryCount"
  >;
  /**
   * Direct declaration owners are content-bound without recursively importing their dependency
   * keys. The target-recomputed compiler observation is the fixed point: transitive changes
   * propagate only when the consumer's actual binding/type/export decisions change.
   */
  directProviderInputs: Array<{
    address: string;
    inputDigest: string;
  }>;
}

/**
 * Derive the same addressed plan in every process that observes the same exact target program.
 * Neither Git diff nor base revision participates in identity.
 */
export function addressSemanticRegions(inputs: {
  loaded: LoadedProject;
  unitInputs: UnitInputFingerprint;
  workspaceDigest: string;
  /** Report/test seam; values are still checked against exact Program/source coverage below. */
  compilerObservations?: SemanticCompilerObservationResult;
  /** Ephemeral content-address catalogs produced with this exact fingerprint object. */
  unitInputCatalogs?: UnitInputFingerprintCatalogs;
  /** Non-semantic diagnostic seam for the disposable performance harness. */
  onTiming?: (timing: {
    prepareProgramMs: number;
    collectObservationsMs: number;
    contextMs: number;
    addressFilesMs: number;
  }) => void;
}): AddressedSemanticRegionPlan {
  const filesInTargetOrder = inputs.loaded.sourceFiles.map(inputs.loaded.relativePathOf);
  const selectedFiles = new Set(filesInTargetOrder);
  const baseUnsafeReasons = semanticPlanningUnsafeReasons(
    inputs.unitInputs,
    selectedFiles,
  );
  if (baseUnsafeReasons.length > 0) {
    return wholeUnitFallbackPlan(
      inputs.unitInputs,
      inputs.workspaceDigest,
      filesInTargetOrder,
      baseUnsafeReasons,
    );
  }

  const prepareStarted = performance.now();
  const prepared = prepareSemanticProgram(
    inputs.loaded,
    inputs.unitInputs,
    selectedFiles,
    inputs.unitInputCatalogs,
  );
  const prepareProgramMs = performance.now() - prepareStarted;
  const observationsStarted = performance.now();
  const compilerObservations = inputs.compilerObservations
    ?? collectSemanticCompilerObservations(
      inputs.loaded,
      new Set(filesInTargetOrder.map((file) => `repo:${file}`)),
    );
  const collectObservationsMs = performance.now() - observationsStarted;
  const unsafeReasons = uniqueSorted([
    ...prepared.unsafeReasons,
    ...compilerObservations.unsafeReasons,
    ...(compilerObservations.version === SEMANTIC_COMPILER_OBSERVATION_VERSION
      ? []
      : ["unsupported-compiler-semantic-observation-version"]),
  ]);
  if (unsafeReasons.length > 0) {
    return wholeUnitFallbackPlan(
      inputs.unitInputs,
      inputs.workspaceDigest,
      filesInTargetOrder,
      unsafeReasons,
    );
  }
  const contextStarted = performance.now();
  const context = semanticRegionContext(
    inputs.unitInputs,
    inputs.workspaceDigest,
    prepared.remainder,
  );
  const contextDigest = canonicalJsonSha256(context);
  const blobByPath = new Map(
    inputs.unitInputs.sourceBlobs.map((blob) => [blob.path, blob]),
  );
  const contextMs = performance.now() - contextStarted;
  let addressed: {
    plan: SemanticRegionPlan;
    regions: AddressedSemanticRegion[];
  };
  try {
    const addressStarted = performance.now();
    addressed = addressCompilerObservedFiles({
      blobByPath,
      compilerObservations: compilerObservations.files,
      contextDigest,
      filesInTargetOrder,
      programNodes: prepared.nodes,
    });
    inputs.onTiming?.({
      prepareProgramMs,
      collectObservationsMs,
      contextMs,
      addressFilesMs: performance.now() - addressStarted,
    });
  } catch (error) {
    return wholeUnitFallbackPlan(
      inputs.unitInputs,
      inputs.workspaceDigest,
      filesInTargetOrder,
      [`semantic-compiler-observation:${errorMessage(error)}`],
    );
  }

  const regionByFile = new Map<string, AddressedSemanticRegion>();
  for (const region of addressed.regions) {
    for (const file of region.files) regionByFile.set(file, region);
  }
  return {
    plan: addressed.plan,
    context,
    contextDigest,
    regions: addressed.regions,
    evaluationOrder: [...addressed.plan.evaluationOrder],
    regionByFile,
  };
}

function addressCompilerObservedFiles(input: {
  blobByPath: ReadonlyMap<string, GitBlobIdentity>,
  compilerObservations: readonly SemanticCompilerFileObservation[],
  contextDigest: string,
  filesInTargetOrder: readonly string[];
  programNodes: readonly SemanticProgramNode[];
}): {
  plan: SemanticRegionPlan;
  regions: AddressedSemanticRegion[];
} {
  const plan = planSemanticRegions({
    files: [...input.filesInTargetOrder],
    dependencies: [],
    completeEvidence: [...REQUIRED_SEMANTIC_REGION_EVIDENCE],
    unsafeReasons: [],
  });
  if (plan.kind !== "partitioned") {
    throw new Error("complete compiler observations unexpectedly produced fallback");
  }
  const nodeByAddress = new Map(input.programNodes.map((node) => [node.id, node]));
  const nodeInputDigestByAddress = new Map(
    input.programNodes.map((node) => [
      node.id,
      canonicalJsonSha256(node.input),
    ]),
  );
  const observationByAddress = new Map(
    input.compilerObservations.map((observation) => [
      observation.address,
      observation,
    ]),
  );
  if (
    observationByAddress.size !== input.compilerObservations.length
    || nodeByAddress.size !== input.programNodes.length
  ) {
    throw new Error("duplicate compiler observation or program node address");
  }
  const plannedRegionByFile = new Map(
    plan.regions.flatMap((region) => region.files.map((file) => [file, region])),
  );
  const plannedRegionById = new Map(
    plan.regions.map((region) => [region.id, region]),
  );
  const regions = plan.evaluationOrder.map((regionId) => {
    const planned = plannedRegionById.get(regionId);
    if (planned === undefined || planned.files.length !== 1) {
      throw new Error(`compiler-observed region is not exactly one file: ${regionId}`);
    }
    const file = planned.files[0]!;
    if (plannedRegionByFile.get(file)?.id !== regionId) {
      throw new Error(`compiler-observed region lookup is incoherent: ${file}`);
    }
    const address = `repo:${file}`;
    const node = nodeByAddress.get(address);
    const observation = observationByAddress.get(address);
    const blob = input.blobByPath.get(file);
    if (node === undefined || observation === undefined || blob === undefined) {
      throw new Error(`compiler-observed source proof is incomplete: ${file}`);
    }
    const localProgramInputDigest = nodeInputDigestByAddress.get(address);
    if (localProgramInputDigest === undefined) {
      throw new Error(`compiler-observed local input digest is missing: ${file}`);
    }
    const directProviderInputs = observation.providerAddresses.map((provider) => {
      const inputDigest = nodeInputDigestByAddress.get(provider);
      if (inputDigest === undefined) {
        throw new Error(
          `compiler-observed provider is outside the exact Program: ${provider}`,
        );
      }
      return { address: provider, inputDigest };
    });
    const fileInput: CompilerObservedSemanticFileInputV3 = {
      version: SEMANTIC_REGION_INPUT_VERSION,
      address,
      localProgramInputDigest,
      compilerObservation: {
        version: observation.version,
        digest: observation.digest,
        queryCount: observation.queryCount,
      },
      directProviderInputs,
    };
    const componentInput: SemanticProgramComponentInput = {
      selectedNodeIds: [address],
      ambientNodeIds: [],
      containsUniversalProviderAggregate: false,
      nodes: [{
        id: address,
        canonicalInput: canonicalJson(fileInput),
      }],
      dependencies: directProviderInputs.map((provider) => ({
        consumer: address,
        provider: provider.address,
      })),
    };
    const regionInputs: SemanticRegionInputV2 = {
      version: SEMANTIC_REGION_INPUT_VERSION,
      regionId,
      files: [{ ...blob }],
      programComponent: {
        componentId:
          `semantic-compiler-observed-file-v${SEMANTIC_COMPILER_OBSERVATION_VERSION}:`
          + canonicalJsonSha256({ address }),
        componentInput,
        providerComponentKeys: [],
      },
      dependencyRegionKeys: [],
      directExternalProviderKeys: [],
      contextDigest: input.contextDigest,
    };
    return {
      id: regionId,
      files: [file],
      dependencyRegionIds: [],
      key: semanticRegionAddress(regionInputs),
      inputs: regionInputs,
    };
  });
  return {
    plan,
    regions,
  };
}

function prepareSemanticProgram(
  loaded: LoadedProject,
  inputs: UnitInputFingerprint,
  selectedFiles: ReadonlySet<string>,
  catalogs?: UnitInputFingerprintCatalogs,
): PreparedSemanticProgram {
  const unsafeReasons: string[] = [];
  const suppliedCatalogs = catalogs?.owner === inputs ? catalogs : undefined;
  const filesystemCatalog = suppliedCatalogs?.filesystemInputs
    ?? fingerprintCatalog(
      inputs.filesystemInputs,
      filesystemInputKey,
      "filesystem-input",
      unsafeReasons,
    );
  const lookupCatalog = suppliedCatalogs?.resolutionLookupInputs
    ?? fingerprintCatalog(
      inputs.resolutionLookupInputs,
      resolutionLookupInputKey,
      "resolution-lookup-input",
      unsafeReasons,
    );
  const proofCatalog = suppliedCatalogs?.resolutionLookupProofs
    ?? fingerprintCatalog(
      inputs.resolutionLookupProofs,
      resolutionLookupProofKey,
      "resolution-lookup-proof",
      unsafeReasons,
    );
  const programInputsByAddress = groupedBy(
    inputs.programInputs,
    (input) => input.address,
  );
  const moduleResolutionsByAddress = new Map<string, ModuleResolutionFingerprint[]>();
  const typeResolutionsByAddress = new Map<string, TypeReferenceResolutionFingerprint[]>();
  const globalModuleResolutions: ModuleResolutionFingerprint[] = [];
  const globalTypeResolutions: TypeReferenceResolutionFingerprint[] = [];
  const globalLookupKeys = new Set(inputs.unattributedResolutionLookupInputKeys);
  const referencedProofKeys = new Set<string>();

  for (const resolution of inputs.moduleResolutions) {
    if (programInputsByAddress.has(resolution.containingFile)) {
      addGrouped(moduleResolutionsByAddress, resolution.containingFile, resolution);
    } else {
      globalModuleResolutions.push(resolution);
      resolutionLookupKeysForOwner(
        resolution.resolutionLookupProofKey,
        proofCatalog,
        referencedProofKeys,
        "global-module-resolution",
        unsafeReasons,
      ).forEach((key) => globalLookupKeys.add(key));
    }
  }
  for (const resolution of inputs.typeReferenceResolutions) {
    if (programInputsByAddress.has(resolution.containingFile)) {
      addGrouped(typeResolutionsByAddress, resolution.containingFile, resolution);
    } else {
      globalTypeResolutions.push(resolution);
      resolutionLookupKeysForOwner(
        resolution.resolutionLookupProofKey,
        proofCatalog,
        referencedProofKeys,
        "global-type-reference-resolution",
        unsafeReasons,
      ).forEach((key) => globalLookupKeys.add(key));
    }
  }

  const referencedFilesystemKeys = new Set<string>();
  const referencedLookupKeys = new Set<string>();
  const nodes: SemanticProgramNode[] = [];
  for (const [address, programInputs] of [...programInputsByAddress]
    .sort(([left], [right]) => compareCanonicalStrings(left, right))) {
    const moduleResolutions = moduleResolutionsByAddress.get(address) ?? [];
    const typeReferenceResolutions = typeResolutionsByAddress.get(address) ?? [];
    const filesystemKeys = uniqueSorted(
      programInputs.flatMap((input) => input.filesystemInputKeys),
    );
    const programLookupKeys = programInputs.flatMap((input) => (
      resolutionLookupKeysForOwner(
        input.resolutionLookupProofKey,
        proofCatalog,
        referencedProofKeys,
        `program-input:${address}`,
        unsafeReasons,
      )
    ));
    const resolutionLookupKeys = uniqueSorted([
      ...programLookupKeys,
      ...moduleResolutions.flatMap(
        (resolution) => resolutionLookupKeysForOwner(
          resolution.resolutionLookupProofKey,
          proofCatalog,
          referencedProofKeys,
          `module-resolution:${address}:${resolution.specifier}`,
          unsafeReasons,
        ),
      ),
      ...typeReferenceResolutions.flatMap(
        (resolution) => resolutionLookupKeysForOwner(
          resolution.resolutionLookupProofKey,
          proofCatalog,
          referencedProofKeys,
          `type-reference-resolution:${address}:${resolution.specifier}`,
          unsafeReasons,
        ),
      ),
    ]);
    validateFingerprintKeys(
      filesystemKeys,
      filesystemCatalog,
      referencedFilesystemKeys,
      "filesystem-input",
      unsafeReasons,
    );
    validateFingerprintKeys(
      resolutionLookupKeys,
      lookupCatalog,
      referencedLookupKeys,
      "resolution-lookup-input",
      unsafeReasons,
    );
    const nodeInput: SemanticProgramNodeInputV2 = {
      version: SEMANTIC_REGION_INPUT_VERSION,
      address,
      programInputs,
      filesystemInputKeys: filesystemKeys,
      moduleResolutions,
      typeReferenceResolutions,
      resolutionLookupInputKeys: resolutionLookupKeys,
    };
    nodes.push({ id: address, input: nodeInput });
  }

  const dependencies: SemanticProgramDependency[] = [];
  for (const resolution of [
    ...inputs.moduleResolutions,
    ...inputs.typeReferenceResolutions,
  ]) {
    if (
      programInputsByAddress.has(resolution.containingFile)
      && resolution.target !== null
      && programInputsByAddress.has(resolution.target.address)
      && resolution.containingFile !== resolution.target.address
    ) {
      dependencies.push({
        consumer: resolution.containingFile,
        provider: resolution.target.address,
      });
    }
  }
  validateCompilerResolutionCoverage({
    loaded,
    inputs,
    programInputsByAddress,
    dependencies,
    unsafeReasons,
  });

  const program = loaded.project.getProgram().compilerObject;
  const observedProgramAddresses = new Set<string>();
  const defaultLibraryAddressByName = defaultLibraryAddresses(
    loaded,
    program,
    unsafeReasons,
  );
  const typeReferenceSpecifiersByAddress = groupedSpecifierSet(
    inputs.typeReferenceResolutions,
  );
  for (const sourceFile of program.getSourceFiles()) {
    const address = portableFingerprintAddress(
      loaded.root,
      toPosix(sourceFile.fileName),
    );
    observedProgramAddresses.add(address);
    if (!programInputsByAddress.has(address)) {
      unsafeReasons.push(`program-source-without-input:${address}`);
      continue;
    }
    for (const reference of sourceFile.referencedFiles) {
      const target = portableFingerprintAddress(
        loaded.root,
        toPosix(ts.resolveTripleslashReference(reference.fileName, sourceFile.fileName)),
      );
      if (!programInputsByAddress.has(target)) {
        const ownerInputs = programInputsByAddress.get(address) ?? [];
        const hasExactObservation = ownerInputs.some((input) => (
          resolutionLookupKeysForOwner(
            input.resolutionLookupProofKey,
            proofCatalog,
            referencedProofKeys,
            `triple-slash-program-input:${address}`,
            unsafeReasons,
          ).some((key) => {
            const observation = lookupCatalog.get(key);
            return observation?.purpose === "affecting"
              && observation.address === target;
          })
        ));
        if (!hasExactObservation) {
          unsafeReasons.push(`unmapped-triple-slash-reference:${address}->${target}`);
        }
      } else if (address !== target) {
        dependencies.push({ consumer: address, provider: target });
      }
    }
    for (const reference of sourceFile.typeReferenceDirectives) {
      if (!typeReferenceSpecifiersByAddress.get(address)?.has(reference.fileName)) {
        unsafeReasons.push(
          `unmapped-type-reference-directive:${address}->${reference.fileName}`,
        );
      }
    }
    for (const reference of sourceFile.libReferenceDirectives) {
      const libName = `lib.${reference.fileName.toLowerCase()}.d.ts`;
      const target = defaultLibraryAddressByName.get(libName);
      if (target === undefined || target === null) {
        unsafeReasons.push(`unmapped-lib-reference-directive:${address}->${libName}`);
      } else if (address !== target) {
        dependencies.push({ consumer: address, provider: target });
      }
    }
  }
  for (const address of programInputsByAddress.keys()) {
    if (!observedProgramAddresses.has(address)) {
      unsafeReasons.push(`program-input-without-source:${address}`);
    }
  }

  for (const key of globalLookupKeys) {
    referencedLookupKeys.add(key);
    if (!lookupCatalog.has(key)) {
      unsafeReasons.push(`missing-global-resolution-lookup-input:${key}`);
    }
  }
  for (const key of proofCatalog.keys()) {
    if (!referencedProofKeys.has(key)) {
      unsafeReasons.push(`orphan-resolution-lookup-proof:${key}`);
    }
  }
  for (const key of lookupCatalog.keys()) {
    if (!referencedLookupKeys.has(key) && !globalLookupKeys.has(key)) {
      unsafeReasons.push(`orphan-resolution-lookup-input:${key}`);
    }
  }
  const unreferencedFilesystemInputs = [...filesystemCatalog]
    .filter(([key]) => !referencedFilesystemKeys.has(key))
    .map(([, input]) => input);
  const globalResolutionLookupInputs = [...lookupCatalog]
    .filter(([key]) => globalLookupKeys.has(key) || !referencedLookupKeys.has(key))
    .map(([, input]) => input);
  const selectedNodeIds = [...selectedFiles]
    .map((file) => `repo:${file}`)
    .sort(compareCanonicalStrings);
  for (const nodeId of selectedNodeIds) {
    if (!programInputsByAddress.has(nodeId)) {
      unsafeReasons.push(`selected-source-without-program-node:${nodeId}`);
    }
  }

  return {
    nodes,
    remainder: {
      programInputs: [],
      filesystemInputs: sortCanonical(unreferencedFilesystemInputs),
      moduleResolutions: sortCanonical(globalModuleResolutions),
      typeReferenceResolutions: sortCanonical(globalTypeResolutions),
      resolutionLookupInputs: sortCanonical(globalResolutionLookupInputs),
    },
    unsafeReasons: uniqueSorted(unsafeReasons),
  };
}

function semanticRegionContext(
  inputs: UnitInputFingerprint,
  workspaceDigest: string,
  remainder: SemanticGlobalRemainder,
): SemanticRegionContextV2 {
  return {
    version: SEMANTIC_REGION_INPUT_VERSION,
    unit: inputs.unit,
    typescriptConfig: inputs.typescriptConfig,
    unattributedProgramInputs: remainder.programInputs,
    unattributedFilesystemInputs: remainder.filesystemInputs,
    unattributedModuleResolutions: remainder.moduleResolutions,
    unattributedTypeReferenceResolutions: remainder.typeReferenceResolutions,
    unattributedResolutionLookupInputs: remainder.resolutionLookupInputs,
    compilerOptionsDigest: inputs.compilerOptionsDigest,
    policy: inputs.policy,
    provenance: inputs.provenance,
    workspaceDigest,
    evidence: REQUIRED_SEMANTIC_REGION_EVIDENCE,
    plannerVersion: SEMANTIC_REGION_PLAN_VERSION,
    programGraphVersion: SEMANTIC_PROGRAM_GRAPH_VERSION,
    compilerObservationVersion: SEMANTIC_COMPILER_OBSERVATION_VERSION,
  };
}

function wholeUnitFallbackPlan(
  inputs: UnitInputFingerprint,
  workspaceDigest: string,
  filesInTargetOrder: readonly string[],
  unsafeReasons: readonly string[],
): AddressedSemanticRegionPlan {
  const context = wholeUnitFallbackContext(
    inputs,
    workspaceDigest,
    unsafeReasons,
  );
  const contextDigest = canonicalJsonSha256(context);
  const plan = planSemanticRegions({
    files: [...filesInTargetOrder],
    dependencies: [],
    completeEvidence: [...REQUIRED_SEMANTIC_REGION_EVIDENCE],
    unsafeReasons: [...unsafeReasons],
  });
  if (plan.regions.length === 0) {
    return {
      plan,
      context,
      contextDigest,
      regions: [],
      evaluationOrder: [],
      regionByFile: new Map(),
    };
  }
  const planned = plan.regions[0]!;
  const regionInputs: SemanticRegionInputV2 = {
    version: SEMANTIC_REGION_INPUT_VERSION,
    regionId: planned.id,
    files: inputs.sourceBlobs.map((blob) => ({ ...blob })),
    programComponent: {
      componentId: `whole-unit-fallback-v${SEMANTIC_REGION_INPUT_VERSION}`,
      componentInput: {
        selectedNodeIds: ["whole-unit"],
        ambientNodeIds: [],
        containsUniversalProviderAggregate: false,
        nodes: [{
          id: "whole-unit",
          canonicalInput: WHOLE_UNIT_FALLBACK_CANONICAL_INPUT,
        }],
        dependencies: [],
      },
      providerComponentKeys: [],
    },
    dependencyRegionKeys: [],
    directExternalProviderKeys: [],
    contextDigest,
  };
  const region: AddressedSemanticRegion = {
    id: planned.id,
    files: [...planned.files],
    dependencyRegionIds: [],
    key: semanticRegionAddress(regionInputs),
    inputs: regionInputs,
  };
  return {
    plan,
    context,
    contextDigest,
    regions: [region],
    evaluationOrder: [region.id],
    regionByFile: new Map(region.files.map((file) => [file, region])),
  };
}

function wholeUnitFallbackContext(
  inputs: UnitInputFingerprint,
  workspaceDigest: string,
  unsafeReasons: readonly string[],
): SemanticRegionContextV2 {
  return {
    version: SEMANTIC_REGION_INPUT_VERSION,
    unit: inputs.unit,
    typescriptConfig: {
      selectedConfigAddress: null,
      selectionProbes: [],
      configFiles: [],
      extendsInputs: [],
      reuseEligibility: {
        eligible: false,
        reasons: uniqueSorted([
          WHOLE_UNIT_FALLBACK_SENTINEL,
          ...unsafeReasons,
        ]),
      },
    },
    unattributedProgramInputs: [],
    unattributedFilesystemInputs: [],
    unattributedModuleResolutions: [],
    unattributedTypeReferenceResolutions: [],
    unattributedResolutionLookupInputs: [],
    compilerOptionsDigest: WHOLE_UNIT_FALLBACK_SENTINEL,
    policy: inputs.policy,
    provenance: inputs.provenance,
    workspaceDigest,
    evidence: REQUIRED_SEMANTIC_REGION_EVIDENCE,
    plannerVersion: SEMANTIC_REGION_PLAN_VERSION,
    programGraphVersion: SEMANTIC_PROGRAM_GRAPH_VERSION,
    compilerObservationVersion: SEMANTIC_COMPILER_OBSERVATION_VERSION,
  };
}

function semanticPlanningUnsafeReasons(
  inputs: UnitInputFingerprint,
  selectedFiles: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  if (!inputs.reuseEligibility.eligible) {
    reasons.push(...inputs.reuseEligibility.reasons.map((reason) => `unit-input:${reason}`));
  }
  const sourceBlobPaths = new Set(inputs.sourceBlobs.map((blob) => blob.path));
  for (const file of selectedFiles) {
    if (!sourceBlobPaths.has(file)) reasons.push(`missing-source-blob:${file}`);
  }
  const selectedProgramPaths = new Set(
    inputs.programInputs
      .filter((input) => input.kind === "unit-source")
      .map((input) => repoPath(input.address))
      .filter((path): path is string => path !== null),
  );
  for (const file of selectedFiles) {
    if (!selectedProgramPaths.has(file)) reasons.push(`missing-program-input:${file}`);
  }
  return uniqueSorted(reasons);
}

interface CompilerModuleResolutionEvidence {
  readonly resolvedModule?: {
    readonly resolvedFileName: string;
  };
}

interface CompilerTypeReferenceResolutionEvidence {
  readonly resolvedTypeReferenceDirective?: {
    readonly resolvedFileName?: string;
  };
}

interface CompilerResolutionEvidenceProgram extends ts.Program {
  forEachResolvedModule?: (
    callback: (
      resolution: CompilerModuleResolutionEvidence,
      specifier: string,
      mode: ts.ResolutionMode,
      containingFile: ts.Path,
    ) => void,
  ) => void;
  forEachResolvedTypeReferenceDirective?: (
    callback: (
      resolution: CompilerTypeReferenceResolutionEvidence,
      specifier: string,
      mode: ts.ResolutionMode,
      containingFile: ts.Path,
    ) => void,
  ) => void;
}

/**
 * The region graph may localize an ordinary module only when the immutable fingerprints exactly
 * cover the resolutions in the current compiler Program. This is an independent, fail-closed
 * reconciliation against the live Program: deleting a fingerprint cannot silently delete an
 * edge. Positive targets outside the Program remain local inputs when their exact tracked blob is
 * bound by the containing node; this path always reconstructs the current Project before looking
 * up a region, so it does not rely on a cached positive resolution.
 */
function validateCompilerResolutionCoverage(input: {
  loaded: LoadedProject;
  inputs: UnitInputFingerprint;
  programInputsByAddress: ReadonlyMap<string, readonly ProgramInputFingerprint[]>;
  dependencies: readonly SemanticProgramDependency[];
  unsafeReasons: string[];
}): void {
  const program = input.loaded.project.getProgram()
    .compilerObject as CompilerResolutionEvidenceProgram;
  const dependencyIds = new Set(input.dependencies.map(
    (dependency) => `${dependency.consumer}\0${dependency.provider}`,
  ));
  const moduleEvidence = resolutionEvidenceCounts(input.inputs.moduleResolutions);
  const typeEvidence = resolutionEvidenceCounts(
    input.inputs.typeReferenceResolutions,
  );

  if (typeof program.forEachResolvedModule !== "function") {
    input.unsafeReasons.push("compiler-module-resolution-evidence-unavailable");
  } else {
    try {
      program.forEachResolvedModule(
        (resolution, specifier, mode, containingFile) => {
          const containingAddress = portableFingerprintAddress(
            input.loaded.root,
            toPosix(containingFile),
          );
          const targetAddress = resolution.resolvedModule === undefined
            ? null
            : portableFingerprintAddress(
              input.loaded.root,
              toPosix(resolution.resolvedModule.resolvedFileName),
            );
          consumeCompilerResolutionEvidence(
            moduleEvidence,
            resolutionEvidenceIdentity(
              containingAddress,
              mode ?? null,
              specifier,
              targetAddress,
            ),
            "module",
            input.unsafeReasons,
          );
        },
      );
    } catch (error) {
      void error;
      input.unsafeReasons.push("compiler-module-resolution-evidence-failed");
    }
  }

  if (typeof program.forEachResolvedTypeReferenceDirective !== "function") {
    input.unsafeReasons.push("compiler-type-reference-evidence-unavailable");
  } else {
    try {
      program.forEachResolvedTypeReferenceDirective(
        (resolution, specifier, mode, containingFile) => {
          const containingAddress = portableFingerprintAddress(
            input.loaded.root,
            toPosix(containingFile),
          );
          const resolvedFileName =
            resolution.resolvedTypeReferenceDirective?.resolvedFileName;
          const targetAddress = resolvedFileName === undefined
            ? null
            : portableFingerprintAddress(
              input.loaded.root,
              toPosix(resolvedFileName),
            );
          consumeCompilerResolutionEvidence(
            typeEvidence,
            resolutionEvidenceIdentity(
              containingAddress,
              mode ?? null,
              specifier,
              targetAddress,
            ),
            "type-reference",
            input.unsafeReasons,
          );
        },
      );
    } catch (error) {
      void error;
      input.unsafeReasons.push("compiler-type-reference-evidence-failed");
    }
  }

  appendUnconsumedResolutionEvidence(
    moduleEvidence,
    "module",
    input.unsafeReasons,
  );
  appendUnconsumedResolutionEvidence(
    typeEvidence,
    "type-reference",
    input.unsafeReasons,
  );

  for (const [kind, resolutions] of [
    ["module", input.inputs.moduleResolutions],
    ["type-reference", input.inputs.typeReferenceResolutions],
  ] as const) {
    for (const resolution of resolutions) {
      // Resolver callbacks not owned by a Program source are retained in the unit-global
      // remainder, so their changes already invalidate every region without a graph edge.
      if (!input.programInputsByAddress.has(resolution.containingFile)) continue;
      if (resolution.target === null) {
        if (!resolution.hasCompleteLookupProof) {
          input.unsafeReasons.push(
            `incomplete-unresolved-${kind}-proof:`
            + `${resolution.containingFile}->${resolution.specifier}`,
          );
        }
        continue;
      }
      if (input.programInputsByAddress.has(resolution.target.address)) {
        if (
          resolution.containingFile !== resolution.target.address
          && !dependencyIds.has(
            `${resolution.containingFile}\0${resolution.target.address}`,
          )
        ) {
          input.unsafeReasons.push(
            `missing-${kind}-dependency-edge:`
            + `${resolution.containingFile}->${resolution.target.address}`,
          );
        }
        continue;
      }
      if (resolution.target.trackedBlobOid === null) {
        input.unsafeReasons.push(
          `unproven-${kind}-target-outside-program:`
          + `${resolution.containingFile}->${resolution.target.address}`,
        );
      }
    }
  }
}

function appendUnconsumedResolutionEvidence(
  counts: ReadonlyMap<string, number>,
  kind: "module" | "type-reference",
  unsafeReasons: string[],
): void {
  let total = 0;
  for (const count of counts.values()) total += count;
  if (total > 0) {
    unsafeReasons.push(
      `unobserved-fingerprinted-${kind}-resolutions:${total}`,
    );
  }
}

function resolutionEvidenceCounts(
  resolutions: readonly (
    ModuleResolutionFingerprint | TypeReferenceResolutionFingerprint
  )[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const resolution of resolutions) {
    const identity = resolutionEvidenceIdentity(
      resolution.containingFile,
      resolution.mode,
      resolution.specifier,
      resolution.target?.address ?? null,
    );
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return counts;
}

function resolutionEvidenceIdentity(
  containingFile: string,
  mode: number | null,
  specifier: string,
  targetAddress: string | null,
): string {
  return canonicalJson([containingFile, mode, specifier, targetAddress]);
}

function consumeCompilerResolutionEvidence(
  counts: Map<string, number>,
  identity: string,
  kind: "module" | "type-reference",
  unsafeReasons: string[],
): void {
  const count = counts.get(identity) ?? 0;
  if (count === 0) {
    unsafeReasons.push(`unmapped-compiler-${kind}-resolution:${identity}`);
  } else if (count === 1) {
    counts.delete(identity);
  } else {
    counts.set(identity, count - 1);
  }
}

function groupedSpecifierSet(
  resolutions: readonly TypeReferenceResolutionFingerprint[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const resolution of resolutions) {
    const specifiers = result.get(resolution.containingFile);
    if (specifiers === undefined) {
      result.set(resolution.containingFile, new Set([resolution.specifier]));
    } else {
      specifiers.add(resolution.specifier);
    }
  }
  return result;
}

function defaultLibraryAddresses(
  loaded: LoadedProject,
  program: ts.Program,
  unsafeReasons: string[],
): ReadonlyMap<string, string | null> {
  const result = new Map<string, string | null>();
  for (const sourceFile of program.getSourceFiles()) {
    if (!program.isSourceFileDefaultLibrary(sourceFile)) continue;
    const normalizedPath = toPosix(sourceFile.fileName);
    const name = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1)
      .toLowerCase();
    const address = portableFingerprintAddress(loaded.root, normalizedPath);
    if (result.has(name)) {
      result.set(name, null);
      unsafeReasons.push(`duplicate-default-library-name:${name}`);
    } else {
      result.set(name, address);
    }
  }
  return result;
}

function fingerprintCatalog<T>(
  inputs: readonly T[],
  keyOf: (input: T) => string,
  label: string,
  unsafeReasons: string[],
): Map<string, T> {
  const catalog = new Map<string, T>();
  for (const input of inputs) {
    const key = keyOf(input);
    const existing = catalog.get(key);
    if (existing !== undefined) {
      unsafeReasons.push(
        canonicalJson(existing) === canonicalJson(input)
          ? `duplicate-${label}:${key}`
          : `${label}-content-address-collision:${key}`,
      );
      continue;
    }
    catalog.set(key, input);
  }
  return catalog;
}

function resolutionLookupKeysForOwner(
  proofKey: string,
  catalog: ReadonlyMap<string, ResolutionLookupProofFingerprint>,
  referenced: Set<string>,
  owner: string,
  unsafeReasons: string[],
): string[] {
  referenced.add(proofKey);
  const proof = catalog.get(proofKey);
  if (proof === undefined) {
    unsafeReasons.push(`missing-resolution-lookup-proof:${owner}:${proofKey}`);
    return [];
  }
  const canonicalKeys = uniqueSorted(proof.resolutionLookupInputKeys);
  if (canonicalJson(canonicalKeys) !== canonicalJson(proof.resolutionLookupInputKeys)) {
    unsafeReasons.push(`malformed-resolution-lookup-proof:${owner}:${proofKey}`);
  }
  return canonicalKeys;
}

function validateFingerprintKeys<T>(
  keys: readonly string[],
  catalog: ReadonlyMap<string, T>,
  referenced: Set<string>,
  label: string,
  unsafeReasons: string[],
): void {
  for (const key of keys) {
    referenced.add(key);
    if (!catalog.has(key)) {
      unsafeReasons.push(`missing-${label}:${key}`);
    }
  }
}

function groupedBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) addGrouped(result, keyOf(value), value);
  return result;
}

function addGrouped<T>(map: Map<string, T[]>, key: string, value: T): void {
  const entries = map.get(key);
  if (entries === undefined) map.set(key, [value]);
  else entries.push(value);
}

function sortCanonical<T>(values: readonly T[]): T[] {
  return values
    .map((value) => ({ key: canonicalJson(value), value }))
    .sort((left, right) => compareCanonicalStrings(left.key, right.key))
    .map(({ value }) => value);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCanonicalStrings);
}

function repoPath(address: string): string | null {
  return address.startsWith("repo:") ? address.slice("repo:".length) : null;
}

function semanticRegionAddress(inputs: SemanticRegionInputV2): string {
  return canonicalJsonSha256({
    kind: "typescript-semantic-region-input",
    inputs,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Used by focused tests and diagnostics without exposing portable-address parsing elsewhere. */
export function semanticRegionFileForSource(
  loaded: LoadedProject,
  sourceFile: SourceFile,
): string {
  return relativeToRoot(loaded.root, sourceFile.getFilePath());
}
