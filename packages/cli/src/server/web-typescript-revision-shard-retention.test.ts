import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveTypeScriptRevisionShardRetentionPolicy,
  sweepTypeScriptRevisionShardCache,
  type TypeScriptRevisionShardRetentionExclusive,
} from "./web-typescript-revision-shard-retention";

const DAY_MS = 24 * 60 * 60_000;
const roots: string[] = [];
const exclusive: TypeScriptRevisionShardRetentionExclusive = async (operation) => operation();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveTypeScriptRevisionShardRetentionPolicy", () => {
  it("uses 8/6 GiB hysteresis and a 30-day idle lifetime", () => {
    expect(resolveTypeScriptRevisionShardRetentionPolicy()).toEqual({
      highWaterBytes: 8 * 1024 ** 3,
      lowWaterBytes: 6 * 1024 ** 3,
      maxIdleMs: 30 * DAY_MS,
      maxScanEntries: 500_000,
    });
  });

  it("keeps a three-quarter low watermark when only the high watermark changes", () => {
    expect(resolveTypeScriptRevisionShardRetentionPolicy({ highWaterBytes: 100 })).toMatchObject({
      highWaterBytes: 100,
      lowWaterBytes: 75,
    });
  });

  it.each([
    [{ highWaterBytes: 0 }, "highWaterBytes"],
    [{ lowWaterBytes: -1 }, "lowWaterBytes"],
    [{ highWaterBytes: 10, lowWaterBytes: 10 }, "lowWaterBytes"],
    [{ maxIdleMs: 0 }, "maxIdleMs"],
    [{ maxScanEntries: 0 }, "maxScanEntries"],
    [{ now: 1 }, "now"],
  ])("rejects invalid policy %j", (override, message) => {
    expect(() => resolveTypeScriptRevisionShardRetentionPolicy(
      override as never,
    )).toThrow(message);
  });
});

describe("sweepTypeScriptRevisionShardCache", () => {
  it("refuses relative and filesystem-root deletion scopes", async () => {
    await expect(sweepTypeScriptRevisionShardCache({
      cacheDir: "relative-cache",
      exclusive,
    })).rejects.toThrow(/must be absolute/);
    await expect(sweepTypeScriptRevisionShardCache({
      cacheDir: "/",
      exclusive,
    })).rejects.toThrow(/must not be a filesystem root/);
  });

  it("does not scan or mutate without the producer's exclusive boundary", async () => {
    const root = temporaryDirectory();
    const address = digest("a");
    const shard = cacheFile(root, "shard", address);
    writeSized(shard, 7, Date.now() - 90 * DAY_MS);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      policy: { now: () => Date.now() },
    });

    expect(report).toMatchObject({
      status: "skipped",
      reason: "exclusive-coordination-unavailable",
      observedFiles: 0,
      deletedFiles: [],
    });
    expect(existsSync(shard)).toBe(true);
  });

  it("deletes dangling references, idle manifests, then shard support before shard payloads", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const old = now - 31 * DAY_MS;
    const recent = now - DAY_MS;
    const oldAddress = digest("a");
    const orphanAddress = digest("b");
    const retainedAddress = digest("c");
    const base = digest("d");
    const key = digest("e");
    const tree = "f".repeat(40);
    const manifestAddress = digest("1");

    writeSized(cacheFile(root, "shard", oldAddress), 10, old);
    writeSized(cacheFile(root, "candidate", oldAddress, base), 2, old);
    writeSized(cacheFile(root, "admission", oldAddress, key), 3, old);
    writeSized(cacheFile(root, "candidate", orphanAddress, base), 4, recent);
    writeSized(cacheFile(root, "manifest", manifestAddress, tree), 5, old);
    const retainedShard = cacheFile(root, "shard", retainedAddress);
    const retainedCandidate = cacheFile(root, "candidate", retainedAddress, base);
    const retainedAdmission = cacheFile(root, "admission", retainedAddress, key);
    writeSized(retainedShard, 11, recent);
    writeSized(retainedCandidate, 6, recent);
    writeSized(retainedAdmission, 1, recent);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 1_000,
        lowWaterBytes: 750,
      },
    });

    expect(report.status).toBe("completed");
    expect(report.reason).toBeNull();
    expect(report.observedBytes).toBe(42);
    expect(report.deletedBytes).toBe(24);
    expect(report.remainingBytes).toBe(18);
    expect(report.decisions).toEqual([
      {
        id: `shard:${orphanAddress}`,
        kind: "shard-group",
        reason: "orphan",
        sizeBytes: 4,
        lastAccessMs: recent,
      },
      {
        id: `manifest:manifests/${tree}/${manifestAddress.slice(0, 2)}/${manifestAddress}.json`,
        kind: "manifest",
        reason: "max-idle",
        sizeBytes: 5,
        lastAccessMs: old,
      },
      {
        id: `shard:${oldAddress}`,
        kind: "shard-group",
        reason: "max-idle",
        sizeBytes: 15,
        lastAccessMs: old,
      },
    ]);
    expect(report.deletedFiles.map(({ kind, reason }) => [kind, reason])).toEqual([
      ["candidate", "orphan"],
      ["manifest", "max-idle"],
      ["candidate", "max-idle"],
      ["admission", "max-idle"],
      ["shard", "max-idle"],
    ]);
    expect(existsSync(retainedShard)).toBe(true);
    expect(existsSync(retainedCandidate)).toBe(true);
    expect(existsSync(join(root, ".retention-trash"))).toBe(false);
  });

  it("groups the producer-compatible immutable exact-request envelope and evicts support first", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const old = now - 31 * DAY_MS;
    const tree = "a".repeat(40);
    const manifestAddress = digest("b");
    const keyId = digest("c");
    const requestKey = digest("d");
    const manifest = cacheFile(root, "manifest", manifestAddress, tree);
    const admission = cacheFile(
      root,
      "revision-manifest-admission",
      requestKey,
      keyId,
    );
    writeSized(manifest, 5, old);
    const admissionSize = writeRevisionManifestAdmission(admission, {
      keyId,
      requestKey,
      treeOid: tree,
      manifestAddress,
    }, old);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 10_000,
        lowWaterBytes: 7_500,
      },
    });

    expect(report).toMatchObject({
      observedBytes: admissionSize + 5,
      observedFiles: 2,
      deletedBytes: admissionSize + 5,
      remainingBytes: 0,
    });
    expect(report.decisions).toEqual([{
      id: `manifest:manifests/${tree}/${manifestAddress.slice(0, 2)}/${manifestAddress}.json`,
      kind: "manifest",
      reason: "max-idle",
      sizeBytes: admissionSize + 5,
      lastAccessMs: old,
    }]);
    expect(report.deletedFiles.map(({ kind }) => kind)).toEqual([
      "revision-manifest-admission",
      "manifest",
    ]);
    expect(existsSync(admission)).toBe(false);
    expect(existsSync(manifest)).toBe(false);
  });

  it("reclaims dangling, malformed, and digest-mismatched exact-request indexes", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const keyId = digest("e");
    const danglingRequest = digest("f");
    const malformedRequest = digest("1");
    const mismatchedDigestRequest = digest("5");
    const missingManifest = digest("2");
    const retainedManifestAddress = digest("3");
    const tree = "4".repeat(40);
    const dangling = cacheFile(
      root,
      "revision-manifest-admission",
      danglingRequest,
      keyId,
    );
    const malformed = cacheFile(
      root,
      "revision-manifest-admission",
      malformedRequest,
      keyId,
    );
    const mismatchedDigest = cacheFile(
      root,
      "revision-manifest-admission",
      mismatchedDigestRequest,
      keyId,
    );
    const retainedManifest = cacheFile(root, "manifest", retainedManifestAddress, tree);
    writeRevisionManifestAdmission(dangling, {
      keyId,
      requestKey: danglingRequest,
      treeOid: tree,
      manifestAddress: missingManifest,
    }, now);
    writeJson(malformed, { requestKey: malformedRequest }, now);
    writeRevisionManifestAdmission(mismatchedDigest, {
      keyId,
      requestKey: mismatchedDigestRequest,
      treeOid: tree,
      manifestAddress: retainedManifestAddress,
    }, now);
    const mismatchedEnvelope = JSON.parse(readFileSync(mismatchedDigest, "utf8")) as {
      payloadDigest: string;
    };
    mismatchedEnvelope.payloadDigest = digest("6");
    writeJson(mismatchedDigest, mismatchedEnvelope, now);
    writeSized(retainedManifest, 5, now);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 10_000,
        lowWaterBytes: 7_500,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report.decisions).toHaveLength(3);
    expect(report.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `revision-manifest-admission:revision-manifest-admissions/${keyId}/${danglingRequest.slice(0, 2)}/${danglingRequest}.json`,
        kind: "revision-manifest-admission",
        reason: "orphan",
      }),
      expect.objectContaining({
        id: `revision-manifest-admission:revision-manifest-admissions/${keyId}/${malformedRequest.slice(0, 2)}/${malformedRequest}.json`,
        kind: "revision-manifest-admission",
        reason: "orphan",
      }),
      expect.objectContaining({
        id: `revision-manifest-admission:revision-manifest-admissions/${keyId}/${mismatchedDigestRequest.slice(0, 2)}/${mismatchedDigestRequest}.json`,
        kind: "revision-manifest-admission",
        reason: "orphan",
      }),
    ]));
    expect(report.deletedFiles.map(({ kind }) => kind)).toEqual([
      "revision-manifest-admission",
      "revision-manifest-admission",
      "revision-manifest-admission",
    ]);
    expect(existsSync(dangling)).toBe(false);
    expect(existsSync(malformed)).toBe(false);
    expect(existsSync(mismatchedDigest)).toBe(false);
    expect(existsSync(retainedManifest)).toBe(true);
  });

  it("uses manifest-index groups in deterministic capacity LRU ordering", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const keyId = digest("5");
    const oldTree = "6".repeat(40);
    const recentTree = "7".repeat(40);
    const oldManifestAddress = digest("8");
    const recentManifestAddress = digest("9");
    const oldRequest = digest("a");
    const recentRequest = digest("b");
    const oldManifest = cacheFile(root, "manifest", oldManifestAddress, oldTree);
    const recentManifest = cacheFile(root, "manifest", recentManifestAddress, recentTree);
    const oldAdmission = cacheFile(
      root,
      "revision-manifest-admission",
      oldRequest,
      keyId,
    );
    const recentAdmission = cacheFile(
      root,
      "revision-manifest-admission",
      recentRequest,
      keyId,
    );
    writeSized(oldManifest, 5, now - 2 * DAY_MS);
    writeSized(recentManifest, 5, now - DAY_MS);
    const oldAdmissionSize = writeRevisionManifestAdmission(oldAdmission, {
      keyId,
      requestKey: oldRequest,
      treeOid: oldTree,
      manifestAddress: oldManifestAddress,
    }, now - 2 * DAY_MS);
    const recentAdmissionSize = writeRevisionManifestAdmission(recentAdmission, {
      keyId,
      requestKey: recentRequest,
      treeOid: recentTree,
      manifestAddress: recentManifestAddress,
    }, now - DAY_MS);
    const oldGroupSize = oldAdmissionSize + 5;
    const recentGroupSize = recentAdmissionSize + 5;

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: oldGroupSize + recentGroupSize - 1,
        lowWaterBytes: recentGroupSize,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report.capacityPressure).toBe(true);
    expect(report.decisions).toEqual([{
      id: `manifest:manifests/${oldTree}/${oldManifestAddress.slice(0, 2)}/${oldManifestAddress}.json`,
      kind: "manifest",
      reason: "capacity",
      sizeBytes: oldGroupSize,
      lastAccessMs: now - 2 * DAY_MS,
    }]);
    expect(report.remainingBytes).toBe(recentGroupSize);
    expect(existsSync(oldAdmission)).toBe(false);
    expect(existsSync(oldManifest)).toBe(false);
    expect(existsSync(recentAdmission)).toBe(true);
    expect(existsSync(recentManifest)).toBe(true);
  });

  it("preserves a manifest when its exact-request support index cannot be quarantined", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const old = now - 31 * DAY_MS;
    const tree = "c".repeat(40);
    const manifestAddress = digest("d");
    const keyId = digest("e");
    const requestKey = digest("f");
    const manifest = cacheFile(root, "manifest", manifestAddress, tree);
    const admission = cacheFile(
      root,
      "revision-manifest-admission",
      requestKey,
      keyId,
    );
    writeSized(manifest, 5, old);
    writeRevisionManifestAdmission(admission, {
      keyId,
      requestKey,
      treeOid: tree,
      manifestAddress,
    }, old);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 10_000,
        lowWaterBytes: 7_500,
      },
      quarantineRename: async (source, destination) => {
        if (source === admission) {
          throw Object.assign(new Error("injected quarantine failure"), { code: "EACCES" });
        }
        renameSync(source, destination);
      },
    });

    expect(report.skippedEntries).toContainEqual({
      path: `revision-manifest-admissions/${keyId}/${requestKey.slice(0, 2)}/${requestKey}.json`,
      reason: "quarantine-failed",
    });
    expect(report.skippedEntries).toContainEqual({
      path: `manifests/${tree}/${manifestAddress.slice(0, 2)}/${manifestAddress}.json`,
      reason: "support-delete-failed",
    });
    expect(existsSync(admission)).toBe(true);
    expect(existsSync(manifest)).toBe(true);
  });

  it("uses deterministic LRU shard groups to drain from high water to low water", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const first = digest("2");
    const second = digest("3");
    const base = digest("4");
    const key = digest("5");

    writeSized(cacheFile(root, "shard", first), 4, now - 2 * DAY_MS);
    writeSized(cacheFile(root, "candidate", first, base), 2, now - 2 * DAY_MS);
    writeSized(cacheFile(root, "admission", first, key), 1, now - 2 * DAY_MS);
    const retainedShard = cacheFile(root, "shard", second);
    writeSized(retainedShard, 4, now - DAY_MS);
    writeSized(cacheFile(root, "candidate", second, base), 2, now - DAY_MS);
    writeSized(cacheFile(root, "admission", second, key), 1, now - DAY_MS);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 11,
        lowWaterBytes: 7,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report.capacityPressure).toBe(true);
    expect(report.decisions).toEqual([{
      id: `shard:${first}`,
      kind: "shard-group",
      reason: "capacity",
      sizeBytes: 7,
      lastAccessMs: now - 2 * DAY_MS,
    }]);
    expect(report.deletedFiles.map(({ kind }) => kind)).toEqual([
      "candidate",
      "admission",
      "shard",
    ]);
    expect(report.remainingBytes).toBe(7);
    expect(existsSync(retainedShard)).toBe(true);
  });

  it("counts admitted semantic regions, retains their shared context, and reclaims an orphan context", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const recent = now - DAY_MS;
    const contextAddress = digest("a");
    const orphanContextAddress = digest("b");
    const firstRegion = digest("c");
    const secondRegion = digest("d");
    const key = digest("e");
    const context = cacheFile(root, "semantic-context", contextAddress);
    const orphanContext = cacheFile(root, "semantic-context", orphanContextAddress);
    const firstShard = cacheFile(root, "semantic-shard", firstRegion, contextAddress);
    const secondShard = cacheFile(root, "semantic-shard", secondRegion, contextAddress);
    const firstAdmission = cacheFile(root, "admission", firstRegion, key);
    const secondAdmission = cacheFile(root, "admission", secondRegion, key);

    writeSized(context, 5, recent);
    writeSized(orphanContext, 4, recent);
    writeSized(firstShard, 7, recent);
    writeSized(secondShard, 8, recent);
    writeSized(firstAdmission, 2, recent);
    writeSized(secondAdmission, 3, recent);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 1_000,
        lowWaterBytes: 750,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report).toMatchObject({
      status: "completed",
      observedBytes: 29,
      observedFiles: 6,
      deletedBytes: 4,
      remainingBytes: 25,
    });
    expect(report.decisions).toEqual([{
      id: `semantic-context:${orphanContextAddress}`,
      kind: "semantic-region-context",
      reason: "orphan",
      sizeBytes: 4,
      lastAccessMs: recent,
    }]);
    expect(existsSync(context)).toBe(true);
    expect(existsSync(firstShard)).toBe(true);
    expect(existsSync(secondShard)).toBe(true);
    expect(existsSync(firstAdmission)).toBe(true);
    expect(existsSync(secondAdmission)).toBe(true);
    expect(existsSync(orphanContext)).toBe(false);
  });

  it("preserves ordinary unit grouping and delete order when semantic entries coexist", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const old = now - 31 * DAY_MS;
    const recent = now - DAY_MS;
    const unitAddress = digest("f");
    const base = digest("e");
    const key = digest("d");
    const contextAddress = digest("c");
    const regionAddress = digest("b");
    writeSized(cacheFile(root, "shard", unitAddress), 10, old);
    writeSized(cacheFile(root, "candidate", unitAddress, base), 2, old);
    writeSized(cacheFile(root, "admission", unitAddress, key), 3, old);
    const semanticContext = cacheFile(root, "semantic-context", contextAddress);
    const semanticShard = cacheFile(root, "semantic-shard", regionAddress, contextAddress);
    const semanticAdmission = cacheFile(root, "admission", regionAddress, key);
    writeSized(semanticContext, 2, recent);
    writeSized(semanticShard, 5, recent);
    writeSized(semanticAdmission, 1, recent);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 1_000,
        lowWaterBytes: 750,
      },
    });

    expect(report.observedBytes).toBe(23);
    expect(report.decisions).toEqual([{
      id: `shard:${unitAddress}`,
      kind: "shard-group",
      reason: "max-idle",
      sizeBytes: 15,
      lastAccessMs: old,
    }]);
    expect(report.deletedFiles.map(({ kind }) => kind)).toEqual([
      "candidate",
      "admission",
      "shard",
    ]);
    expect(report.remainingBytes).toBe(8);
    expect(existsSync(semanticContext)).toBe(true);
    expect(existsSync(semanticShard)).toBe(true);
    expect(existsSync(semanticAdmission)).toBe(true);
  });

  it("evicts idle semantic receipts before every shard and deletes their context last", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const old = now - 31 * DAY_MS;
    const contextAddress = digest("1");
    const firstRegion = digest("2");
    const secondRegion = digest("3");
    const key = digest("4");
    const context = cacheFile(root, "semantic-context", contextAddress);
    const firstShard = cacheFile(root, "semantic-shard", firstRegion, contextAddress);
    const secondShard = cacheFile(root, "semantic-shard", secondRegion, contextAddress);
    const firstAdmission = cacheFile(root, "admission", firstRegion, key);
    const secondAdmission = cacheFile(root, "admission", secondRegion, key);

    writeSized(context, 4, old);
    writeSized(firstShard, 6, old);
    writeSized(secondShard, 7, old);
    writeSized(firstAdmission, 2, old);
    writeSized(secondAdmission, 3, old);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 1_000,
        lowWaterBytes: 750,
      },
    });

    expect(report.decisions).toEqual([{
      id: `semantic-context:${contextAddress}`,
      kind: "semantic-region-group",
      reason: "max-idle",
      sizeBytes: 22,
      lastAccessMs: old,
    }]);
    expect(report.deletedFiles.map(({ kind }) => kind)).toEqual([
      "admission",
      "admission",
      "semantic-region-shard",
      "semantic-region-shard",
      "semantic-region-context",
    ]);
    expect(report.deletedFiles.at(-1)?.path).toBe(
      `semantic-region-contexts/${contextAddress.slice(0, 2)}/${contextAddress}.json`,
    );
    expect(report.deletedBytes).toBe(22);
    expect(report.remainingBytes).toBe(0);
  });

  it("retains receipt-less staged regions with a recently admitted sibling context", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const old = now - 31 * DAY_MS;
    const recent = now - DAY_MS;
    const contextAddress = digest("5");
    const admittedRegion = digest("6");
    const stagedRegion = digest("7");
    const key = digest("8");
    const context = cacheFile(root, "semantic-context", contextAddress);
    const admittedShard = cacheFile(root, "semantic-shard", admittedRegion, contextAddress);
    const stagedShard = cacheFile(root, "semantic-shard", stagedRegion, contextAddress);
    const admission = cacheFile(root, "admission", admittedRegion, key);

    writeSized(context, 4, old);
    writeSized(stagedShard, 7, old);
    writeSized(admittedShard, 6, recent);
    writeSized(admission, 2, recent);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 1_000,
        lowWaterBytes: 750,
      },
    });

    expect(report).toMatchObject({
      observedBytes: 19,
      deletedBytes: 0,
      remainingBytes: 19,
      decisions: [],
    });
    expect(existsSync(context)).toBe(true);
    expect(existsSync(admittedShard)).toBe(true);
    expect(existsSync(stagedShard)).toBe(true);
    expect(existsSync(admission)).toBe(true);
  });

  it("reclaims an entirely receipt-less semantic cluster with its context last", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const contextAddress = digest("9");
    const firstRegion = digest("a");
    const secondRegion = digest("b");
    const context = cacheFile(root, "semantic-context", contextAddress);
    const firstShard = cacheFile(root, "semantic-shard", firstRegion, contextAddress);
    const secondShard = cacheFile(root, "semantic-shard", secondRegion, contextAddress);
    writeSized(context, 4, now);
    writeSized(firstShard, 6, now);
    writeSized(secondShard, 7, now);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 1_000,
        lowWaterBytes: 750,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report.decisions).toEqual([{
      id: `semantic-context:${contextAddress}`,
      kind: "semantic-region-group",
      reason: "orphan",
      sizeBytes: 17,
      lastAccessMs: now,
    }]);
    expect(report.deletedFiles.map(({ kind }) => kind)).toEqual([
      "semantic-region-shard",
      "semantic-region-shard",
      "semantic-region-context",
    ]);
    expect(report.deletedFiles.at(-1)?.path).toContain("semantic-region-contexts/");
    expect(report.remainingBytes).toBe(0);
  });

  it("reclaims a semantic receipt and shard whose addressed context is missing", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const missingContext = digest("c");
    const regionAddress = digest("d");
    const key = digest("e");
    const shard = cacheFile(root, "semantic-shard", regionAddress, missingContext);
    const admission = cacheFile(root, "admission", regionAddress, key);
    writeSized(shard, 6, now);
    writeSized(admission, 2, now);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 1_000,
        lowWaterBytes: 750,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report.decisions).toEqual([{
      id: `semantic-region:${regionAddress}`,
      kind: "semantic-region-group",
      reason: "orphan",
      sizeBytes: 8,
      lastAccessMs: now,
    }]);
    expect(report.deletedFiles.map(({ kind }) => kind)).toEqual([
      "admission",
      "semantic-region-shard",
    ]);
    expect(existsSync(shard)).toBe(false);
    expect(existsSync(admission)).toBe(false);
  });

  it("includes semantic clusters in deterministic capacity pressure", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const oldContext = digest("9");
    const recentContext = digest("a");
    const oldRegion = digest("b");
    const recentRegion = digest("c");
    const key = digest("d");

    writeSized(cacheFile(root, "semantic-context", oldContext), 2, now - 2 * DAY_MS);
    writeSized(cacheFile(root, "semantic-shard", oldRegion, oldContext), 5, now - 2 * DAY_MS);
    writeSized(cacheFile(root, "admission", oldRegion, key), 1, now - 2 * DAY_MS);
    const retainedContext = cacheFile(root, "semantic-context", recentContext);
    const retainedShard = cacheFile(root, "semantic-shard", recentRegion, recentContext);
    writeSized(retainedContext, 2, now - DAY_MS);
    writeSized(retainedShard, 5, now - DAY_MS);
    writeSized(cacheFile(root, "admission", recentRegion, key), 1, now - DAY_MS);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 15,
        lowWaterBytes: 8,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report.capacityPressure).toBe(true);
    expect(report.observedBytes).toBe(16);
    expect(report.decisions).toEqual([{
      id: `semantic-context:${oldContext}`,
      kind: "semantic-region-group",
      reason: "capacity",
      sizeBytes: 8,
      lastAccessMs: now - 2 * DAY_MS,
    }]);
    expect(report.remainingBytes).toBe(8);
    expect(existsSync(retainedContext)).toBe(true);
    expect(existsSync(retainedShard)).toBe(true);
  });

  it("fails closed before mutation when one semantic region address appears under two contexts", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const old = now - 31 * DAY_MS;
    const firstContext = digest("1");
    const secondContext = digest("2");
    const regionAddress = digest("3");
    const key = digest("4");
    const firstContextPath = cacheFile(root, "semantic-context", firstContext);
    const secondContextPath = cacheFile(root, "semantic-context", secondContext);
    const firstShard = cacheFile(root, "semantic-shard", regionAddress, firstContext);
    const secondShard = cacheFile(root, "semantic-shard", regionAddress, secondContext);
    const admission = cacheFile(root, "admission", regionAddress, key);
    writeSized(firstContextPath, 2, old);
    writeSized(secondContextPath, 2, old);
    writeSized(firstShard, 3, old);
    writeSized(secondShard, 3, old);
    writeSized(admission, 1, old);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 5,
        lowWaterBytes: 4,
      },
    });

    expect(report).toMatchObject({
      status: "skipped",
      reason: "unsafe-cache-layout",
      observedBytes: 11,
      observedFiles: 5,
      remainingBytes: 11,
      deletedBytes: 0,
      decisions: [],
      deletedFiles: [],
    });
    expect(report.skippedEntries).toEqual([
      {
        path: `semantic-region-shards/${firstContext}/${regionAddress.slice(0, 2)}/${regionAddress}.json`,
        reason: "unsafe-entry",
      },
      {
        path: `semantic-region-shards/${secondContext}/${regionAddress.slice(0, 2)}/${regionAddress}.json`,
        reason: "unsafe-entry",
      },
    ]);
    expect(existsSync(firstContextPath)).toBe(true);
    expect(existsSync(secondContextPath)).toBe(true);
    expect(existsSync(firstShard)).toBe(true);
    expect(existsSync(secondShard)).toBe(true);
    expect(existsSync(admission)).toBe(true);
  });

  it.each([
    ["admission", "quarantine-failed"],
    ["semantic-region-shard", "quarantine-failed"],
  ] as const)(
    "preserves dependent semantic payloads when %s quarantine fails",
    async (failedKind, expectedReason) => {
      const root = temporaryDirectory();
      const now = Date.now();
      const old = now - 31 * DAY_MS;
      const contextAddress = digest("e");
      const regionAddress = digest("f");
      const key = digest("0");
      const context = cacheFile(root, "semantic-context", contextAddress);
      const shard = cacheFile(root, "semantic-shard", regionAddress, contextAddress);
      const admission = cacheFile(root, "admission", regionAddress, key);
      writeSized(context, 4, old);
      writeSized(shard, 6, old);
      writeSized(admission, 2, old);
      const failedPath = failedKind === "admission" ? admission : shard;

      const report = await sweepTypeScriptRevisionShardCache({
        cacheDir: root,
        exclusive,
        policy: {
          now: () => now,
          highWaterBytes: 1_000,
          lowWaterBytes: 750,
        },
        quarantineRename: async (source, destination) => {
          if (source === failedPath) {
            throw Object.assign(new Error("injected quarantine failure"), { code: "EACCES" });
          }
          renameSync(source, destination);
        },
      });

      expect(report.skippedEntries).toContainEqual({
        path: failedKind === "admission"
          ? `admissions/${key}/${regionAddress.slice(0, 2)}/${regionAddress}.json`
          : `semantic-region-shards/${contextAddress}/${regionAddress.slice(0, 2)}/${regionAddress}.json`,
        reason: expectedReason,
      });
      expect(report.skippedEntries).toContainEqual({
        path: `semantic-region-contexts/${contextAddress.slice(0, 2)}/${contextAddress}.json`,
        reason: "support-delete-failed",
      });
      expect(existsSync(shard)).toBe(true);
      expect(existsSync(context)).toBe(true);
      expect(existsSync(admission)).toBe(failedKind === "admission");
    },
  );

  it("reclaims failed shadow staging that has no admission receipt", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const address = digest("6");
    const base = digest("7");
    const shard = cacheFile(root, "shard", address);
    const candidate = cacheFile(root, "candidate", address, base);
    writeSized(shard, 8, now);
    writeSized(candidate, 2, now);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 1_000,
        lowWaterBytes: 750,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report.decisions).toEqual([{
      id: `shard:${address}`,
      kind: "shard-group",
      reason: "orphan",
      sizeBytes: 10,
      lastAccessMs: now,
    }]);
    expect(report.deletedFiles.map(({ kind }) => kind)).toEqual(["candidate", "shard"]);
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(shard)).toBe(false);
  });

  it("cleans only exact interrupted immutable-publication temporaries before accounting", async () => {
    const owner = temporaryDirectory();
    const root = join(owner, "cache");
    const outside = join(owner, "outside.json");
    const now = Date.now();
    const linkedAddress = digest("9");
    const loneAddress = digest("a");
    const linkedShard = cacheFile(root, "shard", linkedAddress);
    const linkedCandidate = cacheFile(root, "candidate", linkedAddress, digest("d"));
    const linkedAdmission = cacheFile(root, "admission", linkedAddress, digest("e"));
    const linkedTemporary = producerTemporary(linkedShard, 123);
    const loneTemporary = producerTemporary(cacheFile(root, "shard", loneAddress), 456);
    const symlinkAddress = digest("b");
    const symlinkTemporary = producerTemporary(
      cacheFile(root, "shard", symlinkAddress),
      789,
    );
    const lookalike = `${cacheFile(root, "shard", digest("c"))}.123.not-a-uuid.tmp`;

    writeSized(linkedShard, 10, now);
    writeSized(linkedCandidate, 2, now);
    writeSized(linkedAdmission, 1, now);
    linkSync(linkedShard, linkedTemporary);
    expect(lstatSync(linkedShard).nlink).toBe(2);
    writeSized(loneTemporary, 7, now);
    writeFileSync(outside, "outside");
    mkdirSync(dirname(symlinkTemporary), { recursive: true });
    symlinkSync(outside, symlinkTemporary);
    writeSized(lookalike, 5, now);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 1_000,
        lowWaterBytes: 750,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report).toMatchObject({
      status: "completed",
      observedBytes: 13,
      observedFiles: 3,
      remainingBytes: 13,
      drainedTemporaryBytes: 7,
      deletedBytes: 0,
    });
    expect(existsSync(linkedTemporary)).toBe(false);
    expect(existsSync(loneTemporary)).toBe(false);
    expect(lstatSync(linkedShard).nlink).toBe(1);
    expect(lstatSync(symlinkTemporary).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(existsSync(lookalike)).toBe(true);
    expect(report.skippedEntries).toContainEqual({
      path: `shards/${symlinkAddress.slice(0, 2)}/${basename(symlinkTemporary)}`,
      reason: "unsafe-entry",
    });
    expect(report.skippedEntries).toContainEqual({
      path: `shards/${digest("c").slice(0, 2)}/${basename(lookalike)}`,
      reason: "unsafe-entry",
    });
  });

  it("cleans exact-request index publication temporaries before grouping and accounting", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const tree = "1".repeat(40);
    const manifestAddress = digest("2");
    const keyId = digest("3");
    const requestKey = digest("4");
    const loneRequest = digest("5");
    const manifest = cacheFile(root, "manifest", manifestAddress, tree);
    const admission = cacheFile(
      root,
      "revision-manifest-admission",
      requestKey,
      keyId,
    );
    writeSized(manifest, 5, now);
    const admissionSize = writeRevisionManifestAdmission(admission, {
      keyId,
      requestKey,
      treeOid: tree,
      manifestAddress,
    }, now);
    const linkedTemporary = producerTemporary(admission, 123);
    const loneTemporary = producerTemporary(
      cacheFile(root, "revision-manifest-admission", loneRequest, keyId),
      456,
    );
    linkSync(admission, linkedTemporary);
    writeSized(loneTemporary, 7, now);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 10_000,
        lowWaterBytes: 7_500,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report).toMatchObject({
      observedBytes: admissionSize + 5,
      observedFiles: 2,
      drainedTemporaryBytes: 7,
      deletedBytes: 0,
      decisions: [],
    });
    expect(existsSync(linkedTemporary)).toBe(false);
    expect(existsSync(loneTemporary)).toBe(false);
    expect(lstatSync(admission).nlink).toBe(1);
    expect(existsSync(manifest)).toBe(true);
  });

  it("drains crash trash without following symlinks", async () => {
    const owner = temporaryDirectory();
    const root = join(owner, "cache");
    const outside = join(owner, "outside.txt");
    const trash = join(root, ".retention-trash", "stale");
    mkdirSync(trash, { recursive: true });
    writeFileSync(outside, "outside");
    writeFileSync(join(trash, "entry"), "trash");
    symlinkSync(outside, join(trash, "link"));

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
    });

    expect(report.status).toBe("completed");
    expect(report.drainedTrashBytes).toBeGreaterThanOrEqual(5);
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(existsSync(join(root, ".retention-trash"))).toBe(false);
  });

  it("never follows a cache-controlled directory symlink", async () => {
    const owner = temporaryDirectory();
    const root = join(owner, "cache");
    const outside = join(owner, "outside");
    const now = Date.now();
    const address = digest("5");
    const tree = "6".repeat(40);
    mkdirSync(join(root, "shards"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, `${address}.json`), "outside");
    symlinkSync(outside, join(root, "shards", address.slice(0, 2)));
    const manifest = cacheFile(root, "manifest", address, tree);
    writeSized(manifest, 5, now - 31 * DAY_MS);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 100,
        lowWaterBytes: 75,
      },
    });

    expect(report.skippedEntries).toContainEqual({
      path: `shards/${address.slice(0, 2)}`,
      reason: "unsafe-entry",
    });
    expect(existsSync(manifest)).toBe(false);
    expect(readFileSync(join(outside, `${address}.json`), "utf8")).toBe("outside");
  });

  it("never follows a semantic context prefix symlink", async () => {
    const owner = temporaryDirectory();
    const root = join(owner, "cache");
    const outside = join(owner, "semantic-outside");
    const now = Date.now();
    const contextAddress = digest("a");
    const regionAddress = digest("b");
    const linkedPrefix = join(
      root,
      "semantic-region-shards",
      contextAddress,
      regionAddress.slice(0, 2),
    );
    mkdirSync(dirname(linkedPrefix), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, `${regionAddress}.json`), "outside");
    symlinkSync(outside, linkedPrefix);
    const context = cacheFile(root, "semantic-context", contextAddress);
    writeSized(context, 5, now);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        highWaterBytes: 1_000,
        lowWaterBytes: 750,
        maxIdleMs: 365 * DAY_MS,
      },
    });

    expect(report.skippedEntries).toContainEqual({
      path: `semantic-region-shards/${contextAddress}/${regionAddress.slice(0, 2)}`,
      reason: "unsafe-entry",
    });
    expect(readFileSync(join(outside, `${regionAddress}.json`), "utf8")).toBe("outside");
    expect(existsSync(context)).toBe(false);
  });

  it("never follows an exact-request index prefix symlink", async () => {
    const owner = temporaryDirectory();
    const root = join(owner, "cache");
    const outside = join(owner, "exact-index-outside");
    const keyId = digest("c");
    const requestKey = digest("d");
    const linkedPrefix = join(
      root,
      "revision-manifest-admissions",
      keyId,
      requestKey.slice(0, 2),
    );
    mkdirSync(dirname(linkedPrefix), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, `${requestKey}.json`), "outside");
    symlinkSync(outside, linkedPrefix);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
    });

    expect(report.skippedEntries).toContainEqual({
      path: `revision-manifest-admissions/${keyId}/${requestKey.slice(0, 2)}`,
      reason: "unsafe-entry",
    });
    expect(readFileSync(join(outside, `${requestKey}.json`), "utf8")).toBe("outside");
  });

  it("rejects a symlinked cache root and leaves its target untouched", async () => {
    const owner = temporaryDirectory();
    const outside = join(owner, "outside");
    const linked = join(owner, "linked-cache");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "outside");
    symlinkSync(outside, linked);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: linked,
      exclusive,
    });

    expect(report).toMatchObject({ status: "skipped", reason: "unsafe-cache-root" });
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside");
  });

  it("aborts before mutation when the bounded active scan is exceeded", async () => {
    const root = temporaryDirectory();
    const now = Date.now();
    const address = digest("7");
    const base = digest("8");
    const shard = cacheFile(root, "shard", address);
    const candidate = cacheFile(root, "candidate", address, base);
    writeSized(shard, 4, now - 31 * DAY_MS);
    writeSized(candidate, 2, now - 31 * DAY_MS);

    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive,
      policy: {
        now: () => now,
        maxScanEntries: 4,
      },
    });

    expect(report).toMatchObject({
      status: "skipped",
      reason: "scan-limit-exceeded",
      observedFiles: 0,
      deletedFiles: [],
    });
    expect(existsSync(shard)).toBe(true);
    expect(existsSync(candidate)).toBe(true);
  });

  it("reports a busy exclusive lock without scanning", async () => {
    const root = temporaryDirectory();
    const busy = (async () => undefined) as TypeScriptRevisionShardRetentionExclusive;
    const report = await sweepTypeScriptRevisionShardCache({
      cacheDir: root,
      exclusive: busy,
    });
    expect(report).toMatchObject({
      status: "skipped",
      reason: "exclusive-coordination-busy",
      observedFiles: 0,
    });
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-shard-retention-"));
  roots.push(root);
  return root;
}

function digest(character: string): string {
  return character.repeat(64);
}

function cacheFile(
  root: string,
  kind:
    | "shard"
    | "candidate"
    | "admission"
    | "revision-manifest-admission"
    | "semantic-shard"
    | "semantic-context"
    | "manifest",
  address: string,
  owner?: string,
): string {
  switch (kind) {
    case "shard":
      return join(root, "shards", address.slice(0, 2), `${address}.json`);
    case "candidate":
      return join(root, "candidates", owner!, address.slice(0, 2), `${address}.json`);
    case "admission":
      return join(root, "admissions", owner!, address.slice(0, 2), `${address}.json`);
    case "revision-manifest-admission":
      return join(
        root,
        "revision-manifest-admissions",
        owner!,
        address.slice(0, 2),
        `${address}.json`,
      );
    case "semantic-shard":
      return join(
        root,
        "semantic-region-shards",
        owner!,
        address.slice(0, 2),
        `${address}.json`,
      );
    case "semantic-context":
      return join(root, "semantic-region-contexts", address.slice(0, 2), `${address}.json`);
    case "manifest":
      return join(root, "manifests", owner!, address.slice(0, 2), `${address}.json`);
  }
}

function writeSized(path: string, size: number, timestampMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x".repeat(size));
  const timestamp = new Date(timestampMs);
  utimesSync(path, timestamp, timestamp);
  expect(lstatSync(path).size).toBe(size);
}

function writeRevisionManifestAdmission(
  path: string,
  inputs: {
    keyId: string;
    requestKey: string;
    treeOid: string;
    manifestAddress: string;
  },
  timestampMs: number,
): number {
  const value = revisionManifestAdmissionValue(inputs);
  const canonicalValue = canonicalFlatJson(value);
  const payloadDigest = createHash("sha256").update(canonicalValue, "utf8").digest("hex");
  return writeText(
    path,
    `{"address":${JSON.stringify(inputs.requestKey)},`
      + `"format":"meridian.incremental-poc.immutable-json.v1",`
      + `"payloadDigest":${JSON.stringify(payloadDigest)},`
      + `"value":${canonicalValue}}`,
    timestampMs,
  );
}

function revisionManifestAdmissionValue(inputs: {
  keyId: string;
  requestKey: string;
  treeOid: string;
  manifestAddress: string;
}): {
  version: 1;
  shardSchemaVersion: number;
  manifestSchemaVersion: number;
  requestKey: string;
  treeOid: string;
  manifestAddress: string;
  manifestPayloadDigest: string;
  normalizedResultDigest: string;
  keyId: string;
  signature: string;
} {
  return {
    version: 1,
    shardSchemaVersion: 8,
    manifestSchemaVersion: 3,
    requestKey: inputs.requestKey,
    treeOid: inputs.treeOid,
    manifestAddress: inputs.manifestAddress,
    manifestPayloadDigest: inputs.manifestAddress,
    normalizedResultDigest: digest("0"),
    keyId: inputs.keyId,
    signature: "AA==",
  };
}

function canonicalFlatJson(value: object): string {
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${JSON.stringify(record[key])}`
  )).join(",")}}`;
}

function writeJson(path: string, value: unknown, timestampMs: number): number {
  return writeText(path, JSON.stringify(value), timestampMs);
}

function writeText(path: string, value: string, timestampMs: number): number {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
  const timestamp = new Date(timestampMs);
  utimesSync(path, timestamp, timestamp);
  return lstatSync(path).size;
}

function producerTemporary(canonicalPath: string, pid: number): string {
  return `${canonicalPath}.${pid}.123e4567-e89b-42d3-a456-426614174000.tmp`;
}
