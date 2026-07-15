import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "@meridian/core";
import type { ChangedFileManifestEntry, GraphArtifact } from "@meridian/core";
import { runGit } from "./git-exec";
import { cachedPrPreparation } from "./web-pr-cache";
import type {
  CachedPrPreparation,
  PrExtractionRunner,
  PrPreparationInputs,
} from "./web-pr-cache";
import type {
  RepositoryDetachedWorktreeLease,
  RepositoryMirrorStore,
  RepositoryWorktreeLease,
} from "./repository-mirror";
import type { ExtractionWorkerResult, SerializablePipelineRequest } from "./extraction-worker";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";
import { handlePrPrepare } from "./web-pr-prepare";
import { InspectionScheduler } from "./inspection-scheduler";
import { InspectionSnapshotStore, graphSummaryFor } from "./inspection-snapshot-store";
import { writeSyntheticCapabilitySidecar } from "./synthetic-capability-sidecar";
import { SessionStore } from "./session";
import { createGitHubClient } from "./github";
import type { Context } from "./web-server";
import { WebError } from "./web-error";

vi.mock("./git-exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-exec")>();
  return { ...actual, runGit: vi.fn() };
});

const HEAD_ONE = "1111111111111111111111111111111111111111";
const HEAD_TWO = "2222222222222222222222222222222222222222";
const BASE_ONE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE_TWO = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MERGE_BASE = "cccccccccccccccccccccccccccccccccccccccc";
const MANIFEST: ChangedFileManifestEntry[] = [
  { path: "src/added.ts", status: "added" },
  { path: "src/deleted.ts", status: "deleted" },
  { path: "src/modified.ts", status: "modified" },
  { path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed" },
];

let cacheRoot: string;
let baseSha = BASE_ONE;
let commitsByDirectory: Map<string, string>;
let headsByPr: Map<number, string>;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-pr-prepare-"));
  commitsByDirectory = new Map();
  headsByPr = new Map([[41, HEAD_ONE], [42, HEAD_TWO]]);
  baseSha = BASE_ONE;
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.mocked(runGit).mockImplementation(async (args, options) => {
    if (args[0] === "ls-remote") {
      const headRef = args.find((arg) => arg.startsWith("refs/pull/"));
      const pr = Number(headRef?.split("/")[2]);
      const head = headsByPr.get(pr);
      if (!head || !headRef) return "";
      const baseRef = args.find((arg) => arg.startsWith("refs/heads/")) ?? "refs/heads/main";
      return `${baseSha}\t${baseRef}\n${head}\t${headRef}\n`;
    }
    if (args[0] === "merge-base") return `${MERGE_BASE}\n`;
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      const commit = commitsByDirectory.get(options.cwd);
      if (!commit) throw new Error(`unknown fake worktree ${options.cwd}`);
      return `${commit}\n`;
    }
    throw new Error(`unexpected git command ${args.join(" ")}`);
  });
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("cachedPrPreparation", () => {
  it("extracts populated HEAD and merge-base sides concurrently", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const release = deferred<void>();
    let started = 0;
    const runner = fakeExtractionRunner({
      onAny: async () => {
        started += 1;
        await release.promise;
      },
    });
    const pending = cachedPrPreparation(inputs(41, mirrors, runner));

    try {
      await vi.waitFor(() => expect(started).toBe(2));
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("aborts and drains the peer extraction before a paired failure escapes", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const baseStarted = deferred<void>();
    let baseDrained = false;
    const runner: PrExtractionRunner = async (request, options) => {
      if (request.changedSince !== undefined) {
        await baseStarted.promise;
        throw new Error("HEAD extraction failed");
      }
      baseStarted.resolve();
      return await new Promise<ExtractionWorkerResult>((_resolve, reject) => {
        const signal = options.signal;
        const onAbort = () => {
          baseDrained = true;
          reject(signal?.reason ?? new Error("peer extraction aborted"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    };

    await expect(cachedPrPreparation(inputs(41, mirrors, runner))).rejects.toThrow("HEAD extraction failed");
    expect(baseDrained).toBe(true);
  });

  it("does not start a zero-subscriber shared-base flight after cancellation", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let baseExtractions = 0;
    const runner = fakeExtractionRunner({
      onBase: async () => {
        baseExtractions += 1;
      },
    });
    const controller = new AbortController();
    controller.abort(new DOMException("inspection cancelled", "AbortError"));

    await expect(cachedPrPreparation({
      ...inputs(41, mirrors, runner),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(baseExtractions).toBe(0);
  });

  it("singleflights one populated merge-base extraction across concurrent PRs", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const gate = deferred<void>();
    let baseExtractions = 0;
    const runner = fakeExtractionRunner({
      onBase: async () => {
        baseExtractions += 1;
        await gate.promise;
      },
    });
    const first = cachedPrPreparation(inputs(41, mirrors, runner));
    const second = cachedPrPreparation(inputs(42, mirrors, runner));

    await vi.waitFor(() => expect(baseExtractions).toBe(1));
    gate.resolve();
    const [left, right] = await Promise.all([first, second]);

    expect(left.headSha).toBe(HEAD_ONE);
    expect(right.headSha).toBe(HEAD_TWO);
    expect(left.mergeBase.artifactPath).toBe(right.mergeBase.artifactPath);
    expect(left.mergeBaseGenerationId).toBe(right.mergeBaseGenerationId);
    expect(left.head.artifactPath).not.toBe(right.head.artifactPath);
    expect(baseExtractions).toBe(1);
    expect(left.changedFiles).toEqual(MANIFEST);
    expect(runGit).toHaveBeenCalledWith(
      ["merge-base", expect.stringContaining("/base"), "HEAD"],
      expect.objectContaining({ cwd: expect.stringContaining("/worktrees/") }),
    );
  });

  it("does not alias empty merge-base artifacts selected by different hinted files", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: false });
    const baseRequests: SerializablePipelineRequest[] = [];
    const runner = fakeExtractionRunner({
      hintsByHead: new Map([[HEAD_ONE, ["pkg/a.ts"]], [HEAD_TWO, ["pkg/b.py"]]]),
      onBase: async (request) => { baseRequests.push(request); },
    });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner, "pkg"));
    const second = await cachedPrPreparation(inputs(42, mirrors, runner, "pkg"));

    expect(baseRequests).toHaveLength(2);
    expect(baseRequests.map((request) => request.hintedFiles)).toEqual([["pkg/a.ts"], ["pkg/b.py"]]);
    expect(baseRequests.every((request) => request.allowEmpty === true)).toBe(true);
    expect(first.mergeBase.artifactPath).not.toBe(second.mergeBase.artifactPath);
    expect(first.mergeBaseGenerationId).not.toBe(second.mergeBaseGenerationId);
  });

  it("prepares a whole-subtree deletion base-first and extracts an empty HEAD with base hints", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true, headHasSubdir: false });
    const calls: SerializablePipelineRequest[] = [];
    const result = await cachedPrPreparation(inputs(
      41,
      mirrors,
      fakeExtractionRunner({ onAny: async (request) => { calls.push(request); } }),
      "src",
    ));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ vcs: { commit: MERGE_BASE } });
    expect(calls[0].changedSince).toBeUndefined();
    expect(calls[1]).toMatchObject({
      vcs: { commit: HEAD_ONE },
      allowEmpty: true,
      hintedFiles: ["src/base.ts"],
      changedSinceLabel: MERGE_BASE,
    });
    expect(calls[1].changedSince).toMatch(/^refs\/meridian\/jobs\/.+\/commit$/);
    expect(result.mergeBase.graphSummary).toMatchObject({ nodeCount: 0, edgeCount: 0 });
  });

  it("treats a moved base tip as provenance when head and merge-base are unchanged", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    baseSha = BASE_TWO;
    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(first.baseSha).toBe(BASE_ONE);
    expect(second.baseSha).toBe(BASE_TWO);
    expect(second.cache).toBe("hit");
    expect(second.generationId).toBe(first.generationId);
    expect(second.mergeBaseGenerationId).toBe(first.mergeBaseGenerationId);
    expect(extractions).toBe(2); // one HEAD and one shared merge-base extraction
    expect(mirrors.prepare).toHaveBeenCalledTimes(2);
  });

  it("serves an exact warm hit without preparing a mirror worktree", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(second.generationId).toBe(first.generationId);
    expect(mirrors.prepare).toHaveBeenCalledTimes(1);
    expect(extractions).toBe(2);
  });

  it("rejects fresh extraction output bound to the wrong commit", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    const runner = fakeExtractionRunner({
      vcsCommitFor: (request) => request.changedSince ? HEAD_TWO : request.vcs?.commit ?? "",
    });

    await expect(cachedPrPreparation(inputs(41, mirrors, runner)))
      .rejects.toMatchObject({ status: 422 } satisfies Partial<WebError>);
  });

  it("treats a same-size artifact corruption as a miss and replaces the HEAD generation", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const original = readFileSync(first.head.artifactPath, "utf8");
    const corrupted = original.replace('"version":"test"', '"version":"tEst"');
    expect(Buffer.byteLength(corrupted)).toBe(Buffer.byteLength(original));
    expect(corrupted).not.toBe(original);
    writeFileSync(first.head.artifactPath, corrupted, { mode: 0o600 });

    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(second.cache).toBe("miss");
    expect(second.generationId).not.toBe(first.generationId);
    expect(extractions).toBe(3); // initial HEAD/base, then only the corrupt HEAD
    expect(mirrors.prepare).toHaveBeenCalledTimes(2);
  });

  it("rejects a cached projection manifest bound to a different commit", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const manifestPath = join(first.head.projectionDirectory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      header: { target: { vcs: { commit: string } } };
    };
    manifest.header.target.vcs.commit = HEAD_TWO;
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(second.cache).toBe("miss");
    expect(second.generationId).not.toBe(first.generationId);
    expect(extractions).toBe(3);
  });

  it("rejects cached HEAD projection metadata bound to a different merge base", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    writeFileSync(
      join(first.head.projectionDirectory, "changed-meta.json"),
      `${JSON.stringify({ baseRef: BASE_TWO })}\n`,
      { mode: 0o600 },
    );

    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(second.cache).toBe("miss");
    expect(second.generationId).not.toBe(first.generationId);
    expect(extractions).toBe(3);
  });

  it("keeps a canonical preparation usable when the optional exact-base alias cannot be written", async () => {
    const mirrors = fakeMirrors({ baseHasSubdir: true });
    let extractions = 0;
    const runner = fakeExtractionRunner({ onAny: async () => { extractions += 1; } });
    writeFileSync(join(cacheRoot, "pr-exact-lookups"), "blocked\n", { mode: 0o600 });

    const first = await cachedPrPreparation(inputs(41, mirrors, runner));
    const second = await cachedPrPreparation(inputs(41, mirrors, runner));

    expect(first.cache).toBe("miss");
    expect(existsSync(first.head.artifactPath)).toBe(true);
    expect(second.cache).toBe("hit");
    expect(second.generationId).toBe(first.generationId);
    expect(mirrors.prepare).toHaveBeenCalledTimes(2); // no accelerator alias; canonical fallback is used
    expect(extractions).toBe(2);
  });
});

describe("POST /api/pr/prepare transport", () => {
  it("emits only versioned progress/done records with two restart-safe descriptors", async () => {
    const prepared = standalonePreparation();
    const scheduler = new InspectionScheduler<string, PrPreparationInputs, CachedPrPreparation, { stage: "resolve"; elapsedMs: number }>({
      concurrency: 1,
      execute: ({ reportProgress }) => {
        reportProgress({ stage: "resolve", elapsedMs: 1.25 });
        return prepared;
      },
    });
    const ctx = handlerContext(scheduler as Context["prInspectionScheduler"]);
    const captured = capturedResponse();
    await handlePrPrepare(ctx, requestWith({
      owner: "Org",
      repo: "Repo.git",
      prNumber: 41,
      baseRef: "main",
      headRef: "feature/x",
    }), captured.response);

    const records = captured.lines();
    expect(captured.contentType()).toContain("application/x-ndjson");
    expect(records[0]).toEqual({ version: 1, type: "progress", stage: "resolve", elapsedMs: 1.25 });
    expect(records[1]).toMatchObject({
      version: 1,
      type: "done",
      headSha: HEAD_ONE,
      baseSha: BASE_ONE,
      mergeBaseSha: MERGE_BASE,
      changedFiles: MANIFEST,
      cache: "miss",
    });
    expect(records[1]).not.toHaveProperty("stage");
    expect(records.filter((record) => record.type === "done" || record.type === "error")).toHaveLength(1);
    for (const side of [records[1].head, records[1].mergeBase] as Array<Record<string, unknown>>) {
      expect(side).toMatchObject({
        graphId: expect.stringMatching(/^pr-(?:head|base)-/),
        manifestUrl: expect.stringContaining("/api/graph/manifest?id="),
        projectionUrl: expect.stringContaining("/api/graph/projection?id="),
        sourceUrl: expect.stringContaining("/api/source?id="),
        metaUrl: expect.stringContaining("/api/meta?id="),
        graphSummary: expect.objectContaining({ nodeCount: 0, edgeCount: 0 }),
      });
      expect(ctx.inspectionSnapshots.resolveDescriptor(side.graphId as string)).not.toBeNull();
    }
  });

  it("rejects the removed session id field at the strict request boundary", async () => {
    const ctx = handlerContext(new InspectionScheduler({ concurrency: 1, execute: () => standalonePreparation() }));
    await expect(handlePrPrepare(ctx, requestWith({
      id: "legacy-session",
      owner: "org",
      repo: "repo",
      prNumber: 41,
      baseRef: "main",
      headRef: "feature/x",
    }), capturedResponse().response)).rejects.toMatchObject({ status: 400 } satisfies Partial<WebError>);
  });

  it("uses distinct HEAD descriptor ids for branch aliases while sharing the base descriptor", async () => {
    const prepared = standalonePreparation();
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ctx = handlerContext(new InspectionScheduler({
      concurrency: 1,
      execute: async () => {
        executions += 1;
        await gate;
        return prepared;
      },
    }));
    const invokeAlias = async (headRef: string) => {
      const captured = capturedResponse();
      await handlePrPrepare(ctx, requestWith({
        owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef,
      }), captured.response);
      return captured.lines().find((record) => record.type === "done")!;
    };
    const firstPending = invokeAlias("feature/x");
    const secondPending = invokeAlias("users/alice/feature-x");
    await vi.waitFor(() => expect(executions).toBe(1));
    release();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(executions).toBe(1);
    expect((first.head as Record<string, unknown>).graphId)
      .not.toBe((second.head as Record<string, unknown>).graphId);
    expect((first.mergeBase as Record<string, unknown>).graphId)
      .toBe((second.mergeBase as Record<string, unknown>).graphId);
  });

  it("emits one bounded error record instead of an oversized done line", async () => {
    const prepared = standalonePreparation();
    prepared.changedFiles = Array.from({ length: 30_000 }, (_, index) => ({
      path: `src/${index}-${"x".repeat(80)}.ts`,
      status: "modified" as const,
    }));
    const ctx = handlerContext(new InspectionScheduler({ concurrency: 1, execute: () => prepared }));
    const captured = capturedResponse();
    await handlePrPrepare(ctx, requestWith({
      owner: "org", repo: "repo", prNumber: 41, baseRef: "main", headRef: "feature/x",
    }), captured.response);

    expect(captured.lines()).toEqual([{
      version: 1,
      type: "error",
      message: "PR preparation result exceeds the 2 MiB NDJSON line limit",
    }]);
  });
});

function inputs(
  prNumber: number,
  mirrors: RepositoryMirrorStore,
  runExtraction: PrExtractionRunner,
  subdir?: string,
): PrPreparationInputs {
  return {
    cacheRoot,
    request: {
      owner: "org",
      repo: "repo",
      ...(subdir ? { subdir } : {}),
      prNumber,
      baseRef: "main",
      headRef: `feature/${prNumber}`,
    },
    cwd: cacheRoot,
    repositoryMirrors: mirrors,
    runExtraction,
  };
}

function fakeMirrors(options: { baseHasSubdir: boolean; headHasSubdir?: boolean }): RepositoryMirrorStore {
  let sequence = 0;
  const makeLeasePaths = (commit: string) => {
    sequence += 1;
    const leaseId = createHash("sha256").update(`${sequence}:${commit}`).digest("hex");
    const root = join(cacheRoot, "repository-mirrors", "v1", "fake", "worktrees", leaseId);
    const metadata = join(cacheRoot, "repository-mirrors", "v1", "fake", "leases", `${leaseId}.json`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(metadata), { recursive: true, mode: 0o700 });
    writeFileSync(metadata, "{}\n", { mode: 0o600 });
    commitsByDirectory.set(realpathSync(root), commit);
    return { leaseId, root };
  };
  return {
    prepare: vi.fn(async (request) => {
      const head = makeLeasePaths(request.head.oid);
      if (options.baseHasSubdir && options.headHasSubdir !== false) {
        mkdirSync(join(head.root, "src"), { recursive: true });
        writeFileSync(join(head.root, "src", "head.ts"), "export const head = true;\n");
      } else {
        mkdirSync(join(head.root, "pkg"), { recursive: true });
        writeFileSync(join(head.root, "pkg", request.head.oid === HEAD_ONE ? "a.ts" : "b.py"), "value = 1\n");
      }
      const parent = leaseFor(head.leaseId, head.root, request.head.oid, request.base.oid);
      parent.prepareDetachedRevision = async ({ oid }) => {
        const base = makeLeasePaths(oid);
        if (options.baseHasSubdir) {
          mkdirSync(join(base.root, "src"), { recursive: true });
          writeFileSync(join(base.root, "src", "base.ts"), "export const base = true;\n");
        }
        return detachedLeaseFor(base.leaseId, base.root, oid);
      };
      return parent;
    }),
  } as unknown as RepositoryMirrorStore;
}

function leaseFor(leaseId: string, worktreeDir: string, headOid: string, baseOid: string): RepositoryWorktreeLease {
  return {
    leaseId,
    repositoryDigest: "fake",
    worktreeDir,
    headOid,
    baseOid,
    headRef: `refs/meridian/jobs/${leaseId}/head`,
    baseRef: `refs/meridian/jobs/${leaseId}/base`,
    prepareDetachedRevision: async () => { throw new Error("detached factory was not installed"); },
    touch() {},
    async release() {},
  };
}

function detachedLeaseFor(leaseId: string, worktreeDir: string, oid: string): RepositoryDetachedWorktreeLease {
  return {
    leaseId,
    repositoryDigest: "fake",
    worktreeDir,
    oid,
    ref: `refs/meridian/jobs/${leaseId}/commit`,
    touch() {},
    async release() {},
  };
}

function fakeExtractionRunner(options: {
  hintsByHead?: Map<string, string[]>;
  onBase?: (request: SerializablePipelineRequest) => Promise<void>;
  onAny?: (request: SerializablePipelineRequest) => Promise<void>;
  vcsCommitFor?: (request: SerializablePipelineRequest) => string;
} = {}): PrExtractionRunner {
  return async (request, worker) => {
    await options.onAny?.(request);
    const commit = request.vcs?.commit ?? "";
    const vcsCommit = options.vcsCommitFor?.(request) ?? commit;
    const isHead = request.changedSince !== undefined;
    if (!isHead) await options.onBase?.(request);
    const hintedFiles = isHead
      ? (options.hintsByHead?.get(commit) ?? ["src/head.ts"])
      : (request.hintedFiles ? [...request.hintedFiles] : ["src/base.ts"]);
    const changedFiles = isHead ? MANIFEST : [];
    const artifact: GraphArtifact = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-07-15T00:00:00.000Z",
      generator: { name: "meridian", version: "test" },
      target: {
        name: request.targetName ?? "org/repo",
        root: ".",
        language: hintedFiles.some((file) => file.endsWith(".py")) ? "python" : "typescript",
        ...(request.vcs ? { vcs: { ...request.vcs, commit: vcsCommit } } : {}),
      },
      telemetry: {
        joinKey: "node.id",
        requiredRuntimeAttributes: ["service.name", "deployment.environment.name"],
        serviceDefaulting: "forbidden",
      },
      nodes: [],
      edges: [],
      ...(isHead ? {
        extensions: { changedSince: { baseRef: request.changedSinceLabel, manifest: changedFiles } } as unknown as GraphArtifact["extensions"],
      } : {}),
    };
    const serialized = JSON.stringify(artifact);
    mkdirSync(dirname(worker.artifactOutputPath), { recursive: true, mode: 0o700 });
    writeFileSync(worker.artifactOutputPath, serialized, { mode: 0o600 });
    writeSyntheticCapabilitySidecar(worker.artifactOutputPath, dirname(worker.artifactOutputPath), artifact);
    const projectionDirectory = join(dirname(worker.artifactOutputPath), GRAPH_PROJECTION_DIRECTORY);
    writeGraphProjectionBundle(projectionDirectory, artifact);
    return {
      kind: "file",
      artifactPath: worker.artifactOutputPath,
      artifactBytes: Buffer.byteLength(serialized),
      artifactSha256: createHash("sha256").update(serialized).digest("hex"),
      projectionDirectory,
      graphSummary: graphSummaryFor(artifact),
      changedFiles,
      hintedFiles,
      ...(isHead ? { changedSinceBaseRef: request.changedSinceLabel } : {}),
      vcsCommit,
      warnings: [],
    } satisfies ExtractionWorkerResult;
  };
}

function standalonePreparation(): CachedPrPreparation {
  const head = standaloneSide("head", HEAD_ONE);
  const mergeBase = standaloneSide("base", MERGE_BASE);
  return {
    analysisKey: "analysis",
    repositoryKey: "repository",
    securityDigest: "security",
    generationId: "head-generation",
    mergeBaseGenerationId: "base-generation",
    headSha: HEAD_ONE,
    baseSha: BASE_ONE,
    mergeBaseSha: MERGE_BASE,
    changedFiles: MANIFEST,
    head,
    mergeBase,
    cache: "miss",
    timings: { resolve: 1.25 },
    warnings: [],
  };
}

function standaloneSide(name: string, commit: string) {
  const sideRoot = join(cacheRoot, name);
  const sourceRoot = join(cacheRoot, `${name}-source`);
  const artifactPath = join(sideRoot, "artifact.json");
  mkdirSync(sideRoot, { recursive: true, mode: 0o700 });
  mkdirSync(sourceRoot, { recursive: true });
  const artifact: GraphArtifact = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-07-15T00:00:00.000Z",
    generator: { name: "meridian", version: "test" },
    target: { name, root: ".", language: "typescript", vcs: { repository: "https://github.com/org/repo.git", commit } },
    telemetry: { joinKey: "node.id", requiredRuntimeAttributes: [], serviceDefaulting: "forbidden" },
    nodes: [],
    edges: [],
  };
  writeFileSync(artifactPath, JSON.stringify(artifact));
  writeSyntheticCapabilitySidecar(artifactPath, sourceRoot, artifact);
  const projectionDirectory = join(sideRoot, GRAPH_PROJECTION_DIRECTORY);
  writeGraphProjectionBundle(projectionDirectory, artifact);
  return { artifactPath, projectionDirectory, graphSummary: graphSummaryFor(artifact), sourceDir: sourceRoot, sourceRoot };
}

function handlerContext(scheduler: Context["prInspectionScheduler"]): Context {
  return {
    prInspectionScheduler: scheduler,
    inspectionSnapshots: new InspectionSnapshotStore({ cacheRoot }),
    repositoryMirrors: {} as RepositoryMirrorStore,
    runExtraction: async () => { throw new Error("unused"); },
    cacheRoot,
    refreshCache: false,
    cwd: cacheRoot,
    sessions: new SessionStore(),
    github: createGitHubClient({ clientId: "Iv1.test" }),
  } as unknown as Context;
}

function requestWith(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers: {},
    once: Readable.prototype.once,
    off: Readable.prototype.off,
  }) as unknown as IncomingMessage;
}

function capturedResponse() {
  let body = "";
  let contentType = "";
  const listeners = new Map<string, () => void>();
  const response = {
    writableEnded: false,
    writeHead(_status: number, headers?: Record<string, string>) {
      contentType = headers?.["content-type"] ?? "";
      return response;
    },
    setHeader() {},
    write(chunk: unknown) { body += String(chunk); return true; },
    end(chunk?: unknown) { if (chunk !== undefined) body += String(chunk); response.writableEnded = true; },
    once(event: string, listener: () => void) { listeners.set(event, listener); return response; },
    off(event: string) { listeners.delete(event); return response; },
  };
  return {
    response: response as unknown as ServerResponse,
    contentType: () => contentType,
    lines: () => body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
