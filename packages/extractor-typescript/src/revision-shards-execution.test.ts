import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractionProgress, ExtractionResult } from "@meridian/core";
import { extractRevisionDifferential } from "./incremental-poc/differential-revision";
import {
  extractRevisionCandidate,
  extractRevisionWithCache,
} from "./incremental-poc/extract-revision";
import {
  extractTypeScriptRevisionWithPolicy,
  type TypeScriptRevisionShardPolicy,
} from "./revision-shards";

vi.mock("./incremental-poc/differential-revision", () => ({
  extractRevisionDifferential: vi.fn(),
}));
vi.mock("./incremental-poc/extract-revision", () => ({
  extractRevisionCandidate: vi.fn(),
  extractRevisionWithCache: vi.fn(),
}));

const roots: string[] = [];
const INCREMENTAL = result("incremental");
const COLD = result("cold");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("TypeScript revision-shard execution modes", () => {
  it("uses a shared cache only in explicitly verified-experimental mode", async () => {
    vi.mocked(extractRevisionWithCache).mockResolvedValue({ result: INCREMENTAL } as never);
    const onProgress = (_progress: ExtractionProgress) => {};
    const options = {
      root: "/repo",
      supplementalFiles: ["packages/new/src/index.ts"],
      onProgress,
      includeExternal: true,
    };
    const policy = shardPolicy("verified-experimental");

    await expect(extractTypeScriptRevisionWithPolicy(options, policy)).resolves.toBe(INCREMENTAL);

    expect(extractRevisionWithCache).toHaveBeenCalledWith(expect.objectContaining({
      root: "/repo",
      cacheDir: policy.cacheDir,
      supplementalFiles: ["packages/new/src/index.ts"],
      onProgress,
      options: expect.objectContaining({ includeExternal: true }),
    }));
    expect(extractRevisionDifferential).not.toHaveBeenCalled();
  });

  it("serves the cold oracle after shadow parity", async () => {
    vi.mocked(extractRevisionDifferential).mockResolvedValue({
      incremental: { result: INCREMENTAL },
      cold: { result: COLD },
      differential: { equal: true },
    } as never);

    await expect(extractTypeScriptRevisionWithPolicy(
      { root: "/repo" },
      shardPolicy("shadow"),
    )).resolves.toBe(COLD);

    expect(extractRevisionDifferential).toHaveBeenCalledOnce();
    expect(extractRevisionWithCache).not.toHaveBeenCalled();
  });

  it("serves admitted shards plus canonical misses without publishing", async () => {
    vi.mocked(extractRevisionCandidate).mockResolvedValue({ result: INCREMENTAL } as never);

    await expect(extractTypeScriptRevisionWithPolicy(
      { root: "/repo" },
      shardPolicy("admitted"),
    )).resolves.toBe(INCREMENTAL);

    expect(extractRevisionCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/repo" }),
      { requiredAdmission: expect.objectContaining({ kind: "verifier" }) },
    );
    expect(extractRevisionDifferential).not.toHaveBeenCalled();
    expect(extractRevisionWithCache).not.toHaveBeenCalled();
  });

  it("runs the same shard pipeline against a disposable empty cache", async () => {
    const owner = mkdtempSync(join(tmpdir(), "meridian-shard-mode-test-"));
    roots.push(owner);
    vi.mocked(extractRevisionWithCache).mockResolvedValue({ result: COLD } as never);

    await expect(extractTypeScriptRevisionWithPolicy(
      { root: "/repo" },
      shardPolicy("empty", owner),
    )).resolves.toBe(COLD);

    const cacheDir = vi.mocked(extractRevisionWithCache).mock.calls[0]?.[0].cacheDir;
    expect(cacheDir).toContain(join(owner, "empty-runs", "run-"));
    expect(existsSync(cacheDir as string)).toBe(false);
  });
});

function shardPolicy(
  mode: "empty" | "shadow" | "admitted" | "verified-experimental",
  cacheDir = "/cache/typescript-revision-shards-v1",
): TypeScriptRevisionShardPolicy {
  const authority = admissionAuthority();
  return {
    version: 1 as const,
    mode,
    cacheDir,
    treeOid: "a".repeat(40),
    buildFingerprint: "b".repeat(64),
    analysisPolicyFingerprint: "c".repeat(64),
    admission: mode === "shadow"
      ? authority.signer
      : mode === "admitted"
        ? authority.verifier
        : null,
    runtimeFingerprint: {
      nodeVersion: "v26.0.0",
      platform: "linux",
      arch: "x64",
      typescriptVersion: "6.0.3",
      tsMorphVersion: "28.0.0",
    },
  };
}

function admissionAuthority() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const keyId = createHash("sha256").update(publicDer).digest("hex");
  return {
    signer: {
      version: 1 as const,
      kind: "signer" as const,
      keyId,
      publicKeySpki: publicDer.toString("base64"),
      privateKeyPkcs8: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer)
        .toString("base64"),
    },
    verifier: {
      version: 1 as const,
      kind: "verifier" as const,
      keyId,
      publicKeySpki: publicDer.toString("base64"),
    },
  };
}

function result(name: string): ExtractionResult {
  return {
    language: "typescript",
    nodes: [],
    edges: [],
    diagnostics: [],
    stats: {
      files: name.length,
      nodeCountByKind: {},
      edgeCountByResolution: {},
      summaryCoverage: { withSummary: 0, total: 0 },
      externalCallsDropped: 0,
      unresolvedCalls: 0,
    },
  };
}
