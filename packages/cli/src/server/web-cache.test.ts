import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { runGit, runGitClone } from "./git-exec";
import type { ExtractionWorkerRunner } from "./extraction-worker";
import { cachedRemoteGraph, webAnalysisKey } from "./web-cache";
import { checkoutFor, repositoryCacheKey } from "./web-cache-checkout";
import { probeRemoteGraph } from "./web-cache-probe";
import type { GenerateRequest } from "./web-request";
import { remoteArtifactId } from "./web-request";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";

vi.mock("./git-exec", () => ({
  base64Auth: (token: string) => Buffer.from(`x-access-token:${token}`, "utf8").toString("base64"),
  runGit: vi.fn(),
  runGitClone: vi.fn(),
}));

const FIRST_COMMIT = "a".repeat(40);
const SECOND_COMMIT = "b".repeat(40);
const REQUEST: GenerateRequest = { kind: "github", value: "owner/repo" };

let cacheRoot: string;
let advertisedCommit: string;
let runExtraction: ExtractionWorkerRunner;

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
  runExtraction = vi.fn(writeExtractionResult);
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("persistent web graph cache", () => {
  it("keeps analysis identity and worker policy independent of retired environment switches", async () => {
    vi.stubEnv("MERIDIAN_VALUE_REFS", "0");
    const disabled = webAnalysisKey(REQUEST);
    vi.stubEnv("MERIDIAN_VALUE_REFS", "1");

    expect(webAnalysisKey(REQUEST)).toBe(disabled);
    await generate(REQUEST);
    expect(runExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        depth: "function",
        includeExternal: true,
        includeUnresolved: false,
        materializeBoundary: true,
        excludeTests: false,
        valueRefs: false,
      }),
      expect.any(Object),
    );
  });

  it("treats a direct-layout artifact as a cold miss and publishes a current generation", async () => {
    const current = await generate(REQUEST);
    const artifactEntry = join(
      cacheRoot,
      "artifacts",
      current.checkout.repositoryKey,
      current.checkout.commit,
      current.analysisKey,
    );
    rmSync(artifactEntry, { recursive: true, force: true });
    mkdirSync(artifactEntry, { recursive: true });
    writeFileSync(join(artifactEntry, "artifact.json"), JSON.stringify(artifactFor("owner/repo", FIRST_COMMIT)));
    writeFileSync(join(artifactEntry, "metadata.json"), JSON.stringify({
      formatVersion: 2,
      analysisVersion: 1,
      repositoryKey: current.checkout.repositoryKey,
      commit: FIRST_COMMIT,
      analysisKey: current.analysisKey,
      warnings: [],
    }));

    vi.mocked(runExtraction).mockClear();
    const stages: string[] = [];
    const result = await generate(REQUEST, undefined, stages);

    expect(result.cache).toBe("miss");
    expect(result.artifactPath).toBe(join(artifactEntry, "generations", result.generationId, "artifact.json"));
    expect(stages).toEqual(["extract"]);
    expect(runExtraction).toHaveBeenCalledTimes(1);
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
    expect(runExtraction).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(second.sourceDir, "apps", "one", "index.ts"), "utf8")).toContain("one = 1");
  });

  it("persists bounded worker warnings for cache hits", async () => {
    const warnings = ["Fake TypeScript: extractor warning", "validation warning"];
    vi.mocked(runExtraction).mockImplementationOnce(async (request, options) => ({
      ...await writeExtractionResult(request, options),
      warnings,
    }));

    const first = await generate(REQUEST);
    const second = await generate(REQUEST);
    const metadata = JSON.parse(readFileSync(
      join(dirname(first.artifactPath), "metadata.json"),
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
    expect(runExtraction).toHaveBeenCalledTimes(2);
  });

  it("probes an unchanged graph without loading or regenerating it", async () => {
    const generated = await generate(REQUEST);

    const hit = await probeRemoteGraph({ cacheRoot, request: REQUEST, cwd: cacheRoot });
    advertisedCommit = SECOND_COMMIT;
    const miss = await probeRemoteGraph({ cacheRoot, request: REQUEST, cwd: cacheRoot });

    expect(hit).toEqual({ status: "hit", commit: FIRST_COMMIT, id: expect.any(String) });
    expect(hit.id).toHaveLength(24);
    expect(miss).toEqual({ status: "miss" });
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(runExtraction).toHaveBeenCalledTimes(1);
    expect(generated.checkout.commit).toBe(FIRST_COMMIT);
  });

  it("shares one checkout across different subdirectory analyses", async () => {
    const first = await generate({ ...REQUEST, subdir: "apps/one" });
    const second = await generate({ ...REQUEST, subdir: "apps/two" });

    expect(first.analysisKey).not.toBe(second.analysisKey);
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(runExtraction).toHaveBeenCalledTimes(2);
  });

  it("shares one commit checkout and graph across refs without losing branch provenance", async () => {
    const fromHead = await generate(REQUEST);
    const fromMain = await generate({ ...REQUEST, ref: "main" });

    expect(fromHead.checkout.repositoryKey).toBe(fromMain.checkout.repositoryKey);
    expect(fromHead.checkout.branch).toBeUndefined();
    expect(fromMain.checkout.branch).toBe("main");
    expect(fromHead.generationId).toBe(fromMain.generationId);
    expect(remoteArtifactId(
      fromHead.checkout.repositoryKey, fromHead.checkout.commit, fromHead.analysisKey,
      fromHead.generationId, fromHead.checkout.branch ?? "",
    )).not.toBe(remoteArtifactId(
      fromMain.checkout.repositoryKey, fromMain.checkout.commit, fromMain.analysisKey,
      fromMain.generationId, fromMain.checkout.branch ?? "",
    ));
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(runExtraction).toHaveBeenCalledTimes(1);
  });

  it("treats a corrupt cached artifact as a miss", async () => {
    const first = await generate(REQUEST);
    const artifactPath = join(
      cacheRoot,
      "artifacts",
      first.checkout.repositoryKey,
      first.checkout.commit,
      first.analysisKey,
    );
    const current = JSON.parse(readFileSync(join(artifactPath, "current.json"), "utf8")) as { generationId: string };
    writeFileSync(join(artifactPath, "generations", current.generationId, "artifact.json"), "{broken", "utf8");

    const second = await generate(REQUEST);
    expect(second.cache).toBe("miss");
    expect(runExtraction).toHaveBeenCalledTimes(2);
  });

  it("forces re-extraction without cloning the unchanged checkout again", async () => {
    const original = await generate(REQUEST);
    const refreshed = await generate({ ...REQUEST, refresh: true });

    expect(refreshed.cache).toBe("miss");
    expect(refreshed.generationId).not.toBe(original.generationId);
    expect(refreshed.artifactPath).not.toBe(original.artifactPath);
    expect(existsSync(original.artifactPath)).toBe(true);
    expect(existsSync(refreshed.artifactPath)).toBe(true);
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(runExtraction).toHaveBeenCalledTimes(2);
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

  it("does not send an ambient GitHub token to a user-supplied non-GitHub host", async () => {
    const request: GenerateRequest = { kind: "github", value: "https://git.example/group/repo.git" };
    await generate(request, "ambient-github-token");

    expect(vi.mocked(runGit).mock.calls[0][1]).toMatchObject({ token: undefined });
    expect(vi.mocked(runGitClone).mock.calls[0][1]).toBeUndefined();
    expect(vi.mocked(runGitClone).mock.calls[0][0].join(" ")).not.toContain("http.extraHeader");
  });

  it("propagates lifecycle cancellation through revision lookup, clone, and extraction", async () => {
    const controller = new AbortController();
    const runExtraction: ExtractionWorkerRunner = vi.fn(async (request, options) => {
      const artifact = artifactFor(request.targetName ?? "repo", request.vcs?.commit ?? FIRST_COMMIT);
      const serialized = JSON.stringify(artifact);
      writeFileSync(options.artifactOutputPath, serialized);
      const projectionDirectory = join(dirname(options.artifactOutputPath), GRAPH_PROJECTION_DIRECTORY);
      writeGraphProjectionBundle(projectionDirectory, artifact);
      return {
        kind: "file" as const,
        artifactPath: options.artifactOutputPath,
        artifactBytes: Buffer.byteLength(serialized),
        artifactSha256: createHash("sha256").update(serialized).digest("hex"),
        projectionDirectory,
        graphSummary: {
          schemaVersion: artifact.schemaVersion,
          generatedAt: artifact.generatedAt,
          nodeCount: artifact.nodes.length,
          edgeCount: artifact.edges.length,
        },
        changedFiles: [],
        hintedFiles: [],
        vcsCommit: request.vcs?.commit,
        warnings: [],
      };
    });

    await cachedRemoteGraph({
      cacheRoot,
      request: REQUEST,
      cwd: cacheRoot,
      signal: controller.signal,
      extractionAdmitted: true,
      runExtraction,
      onClone: () => {},
      onExtract: () => {},
    });

    expect(vi.mocked(runGit).mock.calls[0][1]).toMatchObject({ signal: controller.signal });
    expect(vi.mocked(runGitClone).mock.calls[0][2]).toMatchObject({ signal: controller.signal });
    expect(runExtraction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal, admitted: true }),
    );
  });

  it("revalidates under the entry lock before repairing a concurrently published checkout", async () => {
    const remoteUrl = "https://github.com/owner/repo.git";
    const repositoryKey = repositoryCacheKey(remoteUrl);
    const checkoutEntry = join(cacheRoot, "repositories", repositoryKey, FIRST_COMMIT);
    mkdirSync(join(checkoutEntry, "repo"), { recursive: true });
    writeFileSync(join(checkoutEntry, "metadata.json"), JSON.stringify({
      formatVersion: 3,
      repositoryKey,
      commit: FIRST_COMMIT,
      remoteUrl,
    }));

    let releaseStaleValidation: ((value: string) => void) | undefined;
    let announceStaleValidation: (() => void) | undefined;
    const staleValidationStarted = new Promise<void>((resolve) => { announceStaleValidation = resolve; });
    let revParseCalls = 0;
    vi.mocked(runGit).mockImplementation(async (args) => {
      if (args[0] === "ls-remote") return `${FIRST_COMMIT}\tHEAD\n`;
      revParseCalls += 1;
      if (revParseCalls === 1) {
        announceStaleValidation?.();
        return new Promise<string>((resolve) => { releaseStaleValidation = resolve; });
      }
      // The repairing request observes the old checkout as invalid twice. Its staged clone,
      // published entry, and the first request's under-lock revalidation are all valid.
      return revParseCalls <= 3 ? `${SECOND_COMMIT}\n` : `${FIRST_COMMIT}\n`;
    });

    const firstOnClone = vi.fn();
    const staleRequest = checkoutFor(cacheRoot, REQUEST, cacheRoot, undefined, firstOnClone);
    await staleValidationStarted;
    const repairOnClone = vi.fn();
    const repaired = await checkoutFor(cacheRoot, REQUEST, cacheRoot, undefined, repairOnClone);
    releaseStaleValidation?.(`${SECOND_COMMIT}\n`);
    const revalidated = await staleRequest;

    expect(repaired.cache).toBe("miss");
    expect(revalidated.cache).toBe("hit");
    expect(revalidated.repoDir).toBe(repaired.repoDir);
    expect(repairOnClone).toHaveBeenCalledTimes(1);
    expect(firstOnClone).not.toHaveBeenCalled();
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(existsSync(join(checkoutEntry, "metadata.json"))).toBe(true);
    expect(existsSync(revalidated.repoDir)).toBe(true);
  });
});

function generate(
  request: GenerateRequest,
  token?: string,
  stages: string[] = [],
) {
  return cachedRemoteGraph({
    cacheRoot,
    request,
    cwd: cacheRoot,
    token,
    runExtraction,
    onClone: () => { stages.push("source"); },
    onExtract: () => { stages.push("extract"); },
  });
}

async function writeExtractionResult(
  request: Parameters<ExtractionWorkerRunner>[0],
  options: Parameters<ExtractionWorkerRunner>[1],
): ReturnType<ExtractionWorkerRunner> {
  const artifact = artifactFor(request.targetName ?? "repo", request.vcs?.commit ?? FIRST_COMMIT);
  const serialized = JSON.stringify(artifact);
  writeFileSync(options.artifactOutputPath, serialized);
  const projectionDirectory = join(dirname(options.artifactOutputPath), GRAPH_PROJECTION_DIRECTORY);
  writeGraphProjectionBundle(projectionDirectory, artifact);
  return {
    kind: "file",
    artifactPath: options.artifactOutputPath,
    artifactBytes: Buffer.byteLength(serialized),
    artifactSha256: createHash("sha256").update(serialized).digest("hex"),
    projectionDirectory,
    graphSummary: {
      schemaVersion: artifact.schemaVersion,
      generatedAt: artifact.generatedAt,
      nodeCount: artifact.nodes.length,
      edgeCount: artifact.edges.length,
    },
    changedFiles: [],
    hintedFiles: [],
    vcsCommit: request.vcs?.commit,
    warnings: [],
  };
}

function artifactFor(name: string, commit: string): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-13T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: {
      name,
      root: ".",
      language: "typescript",
      vcs: { repository: "https://github.com/owner/repo.git", commit },
    },
    nodes: [],
    edges: [],
  };
}
