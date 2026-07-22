import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit } from "./git-exec";
import {
  ANALYSIS_VERSION,
  CACHE_FORMAT_VERSION,
  webAnalysisKey,
  type ArtifactCachePointer,
  type ArtifactMetadata,
} from "./web-cache";
import { probeRemoteGraph } from "./web-cache-probe";
import { remoteArtifactId, type GenerateRequest } from "./web-request";
import { repositoryKeyFor } from "./web-repository-mirror";
import { FakeRepositoryMirror } from "./web-repository-mirror-test-fake";

vi.mock("./git-exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-exec")>();
  return { ...actual, runGit: vi.fn() };
});

const COMMIT = "a".repeat(64);
const REMOTE_URL = "https://github.com/owner/repo.git";
const REQUEST: GenerateRequest = { kind: "github", value: "owner/repo" };
const SNAPSHOT_DIGEST = "b".repeat(64);
const SNAPSHOT_ID = "c".repeat(16);

let cacheRoot: string;
let repositories: FakeRepositoryMirror;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-cache-probe-test-"));
  repositories = new FakeRepositoryMirror(join(cacheRoot, "repositories"));
  vi.mocked(runGit).mockImplementation(async (args) => {
    if (args[0] !== "ls-remote") throw new Error(`unexpected Git command: ${args.join(" ")}`);
    return `${COMMIT}\tHEAD\n`;
  });
});

afterEach(() => {
  repositories.releaseAllForTest();
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("remote graph cache probe", () => {
  it("short-circuits refresh without resolving or mutating repository state", async () => {
    const result = await probeRemoteGraph({
      cacheRoot,
      repositories,
      request: { ...REQUEST, refresh: true },
      cwd: cacheRoot,
    });

    expect(result).toEqual({ status: "miss" });
    expect(runGit).not.toHaveBeenCalled();
    expect(repositories.acquireCachedWorkspaceCalls).toEqual([]);
    expect(repositories.acquireWorkspaceCalls).toEqual([]);
    expect(repositories.leaseRecords).toEqual([]);
  });

  it("reports a non-mutating miss when the exact workspace is absent", async () => {
    const result = await probeRemoteGraph({ cacheRoot, repositories, request: REQUEST, cwd: cacheRoot });

    expect(result).toEqual({ status: "miss" });
    expect(repositories.acquireCachedWorkspaceCalls).toHaveLength(1);
    expect(repositories.acquireWorkspaceCalls).toEqual([]);
    expect(repositories.leaseRecords).toEqual([]);
  });

  it("releases a cached workspace when artifact metadata is absent", async () => {
    repositories.seedWorkspace(REMOTE_URL, COMMIT);

    const result = await probeRemoteGraph({ cacheRoot, repositories, request: REQUEST, cwd: cacheRoot });

    expect(result).toEqual({ status: "miss", commit: COMMIT });
    expect(repositories.acquireWorkspaceCalls).toEqual([]);
    expect(repositories.activeLeaseCount).toBe(0);
    expect(repositories.releasedLeaseCount).toBe(1);
  });

  it("returns the immutable graph id and releases its probe lease on a hit", async () => {
    repositories.seedWorkspace(REMOTE_URL, COMMIT);
    const { analysisKey } = seedArtifactCache();

    const result = await probeRemoteGraph({ cacheRoot, repositories, request: REQUEST, cwd: cacheRoot });

    expect(result).toEqual({
      status: "hit",
      commit: COMMIT,
      id: remoteArtifactId(repositoryKeyFor(REMOTE_URL), COMMIT, analysisKey, undefined, SNAPSHOT_DIGEST),
    });
    expect(repositories.acquireWorkspaceCalls).toEqual([]);
    expect(repositories.activeLeaseCount).toBe(0);
    expect(repositories.releasedLeaseCount).toBe(1);
  });

  it("rejects corrupt or legacy pointer metadata without a compatibility fallback", async () => {
    repositories.seedWorkspace(REMOTE_URL, COMMIT);
    const { pointerPath } = seedArtifactCache();
    writeFileSync(pointerPath, JSON.stringify({ formatVersion: CACHE_FORMAT_VERSION - 1 }), "utf8");

    const result = await probeRemoteGraph({ cacheRoot, repositories, request: REQUEST, cwd: cacheRoot });

    expect(result).toEqual({ status: "miss", commit: COMMIT });
    expect(repositories.acquireWorkspaceCalls).toEqual([]);
    expect(repositories.activeLeaseCount).toBe(0);
    expect(repositories.releasedLeaseCount).toBe(1);
  });

  it("releases its probe lease when subdirectory validation fails", async () => {
    repositories.seedWorkspace(REMOTE_URL, COMMIT);

    await expect(probeRemoteGraph({
      cacheRoot,
      repositories,
      request: { ...REQUEST, subdir: "missing" },
      cwd: cacheRoot,
    })).rejects.toThrow();

    expect(repositories.acquireWorkspaceCalls).toEqual([]);
    expect(repositories.activeLeaseCount).toBe(0);
    expect(repositories.releasedLeaseCount).toBe(1);
  });
});

function seedArtifactCache(): { analysisKey: string; pointerPath: string } {
  const analysisKey = webAnalysisKey(REQUEST);
  const repositoryKey = repositoryKeyFor(REMOTE_URL);
  const entry = join(cacheRoot, "artifacts", repositoryKey, COMMIT, analysisKey);
  const snapshot = join(entry, "snapshots", SNAPSHOT_ID);
  mkdirSync(snapshot, { recursive: true });
  const pointer: ArtifactCachePointer = {
    formatVersion: CACHE_FORMAT_VERSION,
    repositoryKey,
    commit: COMMIT,
    analysisKey,
    snapshotDigest: SNAPSHOT_DIGEST,
    snapshotId: SNAPSHOT_ID,
  };
  const metadata: ArtifactMetadata = {
    ...pointer,
    analysisVersion: ANALYSIS_VERSION,
    byteDigest: SNAPSHOT_DIGEST,
    byteLength: 3,
    facts: {
      summary: {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: "2026-07-22T00:00:00.000Z",
        nodeCount: 0,
        edgeCount: 0,
      },
      target: {
        name: "owner/repo",
        root: ".",
        language: "typescript",
        vcs: { repository: REMOTE_URL, commit: COMMIT },
      },
      changedFiles: [],
      emptySideHints: [],
      sourceFiles: [],
      changedSinceBaseRef: null,
      warnings: [],
    },
  };
  const pointerPath = join(entry, "metadata.json");
  writeFileSync(pointerPath, JSON.stringify(pointer), "utf8");
  writeFileSync(join(snapshot, "metadata.json"), JSON.stringify(metadata), "utf8");
  writeFileSync(join(snapshot, "artifact.json"), "{}\n", "utf8");
  return { analysisKey, pointerPath };
}
