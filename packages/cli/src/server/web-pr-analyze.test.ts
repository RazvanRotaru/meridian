/**
 * POST /api/pr/analyze behaviour with git and the extract pipeline mocked — no network, no real
 * git. Pins the miss stream, revision-addressed restart hit, force-push/base invalidation, blobless
 * full-history clone argv, token-only-in-extraHeader, and failed-stage cleanup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { analyzeRepository } from "../repository-analysis";
import { base64Auth, runGit, runGitClone } from "./git-exec";
import { handlePrAnalyze } from "./web-pr-analyze";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";
import { SessionStore } from "./session";
import { sendJson } from "./http-response";
import { WebError } from "./web-error";
import { createGitHubClient } from "./github";
import {
  loadSyntheticScenarios,
  syntheticSourceFingerprint,
} from "./synthetic-execution";

vi.mock("../repository-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repository-analysis")>();
  return { ...actual, analyzeRepository: vi.fn() };
});
vi.mock("./git-exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-exec")>();
  return { ...actual, runGit: vi.fn(), runGitClone: vi.fn() };
});
vi.mock("./synthetic-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./synthetic-execution")>();
  return {
    ...actual,
    loadSyntheticScenarios: vi.fn(() => []),
    syntheticSourceFingerprint: vi.fn(() => "fixture-fingerprint"),
  };
});

const ARTIFACT = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: "2026-07-13T00:00:00.000Z",
  generator: { name: "meridian", version: "test" },
  target: { name: "org/repo", root: ".", language: "typescript" },
  nodes: [],
  edges: [],
  extensions: { changedSince: { baseRef: "origin/main", files: { "src/a.ts": [[1, 3]] } } },
} as unknown as GraphArtifact;

const BODY = { id: "artifact", prNumber: 41, baseRef: "main", headRef: "feat/x" };
const HEAD_SHA = "abc1234def5678900000aaaabbbbccccddddeeee";
const BASE_SHA = "def1234def5678900000aaaabbbbccccddddeeee";
let cacheRoot: string;

describe("handlePrAnalyze", () => {
  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "meridian-pr-cache-test-"));
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.mocked(runGitClone).mockImplementation(async (args) => {
      mkdirSync(args.at(-1)!, { recursive: true });
    });
    mockGitRevisions();
    vi.mocked(analyzeRepository).mockResolvedValue({ artifact: ARTIFACT, warnings: ["w1"] } as never);
    vi.mocked(loadSyntheticScenarios).mockReturnValue([]);
    vi.mocked(syntheticSourceFingerprint).mockReturnValue("fixture-fingerprint");
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("streams clone -> checkout -> extract -> done and registers the persistent checkout", async () => {
    const ctx = githubCtx();
    ctx.allowSyntheticExecution = true; // The local-only flag must never admit a PR artifact.
    const captured = await invoke(ctx, BODY);
    expect(captured.status()).toBe(200);
    expect(captured.contentType()).toContain("application/x-ndjson");
    const lines = captured.lines();
    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);

    const done = lines[3];
    expect(done.graphId).toMatch(/^pr-[0-9a-f]{12}-[0-9a-f]{40}$/);
    expect(done.headSha).toBe("abc1234def5678900000aaaabbbbccccddddeeee");
    expect(String(done.graphId).endsWith(`-${done.headSha}`)).toBe(true);
    expect(done.counts).toEqual({ nodes: 0, edges: 0 });
    expect(done.changedFiles).toEqual([{ path: "src/a.ts", status: "modified" }]);
    expect(done.warnings).toEqual(["w1"]);

    const sourceDir = ctx.sourceRoots.get(done.graphId as string)!;
    expect(ctx.graphs.get(done.graphId as string)).toStrictEqual(ARTIFACT);
    expect(sourceDir).toContain(cacheRoot);
    expect(ctx.sources.get(done.graphId as string)).toMatchObject({ kind: "github", owner: "org", repo: "repo" });
    expect(ctx.syntheticScenarios.has(done.graphId as string)).toBe(false);
    expect(ctx.syntheticSourceFingerprints.has(done.graphId as string)).toBe(false);
    expect(ctx.syntheticExecutionTrust.has(done.graphId as string)).toBe(false);
    expect(ctx.tempCleanups.size).toBe(0);
    expect(existsSync(sourceDir)).toBe(true);
  });

  it("retains validated scenarios, fingerprint, and commit provenance only with PR opt-in plus OCI support", async () => {
    const ctx = githubCtx();
    ctx.allowSyntheticPrExecution = true;
    ctx.syntheticPrSandboxRuntimeSupported = () => true;
    vi.mocked(loadSyntheticScenarios).mockReturnValue([{
      id: "add-item",
      label: "Add item",
      rootId: "ts:src/api/cartRoutes.ts#CartRoutes.handleAddItem",
      defaultInput: { cartId: "cart-1" },
    }]);

    const done = (await invoke(ctx, BODY)).lines().at(-1)!;
    const graphId = done.graphId as string;
    expect(ctx.syntheticScenarios.get(graphId)).toEqual([expect.objectContaining({ id: "add-item" })]);
    expect(ctx.syntheticSourceFingerprints.get(graphId)).toBe("fixture-fingerprint");
    expect(ctx.syntheticExecutionTrust.get(graphId)).toEqual({
      mode: "sandboxed-pr",
      provenance: {
        repository: "org/repo",
        headSha: "abc1234def5678900000aaaabbbbccccddddeeee",
      },
    });
    expect(loadSyntheticScenarios).toHaveBeenCalledWith(ctx.sourceRoots.get(graphId));
    expect(syntheticSourceFingerprint).toHaveBeenCalledWith(ctx.sourceRoots.get(graphId), ARTIFACT);
    for (const cleanup of ctx.tempCleanups) cleanup();
  });

  it("retains sandbox provenance when enabled even when the PR has no authored scenarios", async () => {
    const ctx = githubCtx();
    ctx.allowSyntheticPrExecution = true;
    ctx.syntheticPrSandboxRuntimeSupported = () => true;

    const done = (await invoke(ctx, BODY)).lines().at(-1)!;
    const graphId = done.graphId as string;
    expect(ctx.syntheticScenarios.has(graphId)).toBe(false);
    expect(ctx.syntheticSourceFingerprints.has(graphId)).toBe(false);
    expect(ctx.syntheticExecutionTrust.get(graphId)).toEqual({
      mode: "sandboxed-pr",
      provenance: {
        repository: "org/repo",
        headSha: "abc1234def5678900000aaaabbbbccccddddeeee",
      },
    });
    expect(done.warnings).toEqual([
      "w1",
      "Synthetic execution needs a valid meridian.synthetic.json scenario manifest.",
    ]);
    for (const cleanup of ctx.tempCleanups) cleanup();
  });

  it("keeps the PR graph reviewable and leaks no details when its synthetic manifest is malformed", async () => {
    const ctx = githubCtx();
    ctx.allowSyntheticPrExecution = true;
    ctx.syntheticPrSandboxRuntimeSupported = () => true;
    vi.mocked(loadSyntheticScenarios).mockImplementation(() => {
      throw new Error("/tmp/private-clone: hostile <manifest> payload");
    });

    const captured = await invoke(ctx, BODY);
    const lines = captured.lines();
    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
    const done = lines.at(-1)!;
    const graphId = done.graphId as string;
    expect(ctx.graphs.get(graphId)).toStrictEqual(ARTIFACT);
    expect(ctx.syntheticScenarios.has(graphId)).toBe(false);
    expect(ctx.syntheticSourceFingerprints.has(graphId)).toBe(false);
    expect(ctx.syntheticExecutionTrust.has(graphId)).toBe(false);
    expect(done.warnings).toEqual([
      "w1",
      "Synthetic execution was disabled because the PR scenario manifest is invalid.",
    ]);
    expect(JSON.stringify(done)).not.toContain("/tmp/private-clone");
    expect(JSON.stringify(done)).not.toContain("hostile");
    for (const cleanup of ctx.tempCleanups) cleanup();
  });

  it("rejects a PR-controlled extraction subdir symlink before extracting or storing a capability", async () => {
    const outside = mkdtempSync(join(tmpdir(), "meridian-pr-outside-"));
    vi.mocked(runGitClone).mockImplementationOnce(async (args) => {
      const cloneRoot = args.at(-1)!;
      symlinkSync(outside, join(cloneRoot, "selected"));
    });
    const ctx = githubCtx({ kind: "github", owner: "org", repo: "repo", subdir: "selected" });
    ctx.allowSyntheticPrExecution = true;
    ctx.syntheticPrSandboxRuntimeSupported = () => true;
    try {
      const captured = await invoke(ctx, BODY);
      expect(captured.lines().map((line) => line.stage)).toEqual(["clone", "error"]);
      expect(ctx.graphs.size).toBe(0);
      expect(ctx.sourceRoots.size).toBe(0);
      expect(ctx.syntheticExecutionTrust.size).toBe(0);
      expect(analyzeRepository).not.toHaveBeenCalled();
      expect(existsSync(clonedDir())).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stores force-pushed heads under different commit-pinned graph ids", async () => {
    const ctx = githubCtx();
    const first = (await invoke(ctx, BODY)).lines().at(-1)!;
    mockGitRevisions("fff1234def5678900000aaaabbbbccccddddeeee");
    const second = (await invoke(ctx, BODY)).lines().at(-1)!;

    expect(first.headSha).not.toBe(second.headSha);
    expect(first.graphId).not.toBe(second.graphId);
    expect(ctx.graphs.has(first.graphId as string)).toBe(true);
    expect(ctx.graphs.has(second.graphId as string)).toBe(true);
    for (const cleanup of ctx.tempCleanups) cleanup();
  });

  it("reuses an unchanged PR artifact and checkout after a server restart", async () => {
    const first = (await invoke(githubCtx(), BODY)).lines();
    const restarted = githubCtx();
    const second = (await invoke(restarted, BODY)).lines();

    expect(first.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);
    expect(first.at(-1)?.cache).toBe("miss");
    expect(second.map((line) => line.stage)).toEqual(["done"]);
    expect(second.at(-1)?.cache).toBe("hit");
    expect(second.at(-1)?.graphId).toBe(first.at(-1)?.graphId);
    expect(second.at(-1)?.warnings).toEqual(["w1"]);
    expect(runGitClone).toHaveBeenCalledTimes(1);
    expect(analyzeRepository).toHaveBeenCalledTimes(1);
    expect(existsSync(restarted.sourceRoots.get(second.at(-1)?.graphId as string)!)).toBe(true);
  });

  it("runs canonical PR analysis without persisting or forwarding a language selector", async () => {
    const ctx = githubCtx();
    const done = (await invoke(ctx, BODY)).lines().at(-1)!;

    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeRepository).mock.calls[0][0]).not.toHaveProperty("language");
    expect(ctx.sources.get(done.graphId as string)).toEqual({
      kind: "github",
      owner: "org",
      repo: "repo",
    });
  });

  it("re-analyzes when the base branch moves even if the PR head is unchanged", async () => {
    const ctx = githubCtx();
    const first = (await invoke(ctx, BODY)).lines().at(-1)!;
    mockGitRevisions(HEAD_SHA, "main", "eee1234def5678900000aaaabbbbccccddddeeee");
    const second = (await invoke(ctx, BODY)).lines().at(-1)!;

    expect(second.headSha).toBe(first.headSha);
    expect(second.graphId).not.toBe(first.graphId);
    expect(runGitClone).toHaveBeenCalledTimes(2);
    expect(analyzeRepository).toHaveBeenCalledTimes(2);
  });

  it("clones full history and drives git in fetch-base, fetch-pr-head, detach order", async () => {
    await invoke(githubCtx(), BODY);
    const cloneArgs = vi.mocked(runGitClone).mock.calls[0][0];
    expect(cloneArgs).toContain("--no-tags");
    expect(cloneArgs).toContain("--filter=blob:none");
    expect(cloneArgs).toContain("--");
    expect(cloneArgs).not.toContain("--depth");
    expect(cloneArgs).not.toContain("--single-branch");
    const tmpDir = clonedDir();
    expect(vi.mocked(runGitClone).mock.calls[0][2]).toEqual({ timeoutMs: 600_000 });
    expect(runGit).toHaveBeenCalledWith(
      ["ls-remote", "--exit-code", "https://github.com/org/repo.git", "refs/heads/main", "refs/pull/41/head"],
      { cwd: "", token: "", timeoutMs: 300_000 },
    );
    expect(runGit).toHaveBeenCalledWith(
      ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      { cwd: tmpDir, token: "", timeoutMs: 300_000 },
    );
    expect(runGit).toHaveBeenCalledWith(["fetch", "origin", "pull/41/head"], { cwd: tmpDir, token: "", timeoutMs: 300_000 });
    expect(runGit).toHaveBeenCalledWith(["checkout", "--detach", "FETCH_HEAD"], { cwd: tmpDir, token: "", timeoutMs: 300_000 });
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledWith(
      expect.objectContaining({
        changedSince: "origin/main",
        changedSinceTimeoutMs: 300_000,
        changedSinceGitExecutor: expect.any(Function),
      }),
    );
  });

  it("puts the env token ONLY in the clone's -c http.extraHeader, never raw in argv", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    await invoke(githubCtx(), BODY);
    const cloneArgs = vi.mocked(runGitClone).mock.calls[0][0];
    expect(cloneArgs.slice(0, 2)).toEqual(["-c", `http.extraHeader=AUTHORIZATION: basic ${base64Auth("env_secret")}`]);
    expect(cloneArgs.join(" ")).not.toContain("env_secret");
    expect(vi.mocked(runGit).mock.calls[0][1]).toMatchObject({ token: "env_secret" });
    expect(vi.mocked(runGit).mock.calls[2][1]).toMatchObject({ token: "env_secret" });

    const executeDiff = vi.mocked(analyzeRepository).mock.calls[0][0].changedSinceGitExecutor;
    expect(executeDiff).toBeTypeOf("function");
    const diffArgs = ["diff", "--merge-base", "origin/main", "--relative", "--unified=0", "--no-color"];
    await executeDiff!("/tmp/private-repo", diffArgs, 300_000);
    expect(runGit).toHaveBeenLastCalledWith(diffArgs, {
      cwd: "/tmp/private-repo",
      token: "env_secret",
      timeoutMs: 300_000,
    });
  });

  it("emits exactly one error line mid-pipeline and removes the temp dir", async () => {
    const ctx = githubCtx();
    vi.mocked(runGit).mockImplementation(async (args) => {
      if (args[0] === "fetch") throw new WebError(422, "git failed: boom");
      return gitOutput(args, HEAD_SHA, "main");
    });
    const captured = await invoke(ctx, BODY);
    const lines = captured.lines();
    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "error"]);
    expect(lines[2].message).toBe("git failed: boom");
    expect(existsSync(clonedDir())).toBe(false);
    expect(ctx.graphs.size).toBe(0);
    expect(ctx.tempCleanups.size).toBe(0);
  });

  it("never echoes a non-WebError's text into the error line", async () => {
    vi.mocked(analyzeRepository).mockRejectedValueOnce(new Error("/tmp/leaky/path exploded"));
    const lines = (await invoke(githubCtx(), BODY)).lines();
    const errors = lines.filter((line) => line.stage === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("internal error while analyzing the pull request");
    expect(existsSync(clonedDir())).toBe(false);
  });

  it("rejects unsafe refs and non-integer PR numbers before touching git", async () => {
    for (const bad of [
      { ...BODY, baseRef: "--upload-pack=/bin/sh" },
      { ...BODY, headRef: "feat x; rm -rf /" },
      { ...BODY, prNumber: 0 },
      { ...BODY, prNumber: 1.5 },
      { ...BODY, prNumber: "41" },
    ]) {
      expect((await invoke(githubCtx(), bad)).status()).toBe(400);
    }
    expect(runGitClone).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  it("accepts the same valid Git branch names as repository generation", async () => {
    const body = { ...BODY, baseRef: "release+candidate@team", headRef: "unicode/ramură" };
    mockGitRevisions(HEAD_SHA, body.baseRef);
    const captured = await invoke(githubCtx(), body);

    expect(captured.status()).toBe(200);
    expect(runGit).toHaveBeenCalledWith(
      ["fetch", "origin", `+refs/heads/${body.baseRef}:refs/remotes/origin/${body.baseRef}`],
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it("404s a non-GitHub artifact source without streaming", async () => {
    const captured = await invoke(githubCtx({ kind: "other" }), BODY);
    expect(captured.status()).toBe(404);
    expect(runGitClone).not.toHaveBeenCalled();
  });
});

/** The temp clone dir is the last positional of the clone argv — how tests find what to check. */
function clonedDir(): string {
  const args = vi.mocked(runGitClone).mock.calls[0][0];
  return args[args.length - 1];
}

function mockGitRevisions(headSha = HEAD_SHA, baseRef = "main", baseSha = BASE_SHA): void {
  vi.mocked(runGit).mockImplementation(async (args) => gitOutput(args, headSha, baseRef, baseSha));
}

function gitOutput(args: string[], headSha: string, baseRef: string, baseSha = BASE_SHA): string {
  if (args[0] === "ls-remote") {
    return `${baseSha}\trefs/heads/${baseRef}\n${headSha}\trefs/pull/41/head\n`;
  }
  if (args[0] === "rev-parse") {
    return `${args[1] === "HEAD" ? headSha : baseSha}\n`;
  }
  return "";
}

async function invoke(ctx: Context, body: unknown) {
  const captured = capturedResponse();
  try {
    await handlePrAnalyze(ctx, requestWith(body), captured.response);
  } catch (error) {
    if (!(error instanceof WebError)) {
      throw error;
    }
    sendJson(captured.response, error.status, { error: error.message });
  }
  return captured;
}

function githubCtx(source: ArtifactSource = { kind: "github", owner: "org", repo: "repo" }): Context {
  return {
    graphs: new Map(),
    sourceRoots: new Map(),
    sources: new Map([["artifact", source]]),
    syntheticScenarios: new Map(),
    syntheticSourceFingerprints: new Map(),
    syntheticExecutionTrust: new Map(),
    prFilesCache: new Map(),
    tempCleanups: new Set(),
    rendererIndex: "",
    landingHtml: "",
    staticAssets: { rendererRoot: "", indexHtml: "" },
    cwd: "",
    sessions: new SessionStore(),
    github: createGitHubClient({ clientId: "Iv1.test" }),
    cacheRoot,
    cacheJobs: new Map(),
    refreshCache: false,
    allowSyntheticExecution: false,
    allowSyntheticPrExecution: false,
    syntheticPrSandboxRuntimeSupported: () => false,
  } as Context;
}

function requestWith(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {} }) as unknown as IncomingMessage;
}

function capturedResponse() {
  let status = 0;
  let contentType = "";
  let body = "";
  const response = {
    writeHead(code: number, headers?: Record<string, string>) {
      status = code;
      contentType = headers?.["content-type"] ?? "";
      return response;
    },
    write(chunk: unknown) {
      body += String(chunk);
      return true;
    },
    end(chunk?: unknown) {
      body += typeof chunk === "string" ? chunk : "";
    },
  } as unknown as ServerResponse;
  return {
    response,
    status: () => status,
    contentType: () => contentType,
    body: () => body,
    lines: () => body.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
