import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCrossPackageResolver } from "../extract-per-package";
import { perPackageWorkspace } from "../extractor";
import { loadUnitProject } from "../project-loader";
import {
  extractLoadedUnitContributions,
  materializeUnitContributionSetV1,
} from "../unit-contributions";
import {
  analysisPolicy,
  extractOptions,
  extractorProvenance,
  unitInputFingerprint,
  workspaceDigest,
} from "./fingerprints";
import {
  createGitMonorepoFixture,
  type GitMonorepoFixture,
} from "./git-fixture";
import { listGitTreeBlobs, verifyGitTreeInputs } from "./git-tree";
import { writeImmutableJsonCache } from "./immutable-cache";
import {
  createPendingSemanticRegionShard,
  publishPendingSemanticRegionShard,
  publishSemanticRegionContext,
  semanticRegionContextRecord,
  type SemanticRegionCacheLimits,
} from "./semantic-region-cache";
import { SemanticRegionLimitError } from "./semantic-region-codec";
import { extractLoadedUnitWithSemanticRegions } from "./semantic-region-extraction";
import { addressSemanticRegions } from "./semantic-region-inputs";
import { fixtureRequest } from "./test-support";

describe("semantic-region extraction availability fallback", { timeout: 120_000 }, () => {
  let fixture: GitMonorepoFixture;

  beforeEach(() => {
    fixture = createGitMonorepoFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it.each([
    {
      boundary: "context cache entry",
      limits: { maxContextEntryBytes: 512 },
      reason: "semantic-region-limit:cache-context-entry-bytes:512",
    },
    {
      boundary: "contribution codec",
      limits: { maxContributionBytes: 1 },
      reason: "semantic-region-limit:codec-payload-bytes:1",
    },
    {
      boundary: "shard cache entry",
      limits: { maxShardEntryBytes: 512 },
      reason: "semantic-region-limit:cache-shard-entry-bytes:512",
    },
  ] satisfies Array<{
    boundary: string;
    limits: SemanticRegionCacheLimits;
    reason: string;
  }>)(
    "uses an evidence-free canonical unit build when a fresh $boundary exceeds its limit",
    async ({ limits, reason }) => {
      const prepared = await prepareProviderUnit(fixture);
      const pairCacheDir = join(fixture.cacheDir, "pair-limit-fallback");
      mkdirSync(pairCacheDir, { recursive: true });
      const canonical = materializeUnitContributionSetV1(
        extractLoadedUnitContributions(
          prepared.unit,
          prepared.loaded,
          prepared.options,
          prepared.resolver,
          prepared.policy.depth,
        ),
      );

      const result = await extractLoadedUnitWithSemanticRegions({
        unit: prepared.unit,
        loaded: prepared.loaded,
        options: prepared.options,
        resolver: prepared.resolver,
        depth: prepared.policy.depth,
        unitInputs: prepared.unitInputs,
        workspaceDigest: prepared.workspaceHash,
        cache: {
          persistentCacheDir: fixture.cacheDir,
          pairCacheDir,
          limits,
        },
      });

      expect(result.extraction).toStrictEqual(canonical);
      expect(result.context).toBeNull();
      expect(result.pendingRegions).toEqual([]);
      expect(result.regionEvidence).toEqual([]);
      expect(result.metrics).toMatchObject({
        planKind: "whole-unit-fallback",
        fallbackReasons: [reason],
        reusedRegions: 0,
        reusedSourceBytes: 0,
        reuseRatio: 0,
        byteReuseRatio: 0,
      });
      expect(result.metrics.rebuiltRegions).toBe(result.metrics.totalRegions);
      expect(existsSync(join(pairCacheDir, "semantic-region-contexts"))).toBe(false);
      expect(existsSync(join(pairCacheDir, "semantic-region-shards"))).toBe(false);
    },
  );

  it("enforces the context read ceiling before publication writes any bytes", async () => {
    const prepared = await prepareProviderUnit(fixture);
    const pairCacheDir = join(fixture.cacheDir, "pair-context-publication-limit");
    mkdirSync(pairCacheDir, { recursive: true });
    const plan = addressSemanticRegions({
      loaded: prepared.loaded,
      unitInputs: prepared.unitInputs,
      workspaceDigest: prepared.workspaceHash,
    });
    const record = semanticRegionContextRecord(plan.context, plan.contextDigest);
    let limitError: unknown;
    try {
      await publishSemanticRegionContext(
        pairCacheDir,
        record,
        false,
        { maxContextEntryBytes: 512 },
      );
    } catch (error) {
      limitError = error;
    }

    expect(limitError).toBeInstanceOf(SemanticRegionLimitError);
    expect(limitError).toMatchObject({
      boundary: "cache-context-entry-bytes",
      limit: 512,
    });
    expect(existsSync(join(pairCacheDir, "semantic-region-contexts"))).toBe(false);
  });

  it("keeps compiler cycles independently file-addressed within a one-file ceiling", async () => {
    fixture.writeFile(
      "packages/provider/src/cycle-a.ts",
      [
        'import { cycleB } from "./cycle-b";',
        "export const cycleA: number = cycleB;",
        "",
      ].join("\n"),
    );
    fixture.writeFile(
      "packages/provider/src/cycle-b.ts",
      [
        'import { cycleA } from "./cycle-a";',
        "export const cycleB: number = cycleA;",
        "",
      ].join("\n"),
    );
    fixture.commit("prepare a two-file semantic SCC");
    const prepared = await prepareProviderUnit(fixture);
    const pairCacheDir = join(fixture.cacheDir, "pair-region-file-limit");
    mkdirSync(pairCacheDir, { recursive: true });
    const canonical = materializeUnitContributionSetV1(
      extractLoadedUnitContributions(
        prepared.unit,
        prepared.loaded,
        prepared.options,
        prepared.resolver,
        prepared.policy.depth,
      ),
    );

    const result = await extractLoadedUnitWithSemanticRegions({
      unit: prepared.unit,
      loaded: prepared.loaded,
      options: prepared.options,
      resolver: prepared.resolver,
      depth: prepared.policy.depth,
      unitInputs: prepared.unitInputs,
      workspaceDigest: prepared.workspaceHash,
      cache: {
        persistentCacheDir: fixture.cacheDir,
        pairCacheDir,
        limits: { maxRegionFiles: 1 },
      },
    });

    expect(result.plan.regions.every((region) => region.files.length === 1)).toBe(true);
    expect(result.extraction).toStrictEqual(canonical);
    expect(result.context).not.toBeNull();
    expect(result.pendingRegions).toHaveLength(result.plan.regions.length);
    expect(result.regionEvidence).toHaveLength(result.plan.regions.length);
    expect(result.metrics).toMatchObject({
      planKind: "partitioned",
      fallbackReasons: [],
      reusedRegions: 0,
      reusedSourceBytes: 0,
      reuseRatio: 0,
      byteReuseRatio: 0,
    });
    expect(result.metrics.rebuiltRegions).toBe(result.metrics.totalRegions);
    expect(existsSync(join(pairCacheDir, "semantic-region-contexts"))).toBe(true);
    expect(existsSync(join(pairCacheDir, "semantic-region-shards"))).toBe(true);
  });

  it("does not reinterpret malformed pair-cache data as an availability fallback", async () => {
    const prepared = await prepareProviderUnit(fixture);
    const pairCacheDir = join(fixture.cacheDir, "pair-malformed-cache");
    mkdirSync(pairCacheDir, { recursive: true });
    const plan = addressSemanticRegions({
      loaded: prepared.loaded,
      unitInputs: prepared.unitInputs,
      workspaceDigest: prepared.workspaceHash,
    });
    await publishSemanticRegionContext(
      pairCacheDir,
      semanticRegionContextRecord(plan.context, plan.contextDigest),
    );
    const region = plan.regions[0]!;
    await writeImmutableJsonCache(
      join(pairCacheDir, "semantic-region-shards", plan.contextDigest),
      region.key,
      {},
      { trustedRoot: pairCacheDir },
    );

    await expect(extractLoadedUnitWithSemanticRegions({
      unit: prepared.unit,
      loaded: prepared.loaded,
      options: prepared.options,
      resolver: prepared.resolver,
      depth: prepared.policy.depth,
      unitInputs: prepared.unitInputs,
      workspaceDigest: prepared.workspaceHash,
      addressedPlan: plan,
      cache: {
        persistentCacheDir: fixture.cacheDir,
        pairCacheDir,
      },
    })).rejects.toThrow(/invalid semantic-region shard identity/);
  });

  it("never persists import edges and materializes the fresh target lane on a hit", async () => {
    const prepared = await prepareProviderUnit(fixture);
    const pairCacheDir = join(fixture.cacheDir, "pair-stale-import-output");
    mkdirSync(pairCacheDir, { recursive: true });
    const plan = addressSemanticRegions({
      loaded: prepared.loaded,
      unitInputs: prepared.unitInputs,
      workspaceDigest: prepared.workspaceHash,
    });
    if (plan.plan.kind !== "partitioned") {
      throw new Error(`provider fixture unexpectedly fell back: ${plan.plan.reasons.join(",")}`);
    }
    const canonical = extractLoadedUnitContributions(
      prepared.unit,
      prepared.loaded,
      prepared.options,
      prepared.resolver,
      prepared.policy.depth,
    );
    const importedFile = canonical.files.find((file) => file.importEdges.length > 0);
    if (importedFile === undefined) throw new Error("provider fixture has no import edge");
    const region = plan.regions.find((candidate) => candidate.files.includes(importedFile.file));
    if (region === undefined) throw new Error("provider import file has no semantic region");
    const regionFiles = new Set(region.files);
    const cachedFiles = canonical.files.filter((file) => regionFiles.has(file.file));
    const pending = createPendingSemanticRegionShard(region, cachedFiles);
    expect(pending.value.contributions.files.every(
      (file) => !("importEdges" in file),
    )).toBe(true);

    await publishSemanticRegionContext(
      pairCacheDir,
      semanticRegionContextRecord(plan.context, plan.contextDigest),
    );
    await publishPendingSemanticRegionShard(
      pairCacheDir,
      pending,
    );

    const result = await extractLoadedUnitWithSemanticRegions({
      unit: prepared.unit,
      loaded: prepared.loaded,
      options: prepared.options,
      resolver: prepared.resolver,
      depth: prepared.policy.depth,
      unitInputs: prepared.unitInputs,
      workspaceDigest: prepared.workspaceHash,
      addressedPlan: plan,
      cache: {
        persistentCacheDir: fixture.cacheDir,
        pairCacheDir,
      },
    });

    expect(result.metrics.reusedRegions).toBe(1);
    expect(result.contributions.files.find((file) => file.file === importedFile.file)?.importEdges)
      .toStrictEqual(importedFile.importEdges);
    expect(result.extraction)
      .toStrictEqual(materializeUnitContributionSetV1(canonical));
  });
});

async function prepareProviderUnit(fixture: GitMonorepoFixture) {
  const revision = fixture.currentRevision();
  const request = fixtureRequest(fixture, revision);
  const policy = analysisPolicy(request.options);
  const options = extractOptions(fixture.root, policy);
  const workspace = perPackageWorkspace(options);
  if (workspace === null) throw new Error("fixture did not produce a package workspace");
  const unit = workspace.units.find((candidate) => candidate.dir === "packages/provider");
  if (unit === undefined) throw new Error("fixture provider unit is missing");
  const loaded = loadUnitProject(
    fixture.root,
    unit,
    options,
    workspace.memberPaths,
  );
  const verified = await verifyGitTreeInputs(
    fixture.root,
    await listGitTreeBlobs(fixture.root, revision.treeOid),
  );
  const treeBlobs = verified.regularBlobs.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  const unitInputs = unitInputFingerprint({
    root: fixture.root,
    unit,
    loaded,
    treeBlobs,
    treeBlobIndex: new Map(treeBlobs.map((blob) => [blob.path, blob])),
    policy,
    provenance: extractorProvenance(request),
  });
  if (!unitInputs.reuseEligibility.eligible) {
    throw new Error(
      `fixture provider unit is unexpectedly ineligible: ${
        unitInputs.reuseEligibility.reasons.join(",")
      }`,
    );
  }
  return {
    unit,
    loaded,
    options,
    policy,
    unitInputs,
    workspaceHash: workspaceDigest(workspace),
    resolver: createCrossPackageResolver(workspace, fixture.root),
  };
}
