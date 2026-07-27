import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractionResult } from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  RevisionShardAdmissionSigner,
  RevisionShardAdmissionVerifier,
} from "./admission";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { compareExtractionResults } from "./differential";
import { extractRevisionDifferential } from "./differential-revision";
import {
  extractRevisionCandidate,
  extractRevisionWithCache,
  publishRevisionCandidate,
  publishStagedRevisionAdmission,
  stageRevisionCandidateForAdmission,
  type PendingRevisionExtraction,
} from "./extract-revision";
import {
  createGitMonorepoFixture,
  type GitFixtureRevision,
  type GitMonorepoFixture,
} from "./git-fixture";
import {
  immutableJsonCachePath,
  listImmutableJsonCacheAddresses,
  readImmutableJsonCache,
  writeImmutableJsonCache,
} from "./immutable-cache";
import type { RevisionExtractionMetrics, RevisionManifest } from "./model";
import { fixtureRequest, replaceInFixture } from "./test-support";

interface AdmittedRevisionCase {
  readonly id: string;
  readonly name: string;
  readonly prepareBase?: (fixture: GitMonorepoFixture) => GitFixtureRevision;
  readonly mutateTarget: (fixture: GitMonorepoFixture) => GitFixtureRevision;
  readonly expected: {
    readonly totalUnits: number;
    readonly rebuiltUnits: number;
    readonly reusedUnits: number;
  };
}

const ADMITTED_REVISION_CASES: readonly AdmittedRevisionCase[] = [
  {
    id: "ordinary-modification",
    name: "ordinary modification",
    mutateTarget: (fixture) => {
      replaceInFixture(
        fixture,
        "packages/consumer/src/index.ts",
        "normalizeOrder(raw)",
        "normalizeOrder(normalizeOrder(raw))",
      );
      return fixture.commit("modify one admitted consumer unit");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
  },
  {
    id: "source-addition",
    name: "source addition",
    mutateTarget: (fixture) => {
      fixture.writeFile(
        "packages/consumer/src/status.ts",
        'export function statusLabel(ok: boolean): string {\n  return ok ? "ok" : "failed";\n}\n',
      );
      return fixture.commit("add one admitted consumer source");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
  },
  {
    id: "source-deletion",
    name: "source deletion",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/consumer/src/delete-me.ts",
        "export function deletedContribution(): number {\n  return 1;\n}\n",
      );
      return fixture.commit("prepare admitted source deletion");
    },
    mutateTarget: (fixture) => {
      fixture.removeFile("packages/consumer/src/delete-me.ts");
      return fixture.commit("delete one admitted consumer source");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
  },
  {
    id: "source-rename",
    name: "source rename",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/rename-me.ts",
        "export function renamedContribution(): number {\n  return 2;\n}\n",
      );
      return fixture.commit("prepare admitted source rename");
    },
    mutateTarget: (fixture) => {
      fixture.renameFile(
        "packages/provider/src/rename-me.ts",
        "packages/provider/src/renamed.ts",
      );
      return fixture.commit("rename one admitted provider source");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
  },
  {
    id: "reexport-boundary",
    name: "provider re-export boundary change",
    mutateTarget: (fixture) => {
      fixture.writeFile(
        "packages/provider/src/alternate.ts",
        [
          "export function normalizeOrder(raw: string): string {",
          "  return raw.trim().toLowerCase();",
          "}",
          "",
        ].join("\n"),
      );
      replaceInFixture(
        fixture,
        "packages/provider/src/index.ts",
        '"./normalize"',
        '"./alternate"',
      );
      return fixture.commit("change admitted provider re-export boundary");
    },
    expected: { totalUnits: 3, rebuiltUnits: 2, reusedUnits: 1 },
  },
  {
    id: "root-tsconfig",
    name: "root tsconfig change",
    mutateTarget: (fixture) => {
      const config = JSON.parse(fixture.readFile("tsconfig.json")) as {
        compilerOptions: Record<string, unknown>;
      };
      config.compilerOptions.useDefineForClassFields = true;
      fixture.writeFile("tsconfig.json", `${JSON.stringify(config, null, 2)}\n`);
      return fixture.commit("change admitted root compiler configuration");
    },
    expected: { totalUnits: 3, rebuiltUnits: 3, reusedUnits: 0 },
  },
  {
    id: "package-tsconfig",
    name: "package tsconfig extends-chain change",
    prepareBase: (fixture) => {
      fixture.writeFile(
        "configs/provider-base.json",
        '{"compilerOptions":{"target":"ES2022","useDefineForClassFields":false}}\n',
      );
      fixture.writeFile(
        "packages/provider/tsconfig.json",
        '{"extends":"../../configs/provider-base.json","compilerOptions":{"module":"ESNext"}}\n',
      );
      return fixture.commit("prepare admitted provider compiler configuration");
    },
    mutateTarget: (fixture) => {
      fixture.writeFile(
        "configs/provider-base.json",
        '{"compilerOptions":{"target":"ES2022","useDefineForClassFields":true}}\n',
      );
      return fixture.commit("change admitted provider compiler configuration");
    },
    expected: { totalUnits: 3, rebuiltUnits: 1, reusedUnits: 2 },
  },
];

describe("trusted cold-oracle shard admission", { timeout: 60_000 }, () => {
  let fixture: GitMonorepoFixture;
  let signer: RevisionShardAdmissionSigner;
  let verifier: RevisionShardAdmissionVerifier;

  beforeEach(() => {
    fixture = createGitMonorepoFixture();
    ({ signer, verifier } = authority());
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("admits exact per-unit cold parity and reuses it with verifier-only authority", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });

    expect(shadow.incremental.metrics.rebuiltUnits).toBe(shadow.incremental.metrics.totalUnits);
    expect(shadow.cold.manifestPath).toBeNull();
    expect(admitted.metrics).toMatchObject({
      rebuiltUnits: 0,
      reusedUnits: admitted.metrics.totalUnits,
    });
    expect(admitted.manifest.normalizedResultDigest).toBe(
      shadow.cold.manifest.normalizedResultDigest,
    );
    expect(await listImmutableJsonCacheAddresses(
      join(fixture.cacheDir, "admissions", signer.keyId),
      { trustedRoot: fixture.cacheDir },
    )).toHaveLength(admitted.metrics.totalUnits);
  });

  it.each(ADMITTED_REVISION_CASES)(
    "matches an empty-cache oracle across verifier-only $name",
    async (scenario) => {
      const base = scenario.prepareBase?.(fixture) ?? fixture.seedRevision;
      await extractRevisionDifferential(
        fixtureRequest(fixture, base),
        { admissionSigner: signer },
      );
      const target = scenario.mutateTarget(fixture);
      const request = fixtureRequest(fixture, target);

      const admitted = await extractRevisionCandidate(request, {
        requiredAdmission: verifier,
      });
      const cold = await extractRevisionCandidate({
        ...request,
        cacheDir: join(dirname(fixture.cacheDir), `oracle-${scenario.id}`),
      });

      expect(admitted.metrics).toMatchObject({
        totalUnits: scenario.expected.totalUnits,
        rebuiltUnits: scenario.expected.rebuiltUnits,
        reusedUnits: scenario.expected.reusedUnits,
      });
      expectExactCandidateParity(admitted, cold);
    },
  );

  it("reuses admitted shards for two different histories reaching the same target tree", async () => {
    const providerOriginal = fixture.readFile("packages/provider/src/version.ts");
    fixture.writeFile(
      "packages/provider/src/version.ts",
      'export const providerVersion = "temporary-a";\n',
    );
    fixture.commit("history a intermediate");
    fixture.writeFile("packages/provider/src/version.ts", providerOriginal);
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "/api/orders",
      "/api/orders/v2",
    );
    const admittedBase = fixture.commit("history a target");
    await extractRevisionDifferential(
      fixtureRequest(fixture, admittedBase),
      { admissionSigner: signer },
    );

    fixture.checkoutExact(fixture.seedRevision);
    fixture.writeFile(
      "packages/consumer/src/temporary-b.ts",
      "export const temporary = true;\n",
    );
    fixture.commit("history b intermediate");
    fixture.removeFile("packages/consumer/src/temporary-b.ts");
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "/api/orders",
      "/api/orders/v2",
    );
    const target = fixture.commit("history b target");
    expect(target.commitOid).not.toBe(admittedBase.commitOid);
    expect(target.treeOid).toBe(admittedBase.treeOid);

    const request = fixtureRequest(fixture, target);
    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    const cold = await extractRevisionCandidate({
      ...request,
      cacheDir: join(dirname(fixture.cacheDir), "oracle-two-histories"),
    });
    expect(admitted.metrics).toMatchObject({
      totalUnits: 3,
      rebuiltUnits: 0,
      reusedUnits: 3,
    });
    expectExactCandidateParity(admitted, cold);
  });

  it("keeps staged bytes untrusted until cold graph and per-unit parity publish admission", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const candidate = await extractRevisionCandidate(request, {
      requiredAdmission: signer,
    });
    const staged = await stageRevisionCandidateForAdmission(
      fixture.cacheDir,
      candidate,
      signer,
    );

    expect(existsSync(join(fixture.cacheDir, "shards"))).toBe(true);
    expect(existsSync(join(fixture.cacheDir, "candidates"))).toBe(true);
    expect(existsSync(join(fixture.cacheDir, "admissions"))).toBe(false);
    expect(existsSync(join(fixture.cacheDir, "manifests"))).toBe(false);
    const beforeOracle = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(beforeOracle.metrics).toMatchObject({
      rebuiltUnits: beforeOracle.metrics.totalUnits,
      reusedUnits: 0,
    });

    const coldCacheDir = join(dirname(fixture.cacheDir), "staged-lifecycle-oracle");
    const cold = await extractRevisionCandidate({
      ...request,
      cacheDir: coldCacheDir,
    });
    await publishRevisionCandidate(coldCacheDir, cold);
    expect(compareExtractionResults(candidate.result, cold.result)).toMatchObject({
      equal: true,
      mismatches: [],
    });
    const publication = await publishStagedRevisionAdmission(
      fixture.cacheDir,
      staged,
      signer,
      coldCacheDir,
      cold,
    );
    expect(publication.differential).toMatchObject({ equal: true, mismatches: [] });
    expect(publication.run.manifestPath).toContain("/manifests/");
    expect(existsSync(join(fixture.cacheDir, "admissions", signer.keyId))).toBe(true);

    const afterOracle = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(afterOracle.metrics).toMatchObject({
      rebuiltUnits: 0,
      reusedUnits: afterOracle.metrics.totalUnits,
    });
    expectExactCandidateParity(afterOracle, cold);
  });

  it("reuses verifier-admitted base shards in a genuinely fresh target process", async () => {
    await extractRevisionDifferential(
      fixtureRequest(fixture, fixture.seedRevision),
      { admissionSigner: signer },
    );
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "normalizeOrder(raw)",
      "normalizeOrder(normalizeOrder(raw))",
    );
    const target = fixture.commit("fresh admitted process target");
    const request = fixtureRequest(fixture, target);
    const requestPath = join(dirname(fixture.cacheDir), "admitted-worker-request.json");
    writeFileSync(requestPath, JSON.stringify({ request, verifier }));

    const worker = runAdmittedWorker(requestPath);
    const cold = await extractRevisionCandidate({
      ...request,
      cacheDir: join(dirname(fixture.cacheDir), "fresh-process-oracle"),
    });

    expect(worker.metrics.processId).not.toBe(process.pid);
    expect(worker.metrics).toMatchObject({
      totalUnits: 3,
      rebuiltUnits: 1,
      reusedUnits: 2,
    });
    expectWorkerParity(worker, cold);
  });

  it("rejects a forged self-consistent shard envelope when its receipt no longer matches", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const target = shadow.incremental.manifest.units[0]!;
    const shardPath = immutableJsonCachePath(
      join(fixture.cacheDir, "shards"),
      target.shardKey,
    );
    const envelope = JSON.parse(readFileSync(shardPath, "utf8")) as {
      payloadDigest: string;
      value: {
        extraction: {
          nodes: Array<{ displayName: string }>;
        };
      };
    };
    envelope.value.extraction.nodes[0]!.displayName += " forged";
    envelope.payloadDigest = canonicalJsonSha256(envelope.value);
    chmodSync(shardPath, 0o600);
    writeFileSync(shardPath, canonicalJson(envelope));
    chmodSync(shardPath, 0o400);

    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(admitted.metrics.rebuiltUnits).toBeGreaterThanOrEqual(1);
    expect(admitted.metrics.reusedUnits).toBeLessThan(admitted.metrics.totalUnits);
    expect(admitted.manifest.normalizedResultDigest).toBe(
      shadow.cold.manifest.normalizedResultDigest,
    );

    await expect(extractRevisionDifferential(request, {
      admissionSigner: signer,
    })).resolves.toMatchObject({
      differential: { equal: true },
    });
    const repaired = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(repaired.metrics).toMatchObject({
      rebuiltUnits: 0,
      reusedUnits: repaired.metrics.totalUnits,
    });
    expect(readdirSync(join(fixture.cacheDir, ".retention-trash", "repair")).length)
      .toBeGreaterThanOrEqual(1);
  });

  it("does not publish canonical misses from admitted mode", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });

    expect(admitted.metrics).toMatchObject({
      reusedUnits: 0,
      rebuiltUnits: admitted.metrics.totalUnits,
    });
    expect(admitted.pendingShards).toHaveLength(admitted.metrics.totalUnits);
    expect(readdirSync(fixture.cacheDir)).toEqual([]);
  });

  it("ignores a pre-receipt cache even when its content hashes are valid", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    await extractRevisionWithCache(request);
    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });

    expect(admitted.metrics).toMatchObject({
      reusedUnits: 0,
      rebuiltUnits: admitted.metrics.totalUnits,
    });
  });

  it("treats a corrupt receipt as a miss and lets a later shadow run repair it", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const shardKey = shadow.incremental.manifest.units[0]!.shardKey;
    const receiptPath = immutableJsonCachePath(
      join(fixture.cacheDir, "admissions", signer.keyId),
      shardKey,
    );
    chmodSync(receiptPath, 0o600);
    writeFileSync(receiptPath, "corrupt");

    const missed = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(missed.metrics.rebuiltUnits).toBeGreaterThanOrEqual(1);
    await expect(extractRevisionDifferential(request, {
      admissionSigner: signer,
    })).resolves.toMatchObject({ differential: { equal: true } });
    const repaired = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(repaired.metrics.reusedUnits).toBe(repaired.metrics.totalUnits);
  });

  it("bounds candidate variants and conservatively rebuilds an overloaded unit", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const shadow = await extractRevisionDifferential(request, { admissionSigner: signer });
    const target = shadow.incremental.manifest.units[0]!;
    const shard = await readImmutableJsonCache<{
      baseInputKey: string;
      workspaceResolverTrace: unknown[];
    }>(
      join(fixture.cacheDir, "shards"),
      target.shardKey,
      { trustedRoot: fixture.cacheDir },
    );
    expect(shard).not.toBeNull();
    const candidateRoot = join(
      fixture.cacheDir,
      "candidates",
      shard!.value.baseInputKey,
    );
    for (let index = 0; index < 128; index += 1) {
      const address = canonicalJsonSha256({ overload: index });
      await writeImmutableJsonCache(candidateRoot, address, {
        version: 6,
        baseInputKey: shard!.value.baseInputKey,
        shardKey: address,
        workspaceResolverTrace: [],
      }, { trustedRoot: fixture.cacheDir });
    }

    const admitted = await extractRevisionCandidate(request, {
      requiredAdmission: verifier,
    });
    expect(admitted.metrics.rebuiltUnits).toBeGreaterThanOrEqual(1);
    expect(admitted.manifest.normalizedResultDigest).toBe(
      shadow.cold.manifest.normalizedResultDigest,
    );
  });
});

interface AdmittedWorkerReport {
  result: ExtractionResult;
  manifest: RevisionManifest;
  metrics: RevisionExtractionMetrics;
  units: Array<{
    unitId: string;
    shardKey: string;
    value: unknown;
  }>;
}

function expectExactCandidateParity(
  admitted: PendingRevisionExtraction,
  cold: PendingRevisionExtraction,
): void {
  expect(compareExtractionResults(admitted.result, cold.result)).toMatchObject({
    equal: true,
    mismatches: [],
  });
  expect(canonicalJson(admitted.manifest)).toBe(canonicalJson(cold.manifest));
  expect(admitted.unitShards.map((unit) => ({
    unitId: unit.unitId,
    shardKey: unit.shardKey,
    value: canonicalJson(unit.value),
  }))).toEqual(cold.unitShards.map((unit) => ({
    unitId: unit.unitId,
    shardKey: unit.shardKey,
    value: canonicalJson(unit.value),
  })));
}

function expectWorkerParity(
  worker: AdmittedWorkerReport,
  cold: PendingRevisionExtraction,
): void {
  expect(compareExtractionResults(worker.result, cold.result)).toMatchObject({
    equal: true,
    mismatches: [],
  });
  expect(canonicalJson(worker.manifest)).toBe(canonicalJson(cold.manifest));
  expect(worker.units.map((unit) => ({
    unitId: unit.unitId,
    shardKey: unit.shardKey,
    value: canonicalJson(unit.value),
  }))).toEqual(cold.unitShards.map((unit) => ({
    unitId: unit.unitId,
    shardKey: unit.shardKey,
    value: canonicalJson(unit.value),
  })));
}

function runAdmittedWorker(requestPath: string): AdmittedWorkerReport {
  const worker = fileURLToPath(new URL("./admitted-process-worker.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", worker, requestPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `fresh admitted worker failed: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  return JSON.parse(result.stdout) as AdmittedWorkerReport;
}

function authority(): {
  signer: RevisionShardAdmissionSigner;
  verifier: RevisionShardAdmissionVerifier;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const keyId = createHash("sha256").update(publicDer).digest("hex");
  return {
    signer: {
      version: 1,
      kind: "signer",
      keyId,
      publicKeySpki: publicDer.toString("base64"),
      privateKeyPkcs8: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer)
        .toString("base64"),
    },
    verifier: {
      version: 1,
      kind: "verifier",
      keyId,
      publicKeySpki: publicDer.toString("base64"),
    },
  };
}
