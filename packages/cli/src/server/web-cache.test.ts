import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { runGit } from "./git-exec";
import type { ExtractionWorkerRunner } from "./extraction-worker";
import type {
  PrepareRepositoryWorktree,
  RepositoryWorktreeLease,
} from "./repository-mirror";
import { cachedRemoteGraph, webAnalysisKey } from "./web-cache";
import { checkoutFor, repositoryCacheKey } from "./web-cache-checkout";
import type { RepositoryMirrorPreparer } from "./web-cache-checkout";
import { probeRemoteGraph } from "./web-cache-probe";
import type { GenerateRequest } from "./web-request";
import { remoteArtifactId } from "./web-request";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";
import { measureGraphProjectionBundle } from "./graph-generation-verifier";
import { GraphGenerationLifecycle } from "./graph-generation-lifecycle";
import {
  graphGenerationStagingRoot,
  parseGraphGenerationStagePath,
  repositoryArtifactEntry,
} from "./graph-cache-layout";
import { removeEntry } from "./web-cache-storage";
import { OwnershipCleanupError } from "./ownership-cleanup";

vi.mock("./git-exec", () => ({
  base64Auth: (token: string) => Buffer.from(`x-access-token:${token}`, "utf8").toString("base64"),
  runGit: vi.fn(),
}));

const FIRST_COMMIT = "a".repeat(40);
const SECOND_COMMIT = "b".repeat(40);
const REQUEST: GenerateRequest = { kind: "github", value: "owner/repo" };

let cacheRoot: string;
let advertisedCommit: string;
let runExtraction: ExtractionWorkerRunner;
let mirror: ReturnType<typeof createMirror>;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-cache-test-"));
  advertisedCommit = FIRST_COMMIT;
  mirror = createMirror(cacheRoot);
  vi.mocked(runGit).mockImplementation(async (args) => {
    const branchRef = args.find((arg) => arg.startsWith("refs/heads/"));
    return args[0] === "ls-remote"
      ? `${advertisedCommit}\t${branchRef ?? "HEAD"}\n`
      : `${advertisedCommit}\n`;
  });
  runExtraction = vi.fn(writeExtractionResult);
});

afterEach(() => {
  removeEntry(cacheRoot);
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
    const artifactEntry = repositoryArtifactEntry(
      cacheRoot,
      current.checkout.repositoryKey,
      current.checkout.commit,
      current.analysisKey,
    );
    removeEntry(artifactEntry);
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
    expect(mirror.prepare).toHaveBeenCalledTimes(1);
    expect(runExtraction).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(second.sourceDir, "apps", "one", "index.ts"), "utf8")).toContain("one = 1");
    const extractionStage = dirname(vi.mocked(runExtraction).mock.calls[0]![1].artifactOutputPath);
    expect(parseGraphGenerationStagePath(realpathSync(cacheRoot), extractionStage)).not.toBeNull();
    expect(readdirSync(graphGenerationStagingRoot(cacheRoot))).toEqual([]);
    const artifactEntry = repositoryArtifactEntry(
      cacheRoot,
      first.checkout.repositoryKey,
      first.checkout.commit,
      first.analysisKey,
    );
    expect(readdirSync(join(artifactEntry, "generations"))).toEqual([first.generationId]);
  });

  it("releases its exact mutable stage when remote extraction fails", async () => {
    runExtraction = vi.fn(async () => {
      throw new Error("remote extraction failed");
    });

    await expect(generate(REQUEST)).rejects.toThrow("remote extraction failed");

    expect(readdirSync(graphGenerationStagingRoot(cacheRoot))).toEqual([]);
    const artifactEntry = repositoryArtifactEntry(
      cacheRoot,
      repositoryCacheKey("https://github.com/owner/repo.git"),
      FIRST_COMMIT,
      webAnalysisKey(REQUEST),
    );
    expect(existsSync(join(artifactEntry, "generations"))
      ? readdirSync(join(artifactEntry, "generations"))
      : []).toEqual([]);
  });

  it("preserves a falsy extraction failure before a mandatory source release failure", async () => {
    const sourceError = new Error("source operation release failed");
    const originalAcquireSource = mirror.store.acquireSource;
    mirror.store.acquireSource = async (reference, expectedWorktreeDir, purpose, signal) => ({
      ...await originalAcquireSource(reference, expectedWorktreeDir, purpose, signal),
      release: async () => { throw sourceError; },
    });
    runExtraction = vi.fn(async () => { throw 0; });

    const outcome = await generate(REQUEST).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(OwnershipCleanupError);
    expect((outcome as OwnershipCleanupError).errors).toEqual([0, sourceError]);
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
    expect(mirror.prepare).toHaveBeenCalledTimes(2);
    expect(runExtraction).toHaveBeenCalledTimes(2);
  });

  it("probes an unchanged graph without loading or regenerating it", async () => {
    const generated = await generate(REQUEST);

    const hit = await probeRemoteGraph({
      cacheRoot,
      request: REQUEST,
      cwd: cacheRoot,
      repositoryMirrors: mirror.store,
    });
    advertisedCommit = SECOND_COMMIT;
    const miss = await probeRemoteGraph({
      cacheRoot,
      request: REQUEST,
      cwd: cacheRoot,
      repositoryMirrors: mirror.store,
    });

    expect(hit).toEqual({ status: "hit", commit: FIRST_COMMIT, id: expect.any(String) });
    expect(hit.id).toHaveLength(24);
    expect(miss).toEqual({ status: "miss" });
    expect(mirror.prepare).toHaveBeenCalledTimes(1);
    expect(runExtraction).toHaveBeenCalledTimes(1);
    expect(generated.checkout.commit).toBe(FIRST_COMMIT);
  });

  it("shares one checkout across different subdirectory analyses", async () => {
    const first = await generate({ ...REQUEST, subdir: "apps/one" });
    const second = await generate({ ...REQUEST, subdir: "apps/two" });

    expect(first.analysisKey).not.toBe(second.analysisKey);
    expect(mirror.prepare).toHaveBeenCalledTimes(1);
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
    expect(mirror.prepare).toHaveBeenCalledTimes(1);
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
    const corruptGeneration = join(artifactPath, "generations", current.generationId);
    const corruptArtifact = join(corruptGeneration, "artifact.json");
    chmodSync(corruptGeneration, 0o700);
    chmodSync(corruptArtifact, 0o600);
    writeFileSync(corruptArtifact, "{broken", "utf8");

    const second = await generate(REQUEST);
    expect(second.cache).toBe("miss");
    expect(runExtraction).toHaveBeenCalledTimes(2);
  });

  it("forces re-extraction without preparing another worktree for the unchanged checkout", async () => {
    const original = await generate(REQUEST);
    const refreshed = await generate({ ...REQUEST, refresh: true });

    expect(refreshed.cache).toBe("miss");
    expect(refreshed.generationId).not.toBe(original.generationId);
    expect(refreshed.artifactPath).not.toBe(original.artifactPath);
    expect(existsSync(original.artifactPath)).toBe(true);
    expect(existsSync(refreshed.artifactPath)).toBe(true);
    expect(mirror.prepare).toHaveBeenCalledTimes(1);
    expect(runExtraction).toHaveBeenCalledTimes(2);
  });

  it("never persists the repository credential", async () => {
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
    expect(mirror.prepare.mock.calls[0][0]).toMatchObject({ token: undefined });
  });

  it("propagates lifecycle cancellation through revision lookup, mirror preparation, and extraction", async () => {
    const controller = new AbortController();
    let extractionSignal: AbortSignal | undefined;
    const runExtraction: ExtractionWorkerRunner = vi.fn(async (request, options) => {
      extractionSignal = options.signal;
      expect(extractionSignal?.aborted).toBe(false);
      const artifact = artifactFor(request.targetName ?? "repo", request.vcs?.commit ?? FIRST_COMMIT);
      const serialized = JSON.stringify(artifact);
      writeFileSync(options.artifactOutputPath, serialized);
      const projectionDirectory = join(dirname(options.artifactOutputPath), GRAPH_PROJECTION_DIRECTORY);
      const manifest = writeGraphProjectionBundle(projectionDirectory, artifact);
      const projectionIntegrity = await measureGraphProjectionBundle(projectionDirectory, cacheRoot);
      return {
        kind: "file" as const,
        artifactPath: options.artifactOutputPath,
        artifactBytes: Buffer.byteLength(serialized),
        artifactSha256: createHash("sha256").update(serialized).digest("hex"),
        projectionDirectory,
        ...projectionIntegrity,
        projectionContentId: manifest.contentId,
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
      repositoryMirrors: mirror.store,
      runExtraction,
      generationLifecycle: new GraphGenerationLifecycle({ cacheRoot }),
      onPrepareSource: () => {},
      onExtract: () => {},
    });

    expect(vi.mocked(runGit).mock.calls[0][1]).toMatchObject({ signal: controller.signal });
    expect(mirror.prepare.mock.calls[0][0]).toMatchObject({ signal: controller.signal });
    expect(runExtraction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ admitted: true }),
    );
    expect(extractionSignal).toBeDefined();
    const reason = new Error("cancel graph extraction");
    controller.abort(reason);
    expect(extractionSignal?.aborted).toBe(true);
    expect(extractionSignal?.reason).toBe(reason);
  });

  it("revalidates under the entry lock before repairing a concurrently published checkout", async () => {
    const remoteUrl = "https://github.com/owner/repo.git";
    const repositoryKey = repositoryCacheKey(remoteUrl);
    const checkoutEntry = join(cacheRoot, "repositories", repositoryKey, FIRST_COMMIT);
    const staleRepositoryDigest = "c".repeat(64);
    const staleLeaseId = "e".repeat(64);
    const staleRepositoryRoot = join(cacheRoot, "repository-mirrors", "v2", staleRepositoryDigest);
    const staleRepo = join(staleRepositoryRoot, "worktrees", staleLeaseId);
    const staleLeaseMetadata = join(staleRepositoryRoot, "leases", `${staleLeaseId}.json`);
    mkdirSync(staleRepo, { recursive: true });
    mkdirSync(dirname(staleLeaseMetadata), { recursive: true });
    writeFileSync(staleLeaseMetadata, JSON.stringify({ state: "active" }));
    mkdirSync(checkoutEntry, { recursive: true });
    writeFileSync(join(checkoutEntry, "metadata.json"), JSON.stringify({
      formatVersion: 4,
      repositoryKey,
      commit: FIRST_COMMIT,
      remoteUrl,
      sourceRoot: `repository-mirrors/v2/${staleRepositoryDigest}/worktrees/${staleLeaseId}`,
      leaseMetadata: `repository-mirrors/v2/${staleRepositoryDigest}/leases/${staleLeaseId}.json`,
      sourceLease: { repositoryDigest: staleRepositoryDigest, leaseId: staleLeaseId },
    }));
    const canonicalStaleRepo = realpathSync(staleRepo);

    let releaseStaleValidation: ((value: string) => void) | undefined;
    let announceStaleValidation: (() => void) | undefined;
    const staleValidationStarted = new Promise<void>((resolve) => { announceStaleValidation = resolve; });
    let staleRevParseCalls = 0;
    vi.mocked(runGit).mockImplementation(async (args, options) => {
      if (args[0] === "ls-remote") return `${FIRST_COMMIT}\tHEAD\n`;
      if (options.cwd !== canonicalStaleRepo) return `${FIRST_COMMIT}\n`;
      staleRevParseCalls += 1;
      if (staleRevParseCalls === 1) {
        announceStaleValidation?.();
        return new Promise<string>((resolve) => { releaseStaleValidation = resolve; });
      }
      return `${SECOND_COMMIT}\n`;
    });

    const firstOnPrepareSource = vi.fn();
    const staleRequest = checkoutFor(cacheRoot, REQUEST, cacheRoot, mirror.store, undefined, firstOnPrepareSource);
    await staleValidationStarted;
    const repairOnPrepareSource = vi.fn();
    const repaired = await checkoutFor(cacheRoot, REQUEST, cacheRoot, mirror.store, undefined, repairOnPrepareSource);
    releaseStaleValidation?.(`${SECOND_COMMIT}\n`);
    const revalidated = await staleRequest;

    expect(repaired.cache).toBe("miss");
    expect(revalidated.cache).toBe("hit");
    expect(revalidated.repoDir).toBe(repaired.repoDir);
    expect(repairOnPrepareSource).toHaveBeenCalledTimes(1);
    expect(firstOnPrepareSource).not.toHaveBeenCalled();
    expect(mirror.prepare).toHaveBeenCalledTimes(1);
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
    repositoryMirrors: mirror.store,
    runExtraction,
    generationLifecycle: new GraphGenerationLifecycle({ cacheRoot }),
    onPrepareSource: () => { stages.push("source"); },
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
  const manifest = writeGraphProjectionBundle(projectionDirectory, artifact);
  const projectionIntegrity = await measureGraphProjectionBundle(projectionDirectory, cacheRoot);
  return {
    kind: "file",
    artifactPath: options.artifactOutputPath,
    artifactBytes: Buffer.byteLength(serialized),
    artifactSha256: createHash("sha256").update(serialized).digest("hex"),
    projectionDirectory,
    ...projectionIntegrity,
    projectionContentId: manifest.contentId,
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

function createMirror(root: string): {
  store: RepositoryMirrorPreparer;
  prepare: ReturnType<typeof vi.fn>;
} {
  let sequence = 0;
  const prepare = vi.fn(async (request: PrepareRepositoryWorktree): Promise<RepositoryWorktreeLease> => {
    sequence += 1;
    const leaseId = createHash("sha256").update(`lease-${sequence}`).digest("hex");
    const repositoryDigest = "d".repeat(64);
    const repositoryRoot = join(root, "repository-mirrors", "v2", repositoryDigest);
    const worktreeDir = join(repositoryRoot, "worktrees", leaseId);
    const metadataPath = join(repositoryRoot, "leases", `${leaseId}.json`);
    mkdirSync(join(worktreeDir, "apps", "one"), { recursive: true });
    mkdirSync(join(worktreeDir, "apps", "two"), { recursive: true });
    mkdirSync(dirname(metadataPath), { recursive: true });
    writeFileSync(join(worktreeDir, "apps", "one", "index.ts"), "export const one = 1;\n");
    writeFileSync(join(worktreeDir, "apps", "two", "index.ts"), "export const two = 2;\n");
    writeFileSync(metadataPath, JSON.stringify({ state: "active" }));
    return {
      leaseId,
      repositoryDigest,
      worktreeDir,
      headOid: request.head.oid,
      baseOid: request.base.oid,
      headRef: request.head.ref,
      baseRef: request.base.ref,
      prepareDetachedRevision: async () => { throw new Error("not used by web cache tests"); },
      touch: () => {},
      release: async () => {},
    };
  });
  const retainSource = vi.fn(async () => true);
  const acquireSource: RepositoryMirrorPreparer["acquireSource"] = vi.fn(async (
    reference,
    expectedWorktreeDir,
    _purpose,
    signal,
  ) => {
    signal?.throwIfAborted();
    return {
      reference: { ...reference },
      worktreeDir: realpathSync(expectedWorktreeDir),
      signal: new AbortController().signal,
      renew: async () => {},
      release: async () => {},
    };
  });
  return { store: { prepare, retainSource, acquireSource }, prepare };
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
