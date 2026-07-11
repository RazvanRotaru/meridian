/**
 * POST /api/pr/analyze behaviour with git and the extract pipeline mocked — no network, no real
 * git. Pins the NDJSON contract (clone → checkout → extract → done, or exactly one error line),
 * the blobless full-history clone argv (no --depth/--single-branch), token-only-in-extraHeader, and the
 * generate-mirroring temp lifecycle: retained + registered for exit cleanup on success, removed
 * immediately on failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GraphArtifact } from "@meridian/core";
import { extractToArtifact } from "../extract-pipeline";
import { base64Auth, runGit, runGitClone } from "./git-exec";
import { handlePrAnalyze } from "./web-pr-analyze";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";
import { SessionStore } from "./session";
import { sendJson } from "./http-response";
import { WebError } from "./web-error";

vi.mock("../extract-pipeline", () => ({ extractToArtifact: vi.fn() }));
vi.mock("./git-exec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-exec")>();
  return { ...actual, runGit: vi.fn(), runGitClone: vi.fn() };
});

const ARTIFACT = {
  nodes: [{ id: "ts:src/a#f" }],
  edges: [],
  extensions: { changedSince: { baseRef: "origin/main", files: { "src/a.ts": [[1, 3]] } } },
} as unknown as GraphArtifact;

const BODY = { id: "artifact", prNumber: 41, baseRef: "main", headRef: "feat/x" };

describe("handlePrAnalyze", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.mocked(runGitClone).mockResolvedValue(undefined);
    // rev-parse yields the analyzed head commit (with git's trailing newline); every other call "".
    vi.mocked(runGit).mockImplementation((args) => Promise.resolve(args[0] === "rev-parse" ? "abc1234def5678900000aaaabbbbccccddddeeee\n" : ""));
    vi.mocked(extractToArtifact).mockResolvedValue({ artifact: ARTIFACT, warnings: ["w1"] } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("streams clone -> checkout -> extract -> done and retains the clone under a pr- graph id", async () => {
    const ctx = githubCtx();
    const captured = await invoke(ctx, BODY);
    expect(captured.status()).toBe(200);
    expect(captured.contentType()).toContain("application/x-ndjson");
    const lines = captured.lines();
    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "extract", "done"]);

    const done = lines[3];
    expect(done.graphId).toMatch(/^pr-[0-9a-f]{12}-[0-9a-f]{40}$/);
    expect(done.headSha).toBe("abc1234def5678900000aaaabbbbccccddddeeee");
    expect(String(done.graphId).endsWith(`-${done.headSha}`)).toBe(true);
    expect(done.counts).toEqual({ nodes: 1, edges: 0 });
    expect(done.changedFiles).toEqual([{ path: "src/a.ts", status: "modified" }]);
    expect(done.warnings).toEqual(["w1"]);

    const tmpDir = clonedDir();
    expect(ctx.graphs.get(done.graphId as string)).toBe(ARTIFACT);
    expect(ctx.sourceRoots.get(done.graphId as string)).toBe(tmpDir);
    expect(ctx.sources.get(done.graphId as string)).toMatchObject({ kind: "github", owner: "org", repo: "repo" });
    expect(ctx.tempCleanups.size).toBe(1);
    expect(existsSync(tmpDir)).toBe(true);
    for (const cleanup of ctx.tempCleanups) cleanup();
    expect(existsSync(tmpDir)).toBe(false);
  });

  it("stores force-pushed heads under different commit-pinned graph ids", async () => {
    const ctx = githubCtx();
    const first = (await invoke(ctx, BODY)).lines().at(-1)!;
    vi.mocked(runGit).mockImplementation((args) => Promise.resolve(args[0] === "rev-parse" ? "fff1234def5678900000aaaabbbbccccddddeeee\n" : ""));
    const second = (await invoke(ctx, BODY)).lines().at(-1)!;

    expect(first.headSha).not.toBe(second.headSha);
    expect(first.graphId).not.toBe(second.graphId);
    expect(ctx.graphs.has(first.graphId as string)).toBe(true);
    expect(ctx.graphs.has(second.graphId as string)).toBe(true);
    for (const cleanup of ctx.tempCleanups) cleanup();
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
    expect(vi.mocked(runGit).mock.calls).toEqual([
      [["fetch", "origin", "main"], { cwd: tmpDir, token: "", timeoutMs: 300_000 }],
      [["fetch", "origin", "pull/41/head"], { cwd: tmpDir, token: "", timeoutMs: 300_000 }],
      [["checkout", "--detach", "FETCH_HEAD"], { cwd: tmpDir, token: "", timeoutMs: 300_000 }],
      [["rev-parse", "HEAD"], { cwd: tmpDir, timeoutMs: 300_000 }],
    ]);
    expect(vi.mocked(extractToArtifact)).toHaveBeenCalledWith(
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

    const executeDiff = vi.mocked(extractToArtifact).mock.calls[0][0].changedSinceGitExecutor;
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
    vi.mocked(runGit).mockRejectedValueOnce(new WebError(422, "git failed: boom"));
    const captured = await invoke(ctx, BODY);
    const lines = captured.lines();
    expect(lines.map((line) => line.stage)).toEqual(["clone", "checkout", "error"]);
    expect(lines[2].message).toBe("git failed: boom");
    expect(existsSync(clonedDir())).toBe(false);
    expect(ctx.graphs.size).toBe(0);
    expect(ctx.tempCleanups.size).toBe(0);
  });

  it("never echoes a non-WebError's text into the error line", async () => {
    vi.mocked(extractToArtifact).mockRejectedValueOnce(new Error("/tmp/leaky/path exploded"));
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
    prFilesCache: new Map(),
    tempCleanups: new Set(),
    rendererIndex: "",
    landingHtml: "",
    staticAssets: { rendererRoot: "", indexHtml: "" },
    cwd: "",
    sessions: new SessionStore(),
    github: null,
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
