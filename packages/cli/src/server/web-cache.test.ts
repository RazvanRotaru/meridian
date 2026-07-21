import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { analyzeRepository } from "../repository-analysis";
import { runGit, runGitClone } from "./git-exec";
import { ANALYSIS_VERSION, cachedRemoteGraph, webAnalysisKey } from "./web-cache";
import { probeRemoteGraph } from "./web-cache-probe";
import { remoteArtifactId, type GenerateRequest } from "./web-request";

vi.mock("../repository-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repository-analysis")>();
  return { ...actual, analyzeRepository: vi.fn() };
});
vi.mock("./git-exec", () => ({
  base64Auth: (token: string) => Buffer.from(`x-access-token:${token}`, "utf8").toString("base64"),
  runGit: vi.fn(),
  runGitClone: vi.fn(),
}));

const FIRST_COMMIT = "a".repeat(64);
const SECOND_COMMIT = "b".repeat(64);
const LEGACY_ANALYSIS_VERSION_WITHOUT_RUNTIME_IMPORT_EDGES = 7;
const REQUEST: GenerateRequest = { kind: "github", value: "owner/repo" };

let cacheRoot: string;
let advertisedCommit: string;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-cache-test-"));
  advertisedCommit = FIRST_COMMIT;
  vi.mocked(runGit).mockImplementation(async (args) => {
    const branchRef = args.find((arg) => arg.startsWith("refs/heads/"));
    return args[0] === "ls-remote"
      ? `${advertisedCommit}\t${branchRef ?? "HEAD"}\n`
      : `${advertisedCommit}\n`;
  });
  vi.mocked(runGitClone).mockImplementation(async (args) => {
    const repoDir = args.at(-1)!;
    mkdirSync(join(repoDir, "apps", "one"), { recursive: true });
    mkdirSync(join(repoDir, "apps", "two"), { recursive: true });
    writeFileSync(join(repoDir, "apps", "one", "index.ts"), "export const one = 1;\n");
    writeFileSync(join(repoDir, "apps", "two", "index.ts"), "export const two = 2;\n");
  });
  vi.mocked(analyzeRepository).mockImplementation(async (request) => ({
    artifact: artifactFor(
      request.targetName ?? "repo",
      request.vcs?.commit ?? FIRST_COMMIT,
      request.vcs?.branch,
    ),
    warnings: [],
  }) as never);
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("persistent web graph cache", () => {
  it("does not vary analysis identity with the retired value-ref environment switch", () => {
    vi.stubEnv("MERIDIAN_VALUE_REFS", "0");
    const disabled = webAnalysisKey(REQUEST);
    vi.stubEnv("MERIDIAN_VALUE_REFS", "1");

    expect(webAnalysisKey(REQUEST)).toBe(disabled);
  });

  it("does not vary analysis identity with a retired language field from an older client", () => {
    const legacyRequest = { ...REQUEST, lang: "python" } as GenerateRequest & { lang: string };
    expect(webAnalysisKey(legacyRequest)).toBe(webAnalysisKey(REQUEST));
  });

  it("reuses both the checkout and artifact for an unchanged commit", async () => {
    const firstStages: string[] = [];
    const secondStages: string[] = [];
    const first = await generate(REQUEST, undefined, firstStages);
    const second = await generate(REQUEST, undefined, secondStages);

    expect(first.cache).toBe("miss");
    expect(first.checkout.cache).toBe("miss");
    expect(firstStages).toEqual(["source", "extract"]);
    expect(second.cache).toBe("hit");
    expect(second.checkout.cache).toBe("hit");
    expect(secondStages).toEqual([]);
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1);
    expect(first.material.kind).toBe("verified-file");
    expect(second.material.kind).toBe("verified-file");
    if (first.material.kind !== "verified-file" || second.material.kind !== "verified-file") {
      throw new Error("expected cache-backed materials");
    }
    expect(first.material.path).toContain(join(first.analysisKey, "snapshots"));
    expect(basename(first.material.path)).toBe("artifact.json");
    expect(FIRST_COMMIT).toHaveLength(64);
    expect(basename(dirname(first.material.path))).toMatch(/^[a-f0-9]{16}$/);
    expect(basename(dirname(first.material.path))).not.toContain(first.snapshotDigest);
    // 64-char object ids are Git's maximum supported width here. Keep enough of MAX_PATH free for
    // a realistic cache root instead of consuming it with the independent 64-char content digest.
    expect(relative(cacheRoot, first.material.path).length).toBeLessThanOrEqual(165);
    expect(second.material.path).toBe(first.material.path);
    expect(JSON.parse(readFileSync(second.material.path, "utf8"))).toEqual(second.artifact);
    expect(second.material.byteDigest).toBe(first.material.byteDigest);
    expect(first.snapshotDigest).toBe(first.material.byteDigest);
    expect(second.snapshotDigest).toBe(first.snapshotDigest);
    expect(readFileSync(join(second.sourceDir, "apps", "one", "index.ts"), "utf8")).toContain("one = 1");
  });

  it("persists analysis warnings for web cache hits", async () => {
    const warnings = ["Fake TypeScript: extractor warning", "validation warning"];
    vi.mocked(analyzeRepository).mockResolvedValueOnce({
      artifact: artifactFor("owner/repo", FIRST_COMMIT),
      warnings,
    } as never);

    const first = await generate(REQUEST);
    const second = await generate(REQUEST);
    const metadata = JSON.parse(readFileSync(
      join(dirname(verifiedPath(first)), "metadata.json"),
      "utf8",
    )) as { warnings?: string[] };

    expect(first.warnings).toEqual(warnings);
    expect(metadata.warnings).toEqual(warnings);
    expect(second.cache).toBe("hit");
    expect(second.warnings).toEqual(warnings);
  });

  it("creates a new immutable checkout and artifact when the remote commit changes", async () => {
    const first = await generate(REQUEST);
    advertisedCommit = SECOND_COMMIT;
    const second = await generate(REQUEST);

    expect(first.checkout.commit).toBe(FIRST_COMMIT);
    expect(second.checkout.commit).toBe(SECOND_COMMIT);
    expect(second.cache).toBe("miss");
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
  });

  it("probes an unchanged graph without loading or regenerating it", async () => {
    const generated = await generate(REQUEST);

    const hit = await probeRemoteGraph({ cacheRoot, request: REQUEST, cwd: cacheRoot });
    advertisedCommit = SECOND_COMMIT;
    const miss = await probeRemoteGraph({ cacheRoot, request: REQUEST, cwd: cacheRoot });

    expect(hit).toEqual({ status: "hit", commit: FIRST_COMMIT, id: expect.any(String) });
    expect(hit.id).toHaveLength(12);
    expect(miss).toEqual({ status: "miss" });
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1);
    expect(generated.checkout.commit).toBe(FIRST_COMMIT);
  });

  it("rejects legacy v7 metadata and regenerates after runtime import extraction", async () => {
    expect(ANALYSIS_VERSION).toBeGreaterThan(LEGACY_ANALYSIS_VERSION_WITHOUT_RUNTIME_IMPORT_EDGES);
    const first = await generate(REQUEST);
    const metadataPath = join(dirname(verifiedPath(first)), "metadata.json");
    const previousMetadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      analysisVersion: number;
    };
    previousMetadata.analysisVersion = LEGACY_ANALYSIS_VERSION_WITHOUT_RUNTIME_IMPORT_EDGES;
    writeFileSync(metadataPath, `${JSON.stringify(previousMetadata)}\n`, "utf8");

    const probe = await probeRemoteGraph({ cacheRoot, request: REQUEST, cwd: cacheRoot });
    const regenerated = await generate(REQUEST);
    const retainedLegacyMetadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      analysisVersion: number;
    };
    const currentMetadata = JSON.parse(readFileSync(
      join(dirname(verifiedPath(regenerated)), "metadata.json"),
      "utf8",
    )) as { analysisVersion: number };

    expect(probe).toEqual({ status: "miss", commit: FIRST_COMMIT });
    expect(regenerated.cache).toBe("miss");
    expect(verifiedPath(regenerated)).not.toBe(verifiedPath(first));
    expect(retainedLegacyMetadata.analysisVersion).toBe(LEGACY_ANALYSIS_VERSION_WITHOUT_RUNTIME_IMPORT_EDGES);
    expect(currentMetadata.analysisVersion).toBe(ANALYSIS_VERSION);
    expect(JSON.parse(readFileSync(verifiedPath(first), "utf8"))).toEqual(first.artifact);
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
  });

  it("shares one checkout across different subdirectory analyses", async () => {
    const first = await generate({ ...REQUEST, subdir: "apps/one" });
    const second = await generate({ ...REQUEST, subdir: "apps/two" });

    expect(first.analysisKey).not.toBe(second.analysisKey);
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
  });

  it("shares one commit checkout and graph across refs without losing branch provenance", async () => {
    const fromHead = await generate(REQUEST);
    const fromMain = await generate({ ...REQUEST, ref: "main" });
    const fromRelease = await generate({ ...REQUEST, ref: "release" });
    const fromHeadAgain = await generate(REQUEST);
    const headProbe = await probeRemoteGraph({ cacheRoot, request: REQUEST, cwd: cacheRoot });
    const mainProbe = await probeRemoteGraph({ cacheRoot, request: { ...REQUEST, ref: "main" }, cwd: cacheRoot });
    const releaseProbe = await probeRemoteGraph({
      cacheRoot,
      request: { ...REQUEST, ref: "release" },
      cwd: cacheRoot,
    });

    expect(fromHead.checkout.repositoryKey).toBe(fromMain.checkout.repositoryKey);
    expect(fromHead.artifact.target.vcs?.branch).toBeUndefined();
    expect(fromMain.artifact.target.vcs?.branch).toBe("main");
    expect(fromRelease.artifact.target.vcs?.branch).toBe("release");
    expect(fromHead.material.kind).toBe("verified-file");
    expect(fromMain.material.kind).toBe("serialized");
    expect(fromRelease.material.kind).toBe("serialized");
    expect(fromHeadAgain.material.kind).toBe("verified-file");
    expect(fromMain.material.byteDigest).not.toBe(fromHead.material.byteDigest);
    expect(fromRelease.material.byteDigest).not.toBe(fromMain.material.byteDigest);
    expect(fromHead.snapshotDigest).toBe(fromMain.snapshotDigest);
    expect(fromMain.snapshotDigest).toBe(fromRelease.snapshotDigest);
    expect(headProbe.status).toBe("hit");
    expect(mainProbe.status).toBe("hit");
    expect(releaseProbe.status).toBe("hit");
    expect(new Set([headProbe.id, mainProbe.id, releaseProbe.id]).size).toBe(3);
    expect(headProbe.id).toBe(idFor(fromHead, REQUEST));
    expect(mainProbe.id).toBe(idFor(fromMain, { ...REQUEST, ref: "main" }));
    expect(releaseProbe.id).toBe(idFor(fromRelease, { ...REQUEST, ref: "release" }));
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1);
  });

  it("keeps HEAD, main, and release identities and served provenance stable for every warm-up order", async () => {
    const refs = [undefined, "main", "release"] as const;
    const orders = [
      [refs[0], refs[1], refs[2]],
      [refs[0], refs[2], refs[1]],
      [refs[1], refs[0], refs[2]],
      [refs[1], refs[2], refs[0]],
      [refs[2], refs[0], refs[1]],
      [refs[2], refs[1], refs[0]],
    ] as const;
    const expectedIds = new Map<string, string>();
    const originalRoot = cacheRoot;
    const roots: string[] = [];
    try {
      for (const order of orders) {
        cacheRoot = mkdtempSync(join(tmpdir(), "meridian-cache-warm-order-"));
        roots.push(cacheRoot);
        const generated = new Map<string, Awaited<ReturnType<typeof generate>>>();
        for (const ref of order) {
          const request = requestFor(ref);
          generated.set(refKey(ref), await generate(request));
        }

        for (const ref of refs) {
          const request = requestFor(ref);
          const graph = generated.get(refKey(ref))!;
          const probe = await probeRemoteGraph({ cacheRoot, request, cwd: cacheRoot });
          const served = artifactFromMaterial(graph.material);
          const id = idFor(graph, request);

          expect(probe).toEqual({ status: "hit", commit: FIRST_COMMIT, id });
          expect(graph.artifact.target.vcs?.branch).toBe(ref);
          expect(served.target.vcs?.branch).toBe(ref);
          expect(graph.snapshotDigest).toBe(generated.get("HEAD")?.snapshotDigest);
          const previous = expectedIds.get(refKey(ref));
          if (previous === undefined) expectedIds.set(refKey(ref), id);
          else expect(id).toBe(previous);
        }
      }
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      cacheRoot = originalRoot;
    }
  });

  it("changes remote identity when refresh publishes changed branch-neutral content", async () => {
    const first = await generate({ ...REQUEST, ref: "main" });
    vi.mocked(analyzeRepository).mockResolvedValueOnce({
      artifact: {
        ...artifactFor("owner/repo", FIRST_COMMIT, "main"),
        generatedAt: "2026-07-20T00:00:01.000Z",
      },
      warnings: [],
    } as never);

    const refreshed = await generate({ ...REQUEST, ref: "main", refresh: true });
    const probe = await probeRemoteGraph({
      cacheRoot,
      request: { ...REQUEST, ref: "main" },
      cwd: cacheRoot,
    });

    expect(refreshed.snapshotDigest).not.toBe(first.snapshotDigest);
    expect(idFor(refreshed, { ...REQUEST, ref: "main" }))
      .not.toBe(idFor(first, { ...REQUEST, ref: "main" }));
    expect(probe.id).toBe(idFor(refreshed, { ...REQUEST, ref: "main" }));
  });

  it("treats a corrupt cached artifact as a miss", async () => {
    const first = await generate(REQUEST);
    const artifactPath = verifiedPath(first);
    writeFileSync(artifactPath, "{broken", "utf8");

    const second = await generate(REQUEST);
    expect(second.cache).toBe("miss");
    expect(verifiedPath(second)).not.toBe(artifactPath);
    expect(readFileSync(artifactPath, "utf8")).toBe("{broken");
    expect(JSON.parse(readFileSync(verifiedPath(second), "utf8"))).toEqual(second.artifact);
    const current = await generate(REQUEST);
    expect(current.cache).toBe("hit");
    expect(verifiedPath(current)).toBe(verifiedPath(second));
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
  });

  it("forces re-extraction without cloning the unchanged checkout again", async () => {
    await generate(REQUEST);
    const refreshed = await generate({ ...REQUEST, refresh: true });

    expect(refreshed.cache).toBe("miss");
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
  });

  it("keeps every generation readable across interleaved refresh publication", async () => {
    const original = await generate(REQUEST);
    const originalPath = verifiedPath(original);
    const originalBytes = readFileSync(originalPath);
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    const releaseA = deferred<void>();
    const releaseB = deferred<void>();
    let refreshGeneration = 0;
    vi.mocked(analyzeRepository).mockImplementation(async (request) => {
      const generation = ++refreshGeneration;
      (generation === 1 ? enteredA : enteredB).resolve();
      await (generation === 1 ? releaseA : releaseB).promise;
      return {
        artifact: {
          ...artifactFor(
            request.targetName ?? "repo",
            request.vcs?.commit ?? FIRST_COMMIT,
            request.vcs?.branch,
          ),
          generatedAt: `2026-07-20T00:00:0${generation}.000Z`,
        },
        warnings: [],
      } as never;
    });

    const pendingA = generate({ ...REQUEST, refresh: true });
    await enteredA.promise;
    const pendingB = generate({ ...REQUEST, refresh: true });
    await enteredB.promise;

    releaseB.resolve();
    const refreshedB = await pendingB;
    expect(readFileSync(originalPath)).toEqual(originalBytes);
    expect(JSON.parse(readFileSync(verifiedPath(refreshedB), "utf8"))).toEqual(refreshedB.artifact);

    releaseA.resolve();
    const refreshedA = await pendingA;
    expect(new Set([originalPath, verifiedPath(refreshedA), verifiedPath(refreshedB)]).size).toBe(3);
    expect(readFileSync(originalPath)).toEqual(originalBytes);
    expect(JSON.parse(readFileSync(verifiedPath(refreshedA), "utf8"))).toEqual(refreshedA.artifact);
    expect(JSON.parse(readFileSync(verifiedPath(refreshedB), "utf8"))).toEqual(refreshedB.artifact);

    const current = await generate(REQUEST);
    expect(current.cache).toBe("hit");
    expect(verifiedPath(current)).toBe(verifiedPath(refreshedA));
  });

  it("never persists the clone token", async () => {
    const token = "secret-cache-token";
    const result = await generate(REQUEST, token);
    const checkoutMetadata = readFileSync(
      join(cacheRoot, "repositories", result.checkout.repositoryKey, result.checkout.commit, "metadata.json"),
      "utf8",
    );
    expect(checkoutMetadata).not.toContain(token);
    expect(checkoutMetadata).toContain("https://github.com/owner/repo.git");
  });
});

function generate(request: GenerateRequest, token?: string, stages: string[] = []) {
  return cachedRemoteGraph({
    cacheRoot,
    request,
    cwd: cacheRoot,
    token,
    onClone: () => { stages.push("source"); },
    onExtract: () => { stages.push("extract"); },
  });
}

function artifactFor(name: string, commit: string, branch?: string): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-13T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: {
      name,
      root: ".",
      language: "typescript",
      vcs: {
        repository: "https://github.com/owner/repo.git",
        commit,
        ...(branch ? { branch } : {}),
      },
    },
    nodes: [],
    edges: [],
  };
}

function idFor(graph: Awaited<ReturnType<typeof generate>>, request: GenerateRequest): string {
  return remoteArtifactId(
    graph.checkout.repositoryKey,
    graph.checkout.commit,
    graph.analysisKey,
    request.ref,
    graph.snapshotDigest,
  );
}

function requestFor(ref: undefined | "main" | "release"): GenerateRequest {
  return ref === undefined ? REQUEST : { ...REQUEST, ref };
}

function refKey(ref: string | undefined): string {
  return ref ?? "HEAD";
}

function artifactFromMaterial(material: Awaited<ReturnType<typeof generate>>["material"]): GraphArtifact {
  const bytes = material.kind === "serialized" ? material.bytes : readFileSync(material.path);
  return JSON.parse(bytes.toString("utf8")) as GraphArtifact;
}

function verifiedPath(graph: Awaited<ReturnType<typeof generate>>): string {
  if (graph.material.kind !== "verified-file") {
    throw new Error("expected an immutable cache generation");
  }
  return graph.material.path;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
