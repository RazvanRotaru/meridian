import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractRevisionDifferential } from "./differential-revision";
import {
  extractRevisionCandidate,
  extractRevisionWithCache,
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
  manifest: RevisionManifest;
  metrics: RevisionExtractionMetrics;
  manifestPath: string;
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
    expect(scoped.incremental.metrics).toMatchObject({
      totalUnits: 4,
      rebuiltUnits: 2,
      reusedUnits: 2,
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
