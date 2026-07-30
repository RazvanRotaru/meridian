/**
 * Mixed hit/miss execution for one already-loaded TypeScript unit.
 *
 * Cache discovery happens before the canonical pass schedule. The canonical contribution pipeline
 * then skips only semantic files backed by exact region hits; structure, implementation members,
 * Promise resources, flows, ports, target ordering, and final stitching remain fresh. Every fresh
 * miss crosses the same strict contribution codec as a hit before materialization.
 */

import type {
  ExtractOptions,
  ExtractionDepth,
  ExtractionProgressPosition,
} from "@meridian/core";
import type { CrossPackageResolver } from "../edge-resolve";
import type { UnitExtraction } from "../extract-per-package";
import type { LoadedProject } from "../project-loader";
import type { ExtractionProgressReporter } from "../progress";
import {
  extractLoadedUnitContributions,
  materializeUnitContributionSetV1,
  replaceUnitSemanticFileContributions,
  type UnitContributionSetV1,
  type UnitSemanticFileContributionV1,
} from "../unit-contributions";
import type { WorkspaceUnit } from "../workspace-units";
import type { RevisionShardAdmissionCapability } from "./admission";
import { canonicalJsonSha256 } from "./canonical-json";
import type { UnitInputFingerprint } from "./model";
import {
  createPendingSemanticRegionShard,
  publishPendingSemanticRegionShard,
  publishSemanticRegionContext,
  readSemanticRegionShard,
  semanticRegionContextMatches,
  semanticRegionContextRecord,
  type PendingSemanticRegionShard,
  type SemanticRegionCacheLimits,
  type SemanticRegionShardHit,
  type StoredSemanticRegionContextV2,
} from "./semantic-region-cache";
import {
  isSemanticRegionLimitError,
  type SemanticRegionLimitError,
} from "./semantic-region-codec";
import {
  addressSemanticRegions,
  type AddressedSemanticRegion,
  type AddressedSemanticRegionPlan,
} from "./semantic-region-inputs";

// A valid region hit crosses a bounded clone plus the unit codec. Keep concurrent peak memory
// bounded even when a cache contains unusually large (but still permitted) region payloads.
const CACHE_IO_CONCURRENCY = 4;

export interface SemanticRegionExtractionCacheAccess {
  persistentCacheDir: string;
  pairCacheDir: string | null;
  requiredAdmission?: RevisionShardAdmissionCapability;
  /** Narrow production resource ceilings in focused tests without changing cache identity. */
  limits?: SemanticRegionCacheLimits;
}

export interface SemanticRegionExtractionMetrics {
  planKind: AddressedSemanticRegionPlan["plan"]["kind"];
  fallbackReasons: string[];
  totalRegions: number;
  reusedRegions: number;
  rebuiltRegions: number;
  reuseRatio: number;
  totalSourceBytes: number;
  reusedSourceBytes: number;
  byteReuseRatio: number;
}

export interface SemanticRegionExtractionEvidence {
  unitId: string;
  regionId: string;
  key: string;
  baseInputKey: string;
  payloadDigest: string;
  value: SemanticRegionShardHit["value"];
  reused: boolean;
}

export interface SemanticRegionUnitExtraction {
  extraction: UnitExtraction;
  contributions: UnitContributionSetV1;
  plan: AddressedSemanticRegionPlan;
  context: StoredSemanticRegionContextV2 | null;
  pendingRegions: PendingSemanticRegionShard[];
  regionEvidence: SemanticRegionExtractionEvidence[];
  metrics: SemanticRegionExtractionMetrics;
}

export interface SemanticRegionExtractionInputs {
  unit: WorkspaceUnit;
  loaded: LoadedProject;
  options: ExtractOptions;
  resolver: CrossPackageResolver;
  depth: ExtractionDepth;
  unitInputs: UnitInputFingerprint;
  workspaceDigest: string;
  addressedPlan?: AddressedSemanticRegionPlan;
  cache: SemanticRegionExtractionCacheAccess;
  progressUnit?: ExtractionProgressPosition;
  progressReporter?: ExtractionProgressReporter;
}

export async function extractLoadedUnitWithSemanticRegions(
  inputs: SemanticRegionExtractionInputs,
): Promise<SemanticRegionUnitExtraction> {
  const plan = inputs.addressedPlan ?? addressSemanticRegions({
    loaded: inputs.loaded,
    unitInputs: inputs.unitInputs,
    workspaceDigest: inputs.workspaceDigest,
  });
  const sourceBytesByFile = new Map(
    inputs.unitInputs.sourceBlobs.map((blob) => [blob.path, blob.byteSize]),
  );
  const totalSourceBytes = inputs.unitInputs.sourceBlobs.reduce(
    (total, blob) => total + blob.byteSize,
    0,
  );
  const cacheLimits = inputs.cache.limits ?? {};

  // An incomplete proof never partially consumes this cache. It uses the same contribution
  // pipeline with an empty semantic map, which is the canonical cold path.
  if (
    plan.plan.kind !== "partitioned"
    || !inputs.unitInputs.reuseEligibility.eligible
  ) {
    return canonicalWholeUnitFallback(
      inputs,
      plan,
      totalSourceBytes,
      [...plan.plan.reasons],
      plan.plan.kind,
    );
  }

  let context: StoredSemanticRegionContextV2;
  try {
    context = semanticRegionContextRecord(
      plan.context,
      plan.contextDigest,
      cacheLimits,
    );
  } catch (error) {
    if (!isSemanticRegionLimitError(error)) throw error;
    return canonicalLimitFallback(inputs, plan, totalSourceBytes, error);
  }
  const [persistentContextAvailable, pairContextAvailable] = await Promise.all([
    semanticRegionContextMatches(
      inputs.cache.persistentCacheDir,
      plan.context,
      plan.contextDigest,
      cacheLimits,
    ),
    inputs.cache.pairCacheDir === null
      ? Promise.resolve(false)
      : semanticRegionContextMatches(
          inputs.cache.pairCacheDir,
          plan.context,
          plan.contextDigest,
          cacheLimits,
        ),
  ]);
  const hits = await mapConcurrent(plan.regions, CACHE_IO_CONCURRENCY, async (region) => {
    if (persistentContextAvailable) {
      const persistent = await readSemanticRegionShard(
        inputs.cache.persistentCacheDir,
        region,
        inputs.cache.requiredAdmission,
        cacheLimits,
      );
      if (persistent !== null) return { region, hit: persistent, source: "persistent" as const };
    }
    if (pairContextAvailable && inputs.cache.pairCacheDir !== null) {
      const pair = await readSemanticRegionShard(
        inputs.cache.pairCacheDir,
        region,
        undefined,
        cacheLimits,
      );
      if (pair !== null) return { region, hit: pair, source: "pair" as const };
    }
    return { region, hit: null, source: null };
  });
  const hitByRegionId = new Map(
    hits
      .filter((entry): entry is {
        region: AddressedSemanticRegion;
        hit: SemanticRegionShardHit;
        source: "persistent" | "pair";
      } => entry.hit !== null)
      .map((entry) => [entry.region.id, entry.hit]),
  );
  const hitSourceByRegionId = new Map(
    hits
      .filter((entry): entry is {
        region: AddressedSemanticRegion;
        hit: SemanticRegionShardHit;
        source: "persistent" | "pair";
      } => entry.hit !== null)
      .map((entry) => [entry.region.id, entry.source]),
  );
  const reusedSemanticFiles = semanticFilesFromHits(plan, hitByRegionId);

  const builtContributions = extractLoadedUnitContributions(
    inputs.unit,
    inputs.loaded,
    inputs.options,
    inputs.resolver,
    inputs.depth,
    inputs.progressUnit,
    inputs.progressReporter,
    reusedSemanticFiles,
  );
  const contributionByFile = new Map(
    builtContributions.files.map((file) => [file.file, file]),
  );
  const pendingRegions: PendingSemanticRegionShard[] = [];
  const normalizedSemanticFiles = new Map<string, UnitSemanticFileContributionV1>(
    reusedSemanticFiles,
  );
  const regionEvidence: SemanticRegionExtractionEvidence[] = [];

  for (const region of plan.regions) {
    const hit = hitByRegionId.get(region.id);
    if (hit !== undefined) {
      if (hitSourceByRegionId.get(region.id) === "pair") {
        // The request owner deletes the pair exchange after both revisions settle. Retain the exact
        // detached envelope so generic/shadow publication can copy the hit into persistent storage.
        pendingRegions.push({
          key: hit.key,
          baseInputKey: hit.baseInputKey,
          value: hit.value,
        });
      }
      regionEvidence.push({
        unitId: inputs.unit.dir || ".",
        regionId: region.id,
        key: hit.key,
        baseInputKey: hit.baseInputKey,
        payloadDigest: hit.payloadDigest,
        value: hit.value,
        reused: true,
      });
      continue;
    }
    const regionFileSet = new Set(region.files);
    const targetOrderedFiles = builtContributions.fileOrder
      .filter((file) => regionFileSet.has(file))
      .map((file) => {
        const contribution = contributionByFile.get(file);
        if (contribution === undefined) {
          throw new Error(`semantic-region miss lacks a target contribution: ${file}`);
        }
        return contribution;
      });
    let pending: PendingSemanticRegionShard;
    try {
      pending = createPendingSemanticRegionShard(
        region,
        targetOrderedFiles,
        cacheLimits,
      );
    } catch (error) {
      if (!isSemanticRegionLimitError(error)) throw error;
      return canonicalLimitFallback(inputs, plan, totalSourceBytes, error);
    }
    pendingRegions.push(pending);
    for (const file of pending.value.contributions.files) {
      const fresh = contributionByFile.get(file.file);
      if (fresh === undefined) {
        throw new Error(`semantic-region normalized miss lost target imports: ${file.file}`);
      }
      normalizedSemanticFiles.set(file.file, {
        ...file,
        importEdges: [...fresh.importEdges],
      });
    }
    regionEvidence.push({
      unitId: inputs.unit.dir || ".",
      regionId: region.id,
      key: pending.key,
      baseInputKey: pending.baseInputKey,
      payloadDigest: canonicalJsonSha256(pending.value),
      value: pending.value,
      reused: false,
    });
  }

  // Pair exchange publication is request-private and immediate so a sequential merge-base build
  // can seed the PR HEAD. Persistent publication remains owned by the caller's shadow/admission
  // transaction.
  if (inputs.cache.pairCacheDir !== null && pendingRegions.length > 0) {
    try {
      await publishSemanticRegionContext(
        inputs.cache.pairCacheDir,
        context,
        false,
        cacheLimits,
      );
      await mapConcurrent(
        pendingRegions,
        CACHE_IO_CONCURRENCY,
        (pending) => publishPendingSemanticRegionShard(
          inputs.cache.pairCacheDir!,
          pending,
          undefined,
          cacheLimits,
        ),
      );
    } catch (error) {
      if (!isSemanticRegionLimitError(error)) throw error;
      return canonicalLimitFallback(inputs, plan, totalSourceBytes, error);
    }
  }

  const contributions = replaceUnitSemanticFileContributions(
    builtContributions,
    normalizedSemanticFiles,
  );
  const reusedRegions = hitByRegionId.size;
  const reusedFiles = new Set(
    [...hitByRegionId.keys()].flatMap((regionId) => {
      const region = plan.regions.find((candidate) => candidate.id === regionId);
      return region?.files ?? [];
    }),
  );
  const reusedSourceBytes = [...reusedFiles].reduce(
    (total, file) => total + (sourceBytesByFile.get(file) ?? 0),
    0,
  );
  return {
    extraction: materializeUnitContributionSetV1(contributions),
    contributions,
    plan,
    context,
    pendingRegions,
    regionEvidence,
    metrics: {
      planKind: plan.plan.kind,
      fallbackReasons: [],
      totalRegions: plan.regions.length,
      reusedRegions,
      rebuiltRegions: plan.regions.length - reusedRegions,
      reuseRatio: plan.regions.length === 0 ? 0 : reusedRegions / plan.regions.length,
      totalSourceBytes,
      reusedSourceBytes,
      byteReuseRatio: totalSourceBytes === 0 ? 0 : reusedSourceBytes / totalSourceBytes,
    },
  };
}

function canonicalLimitFallback(
  inputs: SemanticRegionExtractionInputs,
  plan: AddressedSemanticRegionPlan,
  totalSourceBytes: number,
  error: SemanticRegionLimitError,
): SemanticRegionUnitExtraction {
  return canonicalWholeUnitFallback(
    inputs,
    plan,
    totalSourceBytes,
    [`semantic-region-limit:${error.boundary}:${error.limit}`],
    "whole-unit-fallback",
  );
}

function canonicalWholeUnitFallback(
  inputs: SemanticRegionExtractionInputs,
  plan: AddressedSemanticRegionPlan,
  totalSourceBytes: number,
  fallbackReasons: string[],
  planKind: AddressedSemanticRegionPlan["plan"]["kind"],
): SemanticRegionUnitExtraction {
  // This deliberately reruns the exact contribution pipeline with no cached lanes. A limit may
  // be discovered after earlier regions were hits, so returning the partially skipped pass would
  // not be a canonical whole-unit fallback.
  const contributions = extractLoadedUnitContributions(
    inputs.unit,
    inputs.loaded,
    inputs.options,
    inputs.resolver,
    inputs.depth,
    inputs.progressUnit,
    inputs.progressReporter,
  );
  return {
    extraction: materializeUnitContributionSetV1(contributions),
    contributions,
    plan,
    context: null,
    pendingRegions: [],
    regionEvidence: [],
    metrics: {
      planKind,
      fallbackReasons,
      totalRegions: plan.regions.length,
      reusedRegions: 0,
      rebuiltRegions: plan.regions.length,
      reuseRatio: 0,
      totalSourceBytes,
      reusedSourceBytes: 0,
      byteReuseRatio: 0,
    },
  };
}

function semanticFilesFromHits(
  plan: AddressedSemanticRegionPlan,
  hits: ReadonlyMap<string, SemanticRegionShardHit>,
): Map<string, UnitSemanticFileContributionV1> {
  const files = new Map<string, UnitSemanticFileContributionV1>();
  for (const region of plan.regions) {
    const hit = hits.get(region.id);
    if (hit === undefined) continue;
    for (const contribution of hit.files) {
      if (files.has(contribution.file)) {
        throw new Error(`semantic-region hits overlap target file: ${contribution.file}`);
      }
      files.set(contribution.file, contribution);
    }
  }
  return files;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        results[index] = await map(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
