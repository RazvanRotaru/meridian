import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractionResult } from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractRevisionDifferential } from "./differential-revision";
import {
  extractRevisionCandidate,
  extractRevisionWithCache,
  publishRevisionCandidate,
} from "./extract-revision";
import { createGitMonorepoFixture, type GitMonorepoFixture } from "./git-fixture";
import {
  ImmutableCacheCorruptionError,
  immutableJsonCachePath,
} from "./immutable-cache";
import type { RevisionExtractionMetrics, RevisionManifest } from "./model";
import {
  fixtureRequest,
  intersectionSize,
  replaceInFixture,
  shardKeys,
} from "./test-support";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";

interface WorkerReport {
  result?: ExtractionResult;
  manifest: RevisionManifest;
  metrics: RevisionExtractionMetrics;
  manifestPath?: string;
}

describe("revision-safe shard sharing and process boundaries", { timeout: 30_000 }, () => {
  let fixture: GitMonorepoFixture;

  beforeEach(() => {
    fixture = createGitMonorepoFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("reuses identical shards for different edit sequences reaching the same tree", async () => {
    const providerOriginal = fixture.readFile("packages/provider/src/version.ts");
    fixture.writeFile("packages/provider/src/version.ts", 'export const providerVersion = "temporary-a";\n');
    fixture.commit("sequence a intermediate");
    fixture.writeFile("packages/provider/src/version.ts", providerOriginal);
    replaceInFixture(fixture, "packages/consumer/src/index.ts", "/api/orders", "/api/orders/v2");
    const targetA = fixture.commit("sequence a target");
    const first = await extractRevisionWithCache(fixtureRequest(fixture, targetA));

    fixture.checkoutExact(fixture.seedRevision);
    fixture.writeFile("packages/consumer/src/temporary-b.ts", "export const temporary = true;\n");
    fixture.commit("sequence b intermediate");
    fixture.removeFile("packages/consumer/src/temporary-b.ts");
    replaceInFixture(fixture, "packages/consumer/src/index.ts", "/api/orders", "/api/orders/v2");
    const targetB = fixture.commit("sequence b target");

    expect(targetB.commitOid).not.toBe(targetA.commitOid);
    expect(targetB.treeOid).toBe(targetA.treeOid);
    const second = await extractRevisionWithCache(fixtureRequest(fixture, targetB));
    expect(second.metrics.reusedUnits).toBe(second.metrics.totalUnits);
    expect(second.manifest.normalizedResultDigest).toBe(first.manifest.normalizedResultDigest);
    expect(second.manifest.units.map((unit) => unit.shardKey)).toEqual(
      first.manifest.units.map((unit) => unit.shardKey),
    );
  });

  it("shares immutable base-derived shards across two sequential PR-like heads", async () => {
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "normalizeOrder(raw)",
      "normalizeOrder(normalizeOrder(raw))",
    );
    const headA = fixture.commit("head a changes consumer");
    const requestPath = join(dirname(fixture.cacheDir), "sibling-worker-request.json");
    writeFileSync(requestPath, JSON.stringify(fixtureRequest(fixture, headA)));
    const first = runWorker(requestPath);
    const firstKeys = shardKeys(first.manifest);

    fixture.checkoutExact(fixture.seedRevision);
    replaceInFixture(fixture, "packages/provider/src/normalize.ts", "toUpperCase()", "toLowerCase()");
    const headB = fixture.commit("head b changes provider");
    writeFileSync(requestPath, JSON.stringify(fixtureRequest(fixture, headB)));
    const second = runWorker(requestPath);
    const coldRequest = {
      ...fixtureRequest(fixture, headB),
      cacheDir: join(dirname(fixture.cacheDir), "sibling-cold-cache"),
    };
    writeFileSync(requestPath, JSON.stringify(coldRequest));
    const cold = runWorker(requestPath);

    expect(new Set([first.metrics.processId, second.metrics.processId, cold.metrics.processId]).size).toBe(3);
    expect(first.metrics).toMatchObject({ rebuiltUnits: 3, reusedUnits: 0 });
    expect(second.metrics).toMatchObject({ rebuiltUnits: 2, reusedUnits: 1 });
    expect(cold.metrics).toMatchObject({ rebuiltUnits: 3, reusedUnits: 0 });
    expect(intersectionSize(firstKeys, shardKeys(second.manifest))).toBe(1);
    expect(second.manifest.normalizedResultDigest).toBe(cold.manifest.normalizedResultDigest);
  });

  it("shares canonical misses only within one ephemeral exact-revision pair", async () => {
    const pairCacheDir = join(dirname(fixture.cacheDir), "ephemeral-pair");
    const base = await extractRevisionCandidate(
      fixtureRequest(fixture, fixture.seedRevision),
      { ephemeralPairCacheDir: pairCacheDir },
    );
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "normalizeOrder(raw)",
      "normalizeOrder(normalizeOrder(raw))",
    );
    const headRevision = fixture.commit("pair head changes one unit");
    const head = await extractRevisionCandidate(
      fixtureRequest(fixture, headRevision),
      { ephemeralPairCacheDir: pairCacheDir },
    );
    const cold = await extractRevisionCandidate({
      ...fixtureRequest(fixture, headRevision),
      cacheDir: join(dirname(fixture.cacheDir), "ephemeral-pair-cold"),
    });

    expect(base.metrics).toMatchObject({ rebuiltUnits: 3, reusedUnits: 0 });
    expect(head.metrics).toMatchObject({ rebuiltUnits: 1, reusedUnits: 2 });
    expect(canonicalJson(head.result)).toBe(canonicalJson(cold.result));
    expect(head.manifest).toEqual(cold.manifest);
    expect(readdirSync(fixture.cacheDir)).toEqual([]);
  });

  it("retains pair-consumed shards for exact publication after the pair cache is deleted", async () => {
    const pairCacheDir = join(dirname(fixture.cacheDir), "ephemeral-pair-publication");
    await extractRevisionCandidate(
      fixtureRequest(fixture, fixture.seedRevision),
      { ephemeralPairCacheDir: pairCacheDir },
    );
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "normalizeOrder(raw)",
      "normalizeOrder(normalizeOrder(raw))",
    );
    const headRevision = fixture.commit("publish pair consumer");
    const request = fixtureRequest(fixture, headRevision);
    const candidate = await extractRevisionCandidate(
      request,
      { ephemeralPairCacheDir: pairCacheDir },
    );
    const pairConsumed = candidate.unitShards.filter(
      (unit) => unit.value.inputs.unit.dir !== "packages/consumer",
    );
    const exactPairEnvelopes = pairConsumed.map((unit) => ({
      unit,
      shard: readFileSync(
        immutableJsonCachePath(join(pairCacheDir, "shards"), unit.shardKey),
        "utf8",
      ),
      reference: readFileSync(
        immutableJsonCachePath(
          join(pairCacheDir, "candidates", unit.value.baseInputKey),
          unit.shardKey,
        ),
        "utf8",
      ),
    }));

    expect(candidate.metrics).toMatchObject({ rebuiltUnits: 1, reusedUnits: 2 });
    expect(candidate.pendingShards).toHaveLength(candidate.metrics.totalUnits);
    rmSync(pairCacheDir, { recursive: true });
    await publishRevisionCandidate(fixture.cacheDir, candidate);

    for (const { unit, shard, reference } of exactPairEnvelopes) {
      expect(readFileSync(
        immutableJsonCachePath(join(fixture.cacheDir, "shards"), unit.shardKey),
        "utf8",
      )).toBe(shard);
      expect(readFileSync(
        immutableJsonCachePath(
          join(fixture.cacheDir, "candidates", unit.value.baseInputKey),
          unit.shardKey,
        ),
        "utf8",
      )).toBe(reference);
    }
    for (const unit of candidate.manifest.units) {
      expect(() => readFileSync(
        immutableJsonCachePath(join(fixture.cacheDir, "shards"), unit.shardKey),
      )).not.toThrow();
    }

    const warm = await extractRevisionCandidate(request);
    expect(warm.metrics).toMatchObject({ rebuiltUnits: 0, reusedUnits: 3 });
    expect(canonicalJson(warm.result)).toBe(canonicalJson(candidate.result));
    expect(warm.manifest).toEqual(candidate.manifest);
  });

  it("retains pair-consumed semantic regions for publication after pair cleanup", async () => {
    const pairCacheDir = join(dirname(fixture.cacheDir), "ephemeral-region-publication");
    await extractRevisionCandidate(
      fixtureRequest(fixture, fixture.seedRevision),
      { ephemeralPairCacheDir: pairCacheDir },
    );
    fixture.writeFile(
      "packages/consumer/src/status.ts",
      'export function statusLabel(ok: boolean): string {\n  return ok ? "ok" : "failed";\n}\n',
    );
    const headRevision = fixture.commit("add pair semantic region");
    const request = fixtureRequest(fixture, headRevision);
    const candidate = await extractRevisionCandidate(
      request,
      { ephemeralPairCacheDir: pairCacheDir },
    );
    const semanticEnvelopes = candidate.pendingSemanticRegions.map((region) => ({
      region,
      bytes: readFileSync(
        immutableJsonCachePath(
          join(pairCacheDir, "semantic-region-shards", region.baseInputKey),
          region.key,
        ),
        "utf8",
      ),
    }));

    expect(candidate.metrics.semanticRegions).toMatchObject({
      totalRegions: 2,
      reusedRegions: 1,
      rebuiltRegions: 1,
    });
    expect(candidate.pendingSemanticRegions).toHaveLength(2);
    rmSync(pairCacheDir, { recursive: true });
    await publishRevisionCandidate(fixture.cacheDir, candidate);

    for (const { region, bytes } of semanticEnvelopes) {
      expect(readFileSync(
        immutableJsonCachePath(
          join(fixture.cacheDir, "semantic-region-shards", region.baseInputKey),
          region.key,
        ),
        "utf8",
      )).toBe(bytes);
    }

    replaceInFixture(
      fixture,
      "packages/consumer/src/status.ts",
      '"failed"',
      '"not-ready"',
    );
    const nextRevision = fixture.commit("change one published semantic region");
    const next = await extractRevisionDifferential(
      fixtureRequest(fixture, nextRevision),
    );
    expect(next.incremental.metrics.semanticRegions).toMatchObject({
      totalRegions: 2,
      reusedRegions: 1,
      rebuiltRegions: 1,
    });
    expect(next.differential).toMatchObject({ equal: true, mismatches: [] });
  });

  it("singleflights simultaneous identical unit misses across fresh workers", async () => {
    const pairCacheDir = join(dirname(fixture.cacheDir), "concurrent-ephemeral-pair");
    const requestPath = join(dirname(fixture.cacheDir), "pair-worker-request.json");
    writeFileSync(requestPath, JSON.stringify({
      request: fixtureRequest(fixture, fixture.seedRevision),
      ephemeralPairCacheDir: pairCacheDir,
    }));

    const [left, right] = await Promise.all([
      runPairWorker(requestPath),
      runPairWorker(requestPath),
    ]);
    const cold = await extractRevisionCandidate({
      ...fixtureRequest(fixture, fixture.seedRevision),
      cacheDir: join(dirname(fixture.cacheDir), "concurrent-pair-cold"),
    });

    expect(left.metrics.rebuiltUnits + right.metrics.rebuiltUnits).toBe(3);
    expect(left.metrics.reusedUnits + right.metrics.reusedUnits).toBe(3);
    expect(canonicalJson(left.result)).toBe(canonicalJson(cold.result));
    expect(canonicalJson(right.result)).toBe(canonicalJson(cold.result));
    expect(left.manifest).toEqual(cold.manifest);
    expect(right.manifest).toEqual(cold.manifest);
    expect(readdirSync(fixture.cacheDir)).toEqual([]);
  });

  it("co-schedules two exact trees so shared units execute once and divergent units once per tree", async () => {
    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "normalizeOrder(raw)",
      "normalizeOrder(normalizeOrder(raw))",
    );
    const headRevision = fixture.commit("concurrent pair head changes one unit");
    const owner = dirname(fixture.root);
    const baseRoot = join(owner, "pair-base-worktree");
    const headRoot = join(owner, "pair-head-worktree");
    addWorktree(fixture.root, baseRoot, fixture.seedRevision.commitOid);
    addWorktree(fixture.root, headRoot, headRevision.commitOid);

    const pairCacheDir = join(owner, "different-tree-pair-cache");
    const baseRequest = {
      ...fixtureRequest(fixture, fixture.seedRevision),
      root: baseRoot,
    };
    const headRequest = {
      ...fixtureRequest(fixture, headRevision),
      root: headRoot,
    };
    const baseRequestPath = join(owner, "base-pair-worker-request.json");
    const headRequestPath = join(owner, "head-pair-worker-request.json");
    writeFileSync(baseRequestPath, JSON.stringify({
      request: baseRequest,
      ephemeralPairCacheDir: pairCacheDir,
    }));
    writeFileSync(headRequestPath, JSON.stringify({
      request: headRequest,
      ephemeralPairCacheDir: pairCacheDir,
    }));

    const [base, head] = await Promise.all([
      runPairWorker(baseRequestPath),
      runPairWorker(headRequestPath),
    ]);
    const coldBase = await extractRevisionCandidate({
      ...baseRequest,
      cacheDir: join(owner, "different-tree-base-cold"),
    });
    const coldHead = await extractRevisionCandidate({
      ...headRequest,
      cacheDir: join(owner, "different-tree-head-cold"),
    });

    expect(base.metrics.rebuiltUnits + head.metrics.rebuiltUnits).toBe(4);
    expect(base.metrics.reusedUnits + head.metrics.reusedUnits).toBe(2);
    expect(canonicalJson(base.result)).toBe(canonicalJson(coldBase.result));
    expect(canonicalJson(head.result)).toBe(canonicalJson(coldHead.result));
    expect(base.manifest).toEqual(coldBase.manifest);
    expect(head.manifest).toEqual(coldHead.manifest);
    expect(readdirSync(fixture.cacheDir)).toEqual([]);
  });

  it("persists shards across genuinely fresh warm worker processes", () => {
    const requestPath = join(dirname(fixture.cacheDir), "worker-request.json");
    writeFileSync(requestPath, JSON.stringify(fixtureRequest(fixture, fixture.seedRevision)));

    const first = runWorker(requestPath);
    const second = runWorker(requestPath);
    expect(first.metrics.processId).not.toBe(second.metrics.processId);
    expect(first.metrics.rebuiltUnits).toBe(first.metrics.totalUnits);
    expect(second.metrics.reusedUnits).toBe(second.metrics.totalUnits);
    expect(second.metrics.byteReuseRatio).toBe(1);
    expect(second.manifest.normalizedResultDigest).toBe(first.manifest.normalizedResultDigest);
  });

  it("keeps immutable resolver variants for the same unit inputs and replays the matching scope", async () => {
    fixture.writeFile(
      "plugins/relative-future/package.json",
      '{"name":"@fixture/relative-future","private":true}\n',
    );
    fixture.writeFile(
      "plugins/relative-future/src/index.ts",
      'export function relativeFuture(): string {\n  return "relative";\n}\n',
    );
    fixture.writeFile(
      "packages/consumer/src/relative-future.ts",
      [
        'import { relativeFuture } from "../../../plugins/relative-future/src/index";',
        "export function callRelativeFuture(): string {",
        "  return relativeFuture();",
        "}",
        "",
      ].join("\n"),
    );
    const revision = fixture.commit("prepare a dormant relative workspace target");
    const plainRequest = fixtureRequest(fixture, revision);
    const scopedRequest = {
      ...plainRequest,
      supplementalFiles: ["plugins/relative-future/src/index.ts"],
    };

    const plain = await extractRevisionWithCache(plainRequest);
    expect(plain.metrics).toMatchObject({ totalUnits: 3, rebuiltUnits: 3 });

    const scoped = await extractRevisionDifferential(scopedRequest);
    expect(scoped.differential.equal).toBe(true);
    // The scoped workspace has a distinct semantic-plan context and therefore distinct shards.
    expect(scoped.incremental.metrics).toMatchObject({
      totalUnits: 4,
      rebuiltUnits: 4,
      reusedUnits: 0,
    });
    expect(
      scoped.incremental.result.edges.some(
        (edge) => edge.target.includes(
          "plugins/relative-future/src/index.ts#relativeFuture",
        ),
      ),
    ).toBe(true);

    const plainAgain = await extractRevisionDifferential(plainRequest);
    expect(plainAgain.differential.equal).toBe(true);
    expect(plainAgain.incremental.metrics).toMatchObject({
      totalUnits: 3,
      rebuiltUnits: 0,
      reusedUnits: 3,
    });
    expect(plainAgain.incremental.manifest.normalizedResultDigest).toBe(
      plain.manifest.normalizedResultDigest,
    );

    const scopedAgain = await extractRevisionDifferential(scopedRequest);
    expect(scopedAgain.differential.equal).toBe(true);
    expect(scopedAgain.incremental.metrics).toMatchObject({
      totalUnits: 4,
      rebuiltUnits: 0,
      reusedUnits: 4,
    });
    expect(scopedAgain.incremental.manifest.normalizedResultDigest).toBe(
      scoped.incremental.manifest.normalizedResultDigest,
    );
  });

  it("fails closed on a corrupt immutable shard", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const first = await extractRevisionWithCache(request);
    const shardPath = immutableJsonCachePath(
      join(fixture.cacheDir, "shards"),
      first.manifest.units[0]!.shardKey,
    );
    chmodSync(shardPath, 0o600);
    writeFileSync(shardPath, "corrupt");

    await expect(extractRevisionWithCache(request)).rejects.toBeInstanceOf(ImmutableCacheCorruptionError);
  });

  it("rejects an external cache symlink that resolves inside the exact checkout", async () => {
    fixture.writeFile(".gitignore", ".ignored-cache/\n");
    const revision = fixture.commit("ignore the cache-escape target");
    const inside = join(fixture.root, ".ignored-cache");
    const outsideLink = join(dirname(fixture.cacheDir), "outside-cache-link");
    mkdirSync(inside);
    symlinkSync(inside, outsideLink, "dir");

    await expect(
      extractRevisionWithCache({
        ...fixtureRequest(fixture, revision),
        cacheDir: outsideLink,
      }),
    ).rejects.toThrow(/cache must be outside/);
    expect(readdirSync(inside)).toEqual([]);
  });

  it("does not publish rebuilt shards when a semantically poisoned hit fails the cold oracle", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const baseline = await extractRevisionWithCache(request);
    const provider = baseline.manifest.units.find(
      (unit) => unit.unitId === "packages/provider",
    );
    expect(provider).toBeDefined();
    const providerPath = immutableJsonCachePath(
      join(fixture.cacheDir, "shards"),
      provider!.shardKey,
    );
    const envelope = JSON.parse(readFileSync(providerPath, "utf8")) as {
      payloadDigest: string;
      value: {
        extraction: {
          nodes: Array<{ id: string; displayName: string }>;
        };
      };
    };
    const poisonedNode = envelope.value.extraction.nodes.find(
      (node) => node.id.includes("provider/src/normalize.ts#normalizeOrder"),
    );
    expect(poisonedNode).toBeDefined();
    poisonedNode!.displayName += " poisoned";
    envelope.payloadDigest = canonicalJsonSha256(envelope.value);
    chmodSync(providerPath, 0o600);
    writeFileSync(providerPath, canonicalJson(envelope));
    chmodSync(providerPath, 0o400);

    replaceInFixture(
      fixture,
      "packages/consumer/src/index.ts",
      "normalizeOrder(raw)",
      "normalizeOrder(normalizeOrder(raw))",
    );
    const revision = fixture.commit("candidate with one rebuilt unit");
    const changedRequest = fixtureRequest(fixture, revision);
    const candidate = await extractRevisionCandidate(changedRequest);
    const rebuilt = candidate.pendingShards.find(
      (pending) => pending.value.inputs.unit.dir === "packages/consumer",
    );
    expect(rebuilt).toBeDefined();
    const rebuiltPath = immutableJsonCachePath(
      join(fixture.cacheDir, "shards"),
      rebuilt!.key,
    );

    await expect(extractRevisionDifferential(changedRequest)).rejects.toThrow(
      /differs from the empty-cache cold oracle/,
    );
    expect(() => readFileSync(rebuiltPath)).toThrow();
  });

  it("rejects a checkout whose working files no longer match the requested tree", async () => {
    fixture.writeFile("packages/unrelated/src/index.ts", "export const dirty = true;\n");
    await expect(
      extractRevisionWithCache(fixtureRequest(fixture, fixture.seedRevision)),
    ).rejects.toThrow(/clean|dirty|tree/i);
  });
});

function runWorker(requestPath: string): WorkerReport {
  const worker = fileURLToPath(new URL("./process-worker.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", worker, requestPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`fresh process worker failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return JSON.parse(result.stdout) as WorkerReport;
}

function runPairWorker(requestPath: string): Promise<Required<Pick<
  WorkerReport,
  "result" | "manifest" | "metrics"
>>> {
  const worker = fileURLToPath(new URL("./pair-process-worker.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, requestPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) => {
      if (status !== 0) {
        reject(new Error(
          `fresh pair worker failed: ${Buffer.concat(stderr).toString("utf8").trim()
            || `exit ${status ?? "unknown"}`}`,
        ));
        return;
      }
      resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as Required<Pick<
        WorkerReport,
        "result" | "manifest" | "metrics"
      >>);
    });
  });
}

function addWorktree(repository: string, destination: string, commit: string): void {
  const result = spawnSync("git", ["worktree", "add", "--detach", destination, commit], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`could not create exact test worktree: ${result.stderr.trim()}`);
  }
}
