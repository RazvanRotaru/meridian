import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact, SyntheticScenarioDescriptor } from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeRepository } from "../repository-analysis";
import { cachedRemoteGraph } from "./web-cache";
import { generateGraph } from "./web-generation";
import {
  materializeValidatedArtifact,
  verifiedArtifactFile,
  WebGraphStore,
} from "./web-graph-store";
import type { Context } from "./web-server";
import {
  loadSyntheticScenarios,
  syntheticExecutionRuntimeSupported,
  syntheticSourceFingerprint,
} from "./synthetic-execution";

vi.mock("../repository-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repository-analysis")>();
  return { ...actual, analyzeRepository: vi.fn() };
});
vi.mock("./web-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./web-cache")>();
  return { ...actual, cachedRemoteGraph: vi.fn() };
});
vi.mock("./synthetic-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./synthetic-execution")>();
  return {
    ...actual,
    loadSyntheticScenarios: vi.fn(),
    syntheticExecutionRuntimeSupported: vi.fn(),
    syntheticSourceFingerprint: vi.fn(),
  };
});

const COMMIT = "a".repeat(40);
const LOCAL_ARTIFACT = artifact("local", "2026-07-20T00:00:00.000Z");
const SCENARIO: SyntheticScenarioDescriptor = {
  id: "place-order",
  label: "Place order",
  rootId: "ts:src/index.ts#placeOrder",
  defaultInput: { orderId: "order-1" },
};

let root: string;
let graphStore: WebGraphStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-generation-store-test-"));
  graphStore = new WebGraphStore();
  vi.mocked(analyzeRepository).mockResolvedValue({ artifact: LOCAL_ARTIFACT, warnings: [] } as never);
  vi.mocked(syntheticExecutionRuntimeSupported).mockReturnValue(false);
  vi.mocked(loadSyntheticScenarios).mockReturnValue([]);
  vi.mocked(syntheticSourceFingerprint).mockReturnValue("fixture-fingerprint");
});

afterEach(() => {
  graphStore.dispose();
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("web graph generation publication", () => {
  it("keeps a local id stable only for the same source and exact artifact content", async () => {
    const ctx = context();
    const first = await generateGraph(ctx, { kind: "path", value: root }, undefined);
    const same = await generateGraph(ctx, { kind: "path", value: root }, undefined);
    const changedArtifact = { ...LOCAL_ARTIFACT, generatedAt: "2026-07-20T00:00:01.000Z" };
    vi.mocked(analyzeRepository).mockResolvedValueOnce({ artifact: changedArtifact, warnings: [] } as never);
    const changed = await generateGraph(ctx, { kind: "path", value: root }, undefined);

    expect(same.id).toBe(first.id);
    expect(changed.id).not.toBe(first.id);
    expect(graphStore.loadArtifact(first.id)).toStrictEqual(LOCAL_ARTIFACT);
    expect(graphStore.loadArtifact(changed.id)).toStrictEqual(changedArtifact);
    expect(graphStore.descriptor(first.id)).toMatchObject({
      id: first.id,
      sourceRoot: root,
      source: { kind: "path" },
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    });
  });

  it("computes the complete local synthetic capability before one publication", async () => {
    const ctx = context();
    ctx.allowSyntheticExecution = true;
    vi.mocked(syntheticExecutionRuntimeSupported).mockReturnValue(true);
    const publish = vi.spyOn(graphStore, "publish");
    vi.mocked(loadSyntheticScenarios).mockImplementation(() => {
      expect(publish).not.toHaveBeenCalled();
      return [SCENARIO];
    });

    const generated = await generateGraph(ctx, { kind: "path", value: root }, undefined);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(graphStore.descriptor(generated.id)?.synthetic).toEqual({
      scenarios: [SCENARIO],
      sourceFingerprint: "fixture-fingerprint",
      trust: { mode: "local" },
    });
    expect(syntheticSourceFingerprint).toHaveBeenCalledWith(root, LOCAL_ARTIFACT);

    vi.mocked(loadSyntheticScenarios).mockReturnValue([{ ...SCENARIO, label: "Place order safely" }]);
    vi.mocked(syntheticSourceFingerprint).mockReturnValue("changed-fingerprint");
    const changed = await generateGraph(ctx, { kind: "path", value: root }, undefined);

    expect(changed.id).not.toBe(generated.id);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(graphStore.descriptor(generated.id)?.synthetic.sourceFingerprint).toBe("fixture-fingerprint");
    expect(graphStore.descriptor(changed.id)?.synthetic.sourceFingerprint).toBe("changed-fingerprint");
  });

  it("publishes prepared cached materials under branch-specific remote ids", async () => {
    const ctx = context();
    const main = remoteFixture("main");
    const release = remoteFixture("release");
    vi.mocked(cachedRemoteGraph)
      .mockResolvedValueOnce(main.cached)
      .mockResolvedValueOnce(release.cached);
    const publish = vi.spyOn(graphStore, "publish");

    const first = await generateGraph(ctx, { kind: "github", value: "org/repo", ref: "main" }, undefined);
    const second = await generateGraph(ctx, { kind: "github", value: "org/repo", ref: "release" }, undefined);

    expect(first.id).not.toBe(second.id);
    expect(publish.mock.calls[0]?.[0].material).toMatchObject({ kind: "verified-file", path: main.path });
    expect(publish.mock.calls[1]?.[0].material).toMatchObject({ kind: "verified-file", path: release.path });
    expect(graphStore.loadArtifact(first.id)).toStrictEqual(main.artifact);
    expect(graphStore.loadArtifact(second.id)).toStrictEqual(release.artifact);
    expect(graphStore.descriptor(first.id)).toMatchObject({
      sourceRoot: root,
      source: { kind: "github", owner: "org", repo: "repo" },
    });
    expect(ctx.cacheJobs.size).toBe(0);
  });

  it("publishes a refreshed artifact as a new remote identity in the same server", async () => {
    const ctx = context();
    const original = remoteFixture("main");
    const refreshed = remoteFixture("main", "2026-07-20T00:00:01.000Z", "refreshed-main.json");
    vi.mocked(cachedRemoteGraph)
      .mockResolvedValueOnce(original.cached)
      .mockResolvedValueOnce(refreshed.cached);

    const first = await generateGraph(ctx, { kind: "github", value: "org/repo", ref: "main" }, undefined);
    ctx.refreshCache = true;
    const second = await generateGraph(ctx, { kind: "github", value: "org/repo", ref: "main" }, undefined);

    expect(second.id).not.toBe(first.id);
    expect(graphStore.loadArtifact(first.id)).toStrictEqual(original.artifact);
    expect(graphStore.loadArtifact(second.id)).toStrictEqual(refreshed.artifact);
  });
});

function context(): Context {
  return {
    graphStore,
    cwd: root,
    cacheRoot: root,
    cacheJobs: new Map(),
    refreshCache: false,
    allowSyntheticExecution: false,
  } as unknown as Context;
}

function remoteFixture(
  ref: string,
  generatedAt = "2026-07-20T00:00:00.000Z",
  file = `${ref}.json`,
) {
  const remoteArtifact = artifact("remote", generatedAt, ref);
  const path = join(root, file);
  const material = materializeValidatedArtifact(remoteArtifact);
  writeFileSync(path, material.bytes);
  const neutralArtifact = artifact("remote", generatedAt);
  const snapshotDigest = materializeValidatedArtifact(neutralArtifact).byteDigest;
  const fileMaterial = verifiedArtifactFile(path, material.byteDigest, material.summary);
  return {
    artifact: remoteArtifact,
    path: fileMaterial.path,
    cached: {
      analysisKey: "analysis-key",
      artifact: remoteArtifact,
      material: fileMaterial,
      snapshotDigest,
      cache: "hit" as const,
      checkout: {
        branch: ref,
        cache: "hit" as const,
        commit: COMMIT,
        repoDir: root,
        repositoryKey: "repository-key",
        remoteUrl: "https://github.com/org/repo.git",
      },
      sourceDir: root,
      target: "org/repo",
      warnings: [],
    },
  };
}

function artifact(name: string, generatedAt: string, branch?: string): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    generator: { name: "meridian", version: "test" },
    target: {
      name,
      root: ".",
      language: "typescript",
      ...(branch ? {
        vcs: { repository: "https://github.com/org/repo.git", commit: COMMIT, branch },
      } : {}),
    },
    nodes: [],
    edges: [],
  };
}
