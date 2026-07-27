import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  kind: "shard" | "candidate" | "admission" | "manifest",
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

function producerTemporary(canonicalPath: string, pid: number): string {
  return `${canonicalPath}.${pid}.123e4567-e89b-42d3-a456-426614174000.tmp`;
}
