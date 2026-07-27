import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  requireTypeScriptRevisionShardPolicy,
  typeScriptRevisionShardDecision,
} from "./revision-shards";

describe("TypeScript revision-shard policy", () => {
  it("uses shards only for automatic multi-package extraction", () => {
    expect(typeScriptRevisionShardDecision({ root: "/repo" }, true)).toEqual({
      useShards: true,
    });
    expect(typeScriptRevisionShardDecision({
      root: "/repo",
      project: "/repo/tsconfig.json",
    }, true)).toEqual({
      useShards: false,
      reason: "explicit-project",
    });
    expect(typeScriptRevisionShardDecision({
      root: "/repo",
      include: ["src/**/*.ts"],
    }, true)).toEqual({
      useShards: false,
      reason: "explicit-include",
    });
    expect(typeScriptRevisionShardDecision({ root: "/repo" }, false)).toEqual({
      useShards: false,
      reason: "single-project-or-unsupported-workspace",
    });
  });

  it("admits supplemental files through the exact-tree fingerprinted workspace", () => {
    expect(typeScriptRevisionShardDecision({
      root: "/repo",
      supplementalFiles: ["unreferenced/changed.ts"],
    }, true)).toEqual({
      useShards: true,
    });
  });

  it("rejects mutable refs and incomplete provenance", () => {
    const admission = admissionSigner();
    const policy = {
      version: 1 as const,
      mode: "shadow" as const,
      cacheDir: "/cache/typescript-revision-shards-v1",
      treeOid: "a".repeat(40),
      buildFingerprint: "b".repeat(64),
      analysisPolicyFingerprint: "c".repeat(64),
      admission,
      runtimeFingerprint: {
        nodeVersion: "v26.0.0",
        platform: "linux",
        arch: "x64",
        typescriptVersion: "6.0.3",
        tsMorphVersion: "28.0.0",
      },
    };
    expect(requireTypeScriptRevisionShardPolicy(policy)).toBe(policy);
    expect(() => requireTypeScriptRevisionShardPolicy({
      ...policy,
      treeOid: "main",
    })).toThrow("invalid TypeScript revision-shard policy");
    expect(() => requireTypeScriptRevisionShardPolicy({
      ...policy,
      mode: "admitted",
    })).toThrow("invalid TypeScript revision-shard policy");
  });
});

function admissionSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    version: 1 as const,
    kind: "signer" as const,
    keyId: createHash("sha256").update(publicDer).digest("hex"),
    publicKeySpki: publicDer.toString("base64"),
    privateKeyPkcs8: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer)
      .toString("base64"),
  };
}
