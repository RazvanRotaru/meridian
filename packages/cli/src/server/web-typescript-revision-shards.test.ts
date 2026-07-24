import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "./git-exec";
import {
  parseTypeScriptRevisionShardMode,
  serverTypeScriptRevisionShardDecision,
  withServerTypeScriptRevisionShards,
} from "./web-typescript-revision-shards";

vi.mock("./git-exec", () => ({ runGit: vi.fn() }));

const roots: string[] = [];
const TREE = "a".repeat(40);
const BUILD = "b".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("server-owned TypeScript revision shards", () => {
  it("binds an exact Git root/tree to a server-selected cache and stable provenance", async () => {
    const root = temporaryDirectory();
    vi.mocked(runGit).mockResolvedValue(`${root}\n${TREE}\n`);

    const decision = await serverTypeScriptRevisionShardDecision({
      cacheRoot: join(root, "server-cache"),
      root,
      mode: "shadow",
      runtimeFingerprint: runtimeFingerprint(),
    });

    expect(decision).toEqual({
      kind: "enabled",
      policy: {
        version: 1,
        mode: "shadow",
        cacheDir: join(
          root,
          "server-cache",
          "typescript-revision-shards-v1",
          "shadow-admitted",
        ),
        treeOid: TREE,
        buildFingerprint: BUILD,
        analysisPolicyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        runtimeFingerprint: {
          nodeVersion: "v26.0.0",
          platform: "linux",
          arch: "x64",
          typescriptVersion: "6.0.3",
          tsMorphVersion: "28.0.0",
        },
      },
    });
    expect(decision).not.toHaveProperty("policy.runtimeFingerprint.processInstanceNonce");
  });

  it("conservatively falls back for a repository subdirectory", async () => {
    const root = temporaryDirectory();
    const subdir = join(root, "packages", "app");
    mkdirSync(subdir, { recursive: true });
    vi.mocked(runGit).mockResolvedValue(`${root}\n${TREE}\n`);

    await expect(serverTypeScriptRevisionShardDecision({
      cacheRoot: join(root, "server-cache"),
      root: subdir,
      mode: "verified-experimental",
      runtimeFingerprint: runtimeFingerprint(),
    })).resolves.toEqual({ kind: "fallback", reason: "not-exact-git-root" });
  });

  it("injects the capability out-of-band and leaves the analysis request untouched", async () => {
    const root = temporaryDirectory();
    vi.mocked(runGit).mockResolvedValue(`${root}\n${TREE}\n`);
    const repositoryAnalysis = vi.fn(async () => "result");
    const wrapped = withServerTypeScriptRevisionShards(
      repositoryAnalysis as never,
      join(root, "server-cache"),
      "empty",
    );
    const request = { absoluteRoot: root, cwd: root };

    await expect(wrapped(request, {
      artifactOutputPath: join(root, "artifact.json"),
    })).resolves.toBe("result");

    expect(request).toEqual({ absoluteRoot: root, cwd: root });
    expect(repositoryAnalysis).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        artifactOutputPath: join(root, "artifact.json"),
        typeScriptRevisionShards: expect.objectContaining({
          mode: "empty",
          cacheDir: join(root, "server-cache", "typescript-revision-shards-v1", "empty"),
          treeOid: TREE,
        }),
      }),
    );
  });

  it("rejects unknown opt-in modes before server startup", () => {
    expect(parseTypeScriptRevisionShardMode("shadow")).toBe("shadow");
    expect(() => parseTypeScriptRevisionShardMode("on")).toThrow(/must be one of/);
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-typescript-shards-"));
  roots.push(root);
  return root;
}

function runtimeFingerprint() {
  return {
    formatVersion: 1 as const,
    buildFingerprint: BUILD,
    processInstanceNonce: "c".repeat(32),
    nodeVersion: "v26.0.0",
    platform: "linux" as const,
    arch: "x64",
    typescriptVersion: "6.0.3",
    tsMorphVersion: "28.0.0",
  };
}
