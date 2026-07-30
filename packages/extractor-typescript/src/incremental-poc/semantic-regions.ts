/**
 * Pure planner for a future finer-grained TypeScript shard experiment.
 *
 * An edge means "consumer output may depend on provider semantics". Strongly-connected files
 * therefore form one indivisible region; the condensation graph remains directed so a provider
 * change invalidates its consumers without invalidating providers when only a consumer changes.
 *
 * This module deliberately does not discover edges. Partitioning is allowed only when the caller
 * proves that every compiler/extractor cross-file read class below was observed. Until extraction
 * can supply that evidence, callers get one conservative whole-unit region.
 *
 * A region cache key must include:
 *   - the region's exact source blobs;
 *   - the cache keys of its direct dependency regions (in evaluation order);
 *   - its exact config/compiler, resolution-lookup, policy, and provenance inputs; and
 *   - this planner version.
 *
 * Recursive dependency keys make transitive implementation changes invalidate consumers without
 * pretending that a declaration-only/API hash captures every extractor behavior.
 */

import { canonicalJsonSha256, compareCanonicalStrings } from "./canonical-json";

export const SEMANTIC_REGION_PLAN_VERSION = 1 as const;

export const REQUIRED_SEMANTIC_REGION_EVIDENCE = [
  "ambient-and-augmentation-scope",
  "extractor-cross-file-reads",
  "module-resolution",
  "resolution-lookup-inputs",
  "symbol-and-type-reads",
  "type-reference-resolution",
] as const;

export type SemanticRegionEvidence =
  typeof REQUIRED_SEMANTIC_REGION_EVIDENCE[number];

export type SemanticDependencyKind =
  | "module-resolution"
  | "type-reference-resolution"
  | "symbol-declaration"
  | "type-read"
  | "extractor-value-flow"
  | "ambient-or-augmentation";

export interface SemanticDependency {
  /** File whose extracted contribution may change. */
  consumer: string;
  /** File whose semantics may influence the consumer. */
  provider: string;
  kind: SemanticDependencyKind;
}

export interface SemanticRegionPlanningInput {
  /** Exact selected source-file universe for one existing package/unit. */
  files: string[];
  dependencies: SemanticDependency[];
  /** Proof obligations completed by dependency discovery for this exact compiler program. */
  completeEvidence: SemanticRegionEvidence[];
  /**
   * Fail-closed discoveries such as an unsupported ambient declaration or an extractor query
   * whose declaration reads could not be attributed to files.
   */
  unsafeReasons?: string[];
}

export interface SemanticRegion {
  id: string;
  files: string[];
  /** Direct providers. Their cache keys, not merely their region ids, belong in this key. */
  dependencyRegionIds: string[];
}

export interface SemanticRegionPlan {
  version: typeof SEMANTIC_REGION_PLAN_VERSION;
  kind: "partitioned" | "whole-unit-fallback";
  reasons: string[];
  regions: SemanticRegion[];
  /** Dependencies before consumers; suitable for recursive cache-key/materialization order. */
  evaluationOrder: string[];
}

export interface SemanticRegionInvalidation {
  rebuildRegionIds: string[];
  reusableRegionIds: string[];
  /** Present when an unknown/deleted path forced whole-unit invalidation. */
  reason: "changed-file-outside-target-plan" | null;
}

export function planSemanticRegions(
  input: SemanticRegionPlanningInput,
): SemanticRegionPlan {
  const files = canonicalFiles(input.files);
  const dependencies = canonicalDependencies(input.dependencies, new Set(files));
  const reasons = fallbackReasons(input);
  if (reasons.length > 0) {
    const region = makeRegion(files, []);
    return {
      version: SEMANTIC_REGION_PLAN_VERSION,
      kind: "whole-unit-fallback",
      reasons,
      regions: files.length === 0 ? [] : [region],
      evaluationOrder: files.length === 0 ? [] : [region.id],
    };
  }

  const adjacency = dependencyAdjacency(files, dependencies);
  const components = stronglyConnectedComponents(files, adjacency)
    .map((component) => component.sort(compareCanonicalStrings))
    .sort(compareStringArrays);
  const regionByFile = new Map<string, SemanticRegion>();
  const regions = components.map((component) => {
    const region = makeRegion(component, []);
    for (const file of component) regionByFile.set(file, region);
    return region;
  });

  const dependenciesByRegion = new Map(regions.map((region) => [
    region.id,
    new Set<string>(),
  ]));
  for (const dependency of dependencies) {
    const consumer = requireRegion(regionByFile, dependency.consumer);
    const provider = requireRegion(regionByFile, dependency.provider);
    if (consumer.id !== provider.id) {
      dependenciesByRegion.get(consumer.id)!.add(provider.id);
    }
  }
  for (const region of regions) {
    region.dependencyRegionIds = [...dependenciesByRegion.get(region.id)!]
      .sort(compareCanonicalStrings);
  }

  return {
    version: SEMANTIC_REGION_PLAN_VERSION,
    kind: "partitioned",
    reasons: [],
    regions,
    evaluationOrder: dependencyFirstOrder(regions),
  };
}

/**
 * Rebuild changed regions and their reverse-transitive consumers. A path absent from the target
 * plan commonly means a deletion; without the base plan's dependency evidence, invalidate all.
 */
export function planSemanticRegionInvalidation(
  plan: SemanticRegionPlan,
  changedFiles: readonly string[],
): SemanticRegionInvalidation {
  const changed = [...new Set(changedFiles)].sort(compareCanonicalStrings);
  if (changed.length === 0) {
    return {
      rebuildRegionIds: [],
      reusableRegionIds: [...plan.evaluationOrder],
      reason: null,
    };
  }

  const regionByFile = new Map<string, string>();
  for (const region of plan.regions) {
    for (const file of region.files) regionByFile.set(file, region.id);
  }
  if (changed.some((file) => !regionByFile.has(file))) {
    return {
      rebuildRegionIds: [...plan.evaluationOrder],
      reusableRegionIds: [],
      reason: "changed-file-outside-target-plan",
    };
  }

  const consumersByProvider = new Map<string, Set<string>>(
    plan.regions.map((region) => [region.id, new Set()]),
  );
  for (const region of plan.regions) {
    for (const provider of region.dependencyRegionIds) {
      const consumers = consumersByProvider.get(provider);
      if (consumers === undefined) {
        throw new Error(`semantic region depends on an unknown provider: ${provider}`);
      }
      consumers.add(region.id);
    }
  }

  const rebuild = new Set(changed.map((file) => regionByFile.get(file)!));
  const pending = [...rebuild];
  while (pending.length > 0) {
    const provider = pending.pop()!;
    for (const consumer of consumersByProvider.get(provider) ?? []) {
      if (!rebuild.has(consumer)) {
        rebuild.add(consumer);
        pending.push(consumer);
      }
    }
  }
  return {
    rebuildRegionIds: plan.evaluationOrder.filter((id) => rebuild.has(id)),
    reusableRegionIds: plan.evaluationOrder.filter((id) => !rebuild.has(id)),
    reason: null,
  };
}

function fallbackReasons(input: SemanticRegionPlanningInput): string[] {
  const evidence = new Set(input.completeEvidence);
  const reasons = REQUIRED_SEMANTIC_REGION_EVIDENCE
    .filter((required) => !evidence.has(required))
    .map((missing) => `missing-evidence:${missing}`);
  for (const reason of input.unsafeReasons ?? []) {
    const normalized = reason.trim();
    if (normalized.length > 0) reasons.push(`unsafe:${normalized}`);
  }
  return [...new Set(reasons)].sort(compareCanonicalStrings);
}

function canonicalFiles(files: readonly string[]): string[] {
  const result = [...files].sort(compareCanonicalStrings);
  for (const [index, file] of result.entries()) {
    if (!isCanonicalRelativePath(file)) {
      throw new TypeError(`semantic region file must be root-relative POSIX: ${file}`);
    }
    if (index > 0 && result[index - 1] === file) {
      throw new TypeError(`duplicate semantic region file: ${file}`);
    }
  }
  return result;
}

function canonicalDependencies(
  dependencies: readonly SemanticDependency[],
  files: ReadonlySet<string>,
): SemanticDependency[] {
  const byIdentity = new Map<string, SemanticDependency>();
  for (const dependency of dependencies) {
    if (!files.has(dependency.consumer) || !files.has(dependency.provider)) {
      throw new TypeError(
        `semantic dependency endpoint is outside the selected unit: `
        + `${dependency.consumer} -> ${dependency.provider}`,
      );
    }
    const identity = [
      dependency.consumer,
      dependency.provider,
      dependency.kind,
    ].join("\0");
    byIdentity.set(identity, { ...dependency });
  }
  return [...byIdentity.values()].sort((left, right) => (
    compareCanonicalStrings(dependencyIdentity(left), dependencyIdentity(right))
  ));
}

function dependencyIdentity(dependency: SemanticDependency): string {
  return [
    dependency.consumer,
    dependency.provider,
    dependency.kind,
  ].join("\0");
}

function dependencyAdjacency(
  files: readonly string[],
  dependencies: readonly SemanticDependency[],
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map(files.map((file) => [file, new Set<string>()]));
  for (const dependency of dependencies) {
    adjacency.get(dependency.consumer)!.add(dependency.provider);
  }
  return new Map([...adjacency].map(([file, providers]) => [
    file,
    [...providers].sort(compareCanonicalStrings),
  ]));
}

/** Iterative Kosaraju avoids a call-stack bound on a several-thousand-file package. */
function stronglyConnectedComponents(
  files: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const file of files) {
    if (visited.has(file)) continue;
    visited.add(file);
    const stack: Array<{ file: string; next: number }> = [{ file, next: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const neighbors = adjacency.get(frame.file) ?? [];
      const neighbor = neighbors[frame.next];
      if (neighbor !== undefined) {
        frame.next += 1;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push({ file: neighbor, next: 0 });
        }
      } else {
        finishOrder.push(frame.file);
        stack.pop();
      }
    }
  }

  const reverse = new Map(files.map((file) => [file, [] as string[]]));
  for (const [consumer, providers] of adjacency) {
    for (const provider of providers) reverse.get(provider)!.push(consumer);
  }
  reverse.forEach((consumers) => consumers.sort(compareCanonicalStrings));

  const assigned = new Set<string>();
  const components: string[][] = [];
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const root = finishOrder[index]!;
    if (assigned.has(root)) continue;
    assigned.add(root);
    const component: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const file = pending.pop()!;
      component.push(file);
      for (const consumer of reverse.get(file) ?? []) {
        if (!assigned.has(consumer)) {
          assigned.add(consumer);
          pending.push(consumer);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function dependencyFirstOrder(regions: readonly SemanticRegion[]): string[] {
  const regionById = new Map(regions.map((region) => [region.id, region]));
  const remainingDependencies = new Map(regions.map((region) => [
    region.id,
    region.dependencyRegionIds.length,
  ]));
  const consumersByProvider = new Map(regions.map((region) => [
    region.id,
    [] as string[],
  ]));
  for (const region of regions) {
    for (const provider of region.dependencyRegionIds) {
      if (!regionById.has(provider)) {
        throw new Error(`semantic region depends on an unknown provider: ${provider}`);
      }
      consumersByProvider.get(provider)!.push(region.id);
    }
  }
  consumersByProvider.forEach((consumers) => consumers.sort(compareCanonicalStrings));

  const ready = [...remainingDependencies]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort(compareCanonicalStrings);
  const order: string[] = [];
  while (ready.length > 0) {
    const provider = ready.shift()!;
    order.push(provider);
    for (const consumer of consumersByProvider.get(provider) ?? []) {
      const remaining = remainingDependencies.get(consumer)! - 1;
      remainingDependencies.set(consumer, remaining);
      if (remaining === 0) {
        insertSorted(ready, consumer);
      }
    }
  }
  if (order.length !== regions.length) {
    throw new Error("semantic region condensation graph unexpectedly contains a cycle");
  }
  return order;
}

function insertSorted(values: string[], value: string): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareCanonicalStrings(values[middle]!, value) < 0) low = middle + 1;
    else high = middle;
  }
  values.splice(low, 0, value);
}

function makeRegion(files: string[], dependencyRegionIds: string[]): SemanticRegion {
  return {
    id: `semantic-region-v${SEMANTIC_REGION_PLAN_VERSION}:${
      canonicalJsonSha256({ files })
    }`,
    files: [...files],
    dependencyRegionIds,
  };
}

function requireRegion(
  byFile: ReadonlyMap<string, SemanticRegion>,
  file: string,
): SemanticRegion {
  const region = byFile.get(file);
  if (region === undefined) {
    throw new Error(`semantic region is missing selected file: ${file}`);
  }
  return region;
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareCanonicalStrings(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function isCanonicalRelativePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.includes("\0")
    && path.split("/").every((segment) => (
      segment.length > 0 && segment !== "." && segment !== ".."
    ));
}
