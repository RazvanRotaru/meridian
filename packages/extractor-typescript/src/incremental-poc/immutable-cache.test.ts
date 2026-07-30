import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonical-json";
import {
  ImmutableCacheCollisionError,
  ImmutableCacheCorruptionError,
  listImmutableJsonCacheAddresses,
  readImmutableJsonCache,
  writeImmutableJsonCache,
} from "./immutable-cache";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "meridian-immutable-cache-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("immutable JSON cache", () => {
  it("atomically writes and reads a canonical entry with exact byte size", async () => {
    const address = sha256Hex("unit-inputs");
    const value = { z: 2, a: ["source.ts"] };

    const written = await writeImmutableJsonCache(root, address, value);
    const reread = await readImmutableJsonCache<typeof value>(root, address);

    expect(written.created).toBe(true);
    expect(reread?.value).toEqual(value);
    expect(reread?.payloadDigest).toBe(written.payloadDigest);
    expect(reread?.byteSize).toBe((await stat(written.path)).size);
    expect(await readFile(written.path, "utf8")).toBe(canonicalJson({
      address,
      format: "meridian.incremental-poc.immutable-json.v1",
      payloadDigest: written.payloadDigest,
      value,
    }));
  });

  it("deduplicates concurrent writes of the same payload", async () => {
    const address = sha256Hex("shared-inputs");
    const results = await Promise.all([
      writeImmutableJsonCache(root, address, { shard: 1 }),
      writeImmutableJsonCache(root, address, { shard: 1 }),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
  });

  it("rejects a different payload at an occupied address", async () => {
    const address = sha256Hex("colliding-input-key");
    await writeImmutableJsonCache(root, address, { shard: 1 });

    await expect(writeImmutableJsonCache(root, address, { shard: 2 }))
      .rejects.toBeInstanceOf(ImmutableCacheCollisionError);
  });

  it("detects malformed bytes", async () => {
    const address = sha256Hex("corrupt-input-key");
    const written = await writeImmutableJsonCache(root, address, { shard: 1 });
    await chmod(written.path, 0o644);
    await writeFile(written.path, "{");

    await expect(readImmutableJsonCache(root, address))
      .rejects.toBeInstanceOf(ImmutableCacheCorruptionError);
  });

  it("rejects an oversized sparse entry before allocating or reading its bytes", async () => {
    const address = sha256Hex("oversized-input-key");
    const written = await writeImmutableJsonCache(root, address, { shard: 1 });
    await chmod(written.path, 0o644);
    await truncate(written.path, 16 * 1024 * 1024);

    await expect(readImmutableJsonCache(root, address, {
      maxEntryBytes: 1024,
    })).rejects.toBeInstanceOf(ImmutableCacheCorruptionError);
  });

  it("bounds immutable address enumeration", async () => {
    const logicalRoot = join(root, "candidates");
    await mkdir(logicalRoot);
    await writeImmutableJsonCache(logicalRoot, sha256Hex("first"), { value: 1 });
    await writeImmutableJsonCache(logicalRoot, sha256Hex("second"), { value: 2 });

    await expect(listImmutableJsonCacheAddresses(logicalRoot, {
      trustedRoot: root,
      maxAddresses: 1,
    })).rejects.toThrow(/more than 1 addresses/);
  });

  it("rejects cache-controlled directory symlinks below the trusted root", async () => {
    const address = sha256Hex("nested-symlink");
    const logicalRoot = join(root, "shards");
    const outside = await mkdtemp(join(tmpdir(), "meridian-immutable-cache-outside-"));
    try {
      await mkdir(logicalRoot);
      await symlink(outside, join(logicalRoot, address.slice(0, 2)), "dir");

      await expect(writeImmutableJsonCache(
        logicalRoot,
        address,
        { shard: 1 },
        { trustedRoot: root },
      )).rejects.toThrow("not a real directory");
      await expect(listImmutableJsonCacheAddresses(
        logicalRoot,
        { trustedRoot: root },
      )).rejects.toThrow("not a trusted directory");
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
