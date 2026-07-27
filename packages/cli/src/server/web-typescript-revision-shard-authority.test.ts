import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { typeScriptRevisionShardAuthority } from "./web-typescript-revision-shard-authority";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TypeScript revision-shard admission authority", () => {
  it("atomically converges across callers and remains stable across restarts", async () => {
    const root = temporaryDirectory();
    const authorities = await Promise.all(
      Array.from({ length: 8 }, () => typeScriptRevisionShardAuthority(root)),
    );
    const reloaded = await typeScriptRevisionShardAuthority(root);

    expect(new Set(authorities.map(({ signer }) => signer.keyId))).toEqual(
      new Set([reloaded.signer.keyId]),
    );
    expect(reloaded.verifier).toEqual({
      version: 1,
      kind: "verifier",
      keyId: reloaded.signer.keyId,
      publicKeySpki: reloaded.signer.publicKeySpki,
    });
    const path = authorityPath(root);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it("fails closed for a symlinked authority file", async () => {
    const root = temporaryDirectory();
    const authorityRoot = join(root, "typescript-revision-shards-v1");
    mkdirSync(authorityRoot, { mode: 0o700 });
    const outside = join(root, "outside.json");
    writeFileSync(outside, "{}\n", { mode: 0o600 });
    symlinkSync(outside, authorityPath(root));

    await expect(typeScriptRevisionShardAuthority(root)).rejects.toThrow(
      /private regular file/,
    );
  });

  it("does not accept broad permissions or silently rotate invalid key material", async () => {
    const root = temporaryDirectory();
    const first = await typeScriptRevisionShardAuthority(root);
    const path = authorityPath(root);
    chmodSync(path, 0o644);
    await expect(typeScriptRevisionShardAuthority(root)).rejects.toThrow(
      /private regular file/,
    );

    chmodSync(path, 0o600);
    writeFileSync(path, "{\"formatVersion\":1}\n", { mode: 0o600 });
    await expect(typeScriptRevisionShardAuthority(root)).rejects.toThrow(
      /authority is invalid/,
    );

    writeFileSync(path, `${JSON.stringify({
      formatVersion: 1,
      keyId: "0".repeat(64),
      publicKeySpki: first.signer.publicKeySpki,
      privateKeyPkcs8: first.signer.privateKeyPkcs8,
    })}\n`, { mode: 0o600 });
    await expect(typeScriptRevisionShardAuthority(root)).rejects.toThrow(
      /keypair is invalid/,
    );
    expect(first.signer.keyId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects oversized authority metadata before parsing it", async () => {
    const root = temporaryDirectory();
    await typeScriptRevisionShardAuthority(root);
    writeFileSync(authorityPath(root), "x".repeat(8 * 1024 + 1), { mode: 0o600 });

    await expect(typeScriptRevisionShardAuthority(root)).rejects.toThrow(
      /invalid size/,
    );
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-shard-authority-"));
  roots.push(root);
  return root;
}

function authorityPath(root: string): string {
  return join(
    root,
    "typescript-revision-shards-v1",
    "admission-authority-v1.json",
  );
}
