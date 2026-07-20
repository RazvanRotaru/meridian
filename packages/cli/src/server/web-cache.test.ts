import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { analyzeRepository } from "../repository-analysis";
import { runGit, runGitClone } from "./git-exec";
import { cachedRemoteGraph, webAnalysisKey } from "./web-cache";
import { probeRemoteGraph } from "./web-cache-probe";
import type { GenerateRequest } from "./web-request";

vi.mock("../repository-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repository-analysis")>();
  return { ...actual, analyzeRepository: vi.fn() };
});
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
    artifact: artifactFor(request.targetName ?? "repo", request.vcs?.commit ?? FIRST_COMMIT),
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
    const metadata = JSON.parse(readFileSync(join(
      cacheRoot,
      "artifacts",
      first.checkout.repositoryKey,
      first.checkout.commit,
      first.analysisKey,
      "metadata.json",
    ), "utf8")) as { warnings?: string[] };

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

    expect(fromHead.checkout.repositoryKey).toBe(fromMain.checkout.repositoryKey);
    expect(fromHead.artifact.target.vcs?.branch).toBeUndefined();
    expect(fromMain.artifact.target.vcs?.branch).toBe("main");
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1);
  });

  it("treats a corrupt cached artifact as a miss", async () => {
    const first = await generate(REQUEST);
    const artifactPath = join(
      cacheRoot,
      "artifacts",
      first.checkout.repositoryKey,
      first.checkout.commit,
      first.analysisKey,
      "artifact.json",
    );
    writeFileSync(artifactPath, "{broken", "utf8");

    const second = await generate(REQUEST);
    expect(second.cache).toBe("miss");
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
  });

  it("forces re-extraction without cloning the unchanged checkout again", async () => {
    await generate(REQUEST);
    const refreshed = await generate({ ...REQUEST, refresh: true });

    expect(refreshed.cache).toBe("miss");
    expect(vi.mocked(runGitClone)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(2);
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
