/**
 * Shared plumbing for the end-to-end suite: locating the built CLI, generating a graph from
 * the fixture, and starting the real `meridian web` server against that artifact.
 */

import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { chromium } from "playwright";
import { parsePatchDetail, parsePatchHunks } from "../src/server/github-parse";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, "..", "dist", "bin.js");
export const RENDERER_INDEX = join(HERE, "..", "renderer-dist", "index.html");
export const FIXTURE = join(HERE, "..", "..", "..", "examples", "orders-service");
// Deliberately deeper than the historical detector horizon: the PR introduces Python into an
// otherwise TypeScript-only base, proving changed-file hints and complete discovery activate it.
export const PYTHON_REVIEW_PATH = "src/backend/features/risk/engines/rules/deep/risk.py";

export interface PrReviewFixtureFile {
  api: { filename: string; status: "added" | "modified"; additions: number; deletions: number; patch: string };
  detail: ReturnType<typeof parsePatchDetail>;
  headerHunks: ReturnType<typeof parsePatchHunks>;
  headCode: string;
}

export interface PrReviewFixture {
  dir: string;
  bareRepo: string;
  worktree: string;
  headSha: string;
  files: PrReviewFixtureFile[];
}

export function chromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

export function ensureBuilt(): void {
  if (!existsSync(CLI)) {
    throw new Error(`CLI not built at ${CLI} — run \`pnpm e2e\` (it builds first).`);
  }
  if (!existsSync(RENDERER_INDEX)) {
    throw new Error("renderer bundle missing — run `pnpm --filter @meridian/cli copy-renderer`.");
  }
}

export function generateGraph(): { graphPath: string; dir: string } {
  return generateGraphFrom(FIXTURE);
}

/** Generate a graph artifact from ANY example fixture (the parity drive uses shopfront — it has a
 * render tree, so all three lenses have substance). */
export function generateGraphFrom(fixtureDir: string): { graphPath: string; dir: string } {
  ensureBuilt();
  const dir = mkdtempSync(join(tmpdir(), "blueprint-e2e-"));
  const graphPath = join(dir, "fixture.graph.json");
  execFileSync(process.execPath, [CLI, "generate", fixtureDir, "-o", graphPath], { stdio: "ignore" });
  return { graphPath, dir };
}

export function runCli(args: string[]): { code: number; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

export function startView(graphPath: string, port = 4399): Promise<{ server: ChildProcess; url: string }> {
  return startViewProcess(graphPath, ["--overlay", "mock", "--env", "staging"], port);
}

/** Launch the ordinary existing-graph path with no startup telemetry source selected. The server still
 * advertises its explicit built-in demo catalog; browser coverage owns choosing and loading it. */
export function startViewWithoutOverlay(graphPath: string, port = 4399): Promise<{ server: ChildProcess; url: string }> {
  return startViewProcess(graphPath, [], port);
}

function startViewProcess(graphPath: string, telemetryArgs: string[], port: number): Promise<{ server: ChildProcess; url: string }> {
  const server = spawn(
    process.execPath,
    [CLI, "web", graphPath, ...telemetryArgs, "--no-open", "--port", String(port)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        resolve({ server, url: match[0] });
      }
    };
    server.stdout?.on("data", onData);
    server.stderr?.on("data", onData);
    setTimeout(() => reject(new Error(`web did not announce a URL in time:\n${buffer}`)), 30_000);
  });
}

export function buildPrReviewFixture(): PrReviewFixture {
  const dir = mkdtempSync(join(tmpdir(), "meridian-pr-review-"));
  try {
    return populatePrReviewFixture(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function populatePrReviewFixture(dir: string): PrReviewFixture {
  const bareRepo = join(dir, "repo.git");
  const worktree = join(dir, "worktree");
  fixtureGit(["init", "--bare", bareRepo]);
  fixtureGit(["clone", bareRepo, worktree]);
  fixtureGit(["config", "user.name", "Meridian E2E"], worktree);
  fixtureGit(["config", "user.email", "e2e@meridian.test"], worktree);
  copyOrdersFixture(worktree);
  fixtureGit(["switch", "-c", "main"], worktree);
  fixtureGit(["add", "."], worktree);
  fixtureGit(["commit", "-m", "seed orders service"], worktree);
  fixtureGit(["push", "-u", "origin", "main"], worktree);
  fixtureGit(["symbolic-ref", "HEAD", "refs/heads/main"], bareRepo);

  fixtureGit(["switch", "-c", "pr-head"], worktree);
  writeFileSync(join(worktree, "src/pricing/loyaltyTiers.ts"), LOYALTY_TIERS_SOURCE);
  appendFileSync(join(worktree, "src/services/orderService.ts"), ORDER_SERVICE_CHANGE);
  mkdirSync(dirname(join(worktree, PYTHON_REVIEW_PATH)), { recursive: true });
  writeFileSync(join(worktree, PYTHON_REVIEW_PATH), PYTHON_RISK_HEAD_SOURCE);
  fixtureGit(["add", "."], worktree);
  fixtureGit(["commit", "-m", "add PR review fixture changes"], worktree);
  fixtureGit(["push", "origin", "pr-head", "pr-head:refs/pull/7/head"], worktree);

  const changedFiles = [
    { path: "src/pricing/loyaltyTiers.ts", status: "added" },
    { path: "src/services/orderService.ts", status: "modified" },
    { path: PYTHON_REVIEW_PATH, status: "added" },
  ] as const;
  return {
    dir,
    bareRepo,
    worktree,
    headSha: fixtureGit(["rev-parse", "pr-head"], worktree).trim(),
    files: changedFiles.map(({ path, status }) => fixtureFile(worktree, path, status)),
  };
}

export async function startSmartGitServer(fixture: { bareRepo: string }): Promise<{ server: Server; repoUrl: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (
      request.method === "GET" &&
      url.pathname === "/repo.git/info/refs" &&
      url.searchParams.get("service") === "git-upload-pack"
    ) {
      const uploadPack = spawn("git", ["upload-pack", "--stateless-rpc", "--advertise-refs", fixture.bareRepo]);
      response.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
      response.write("001e# service=git-upload-pack\n0000");
      uploadPack.stdout.pipe(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/repo.git/git-upload-pack") {
      const uploadPack = spawn("git", ["upload-pack", "--stateless-rpc", fixture.bareRepo]);
      const body = request.headers["content-encoding"] === "gzip" ? request.pipe(createGunzip()) : request;
      response.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
      body.pipe(uploadPack.stdin);
      uploadPack.stdout.pipe(response);
      return;
    }

    response.writeHead(404).end();
  });
  const baseUrl = await listenServer(server);
  return { server, repoUrl: `${baseUrl}/repo.git` };
}

export function listenServer(server: Server): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const port = (server.address() as AddressInfo).port;
      resolveUrl(`http://127.0.0.1:${port}`);
    });
  });
}

export async function verifySmartHttpMirrorTransport(repoUrl: string): Promise<void> {
  const mirror = mkdtempSync(join(tmpdir(), "meridian-smart-mirror-"));
  try {
    // Exercise the same partial bare-mirror transport shape used by RepositoryMirrorStore. This
    // catches fixture smart-HTTP failures without preserving the removed one-clone-per-request path.
    fixtureGit(["init", "--bare", "--quiet", "."], mirror);
    fixtureGit(["config", "remote.origin.url", repoUrl], mirror);
    fixtureGit(["config", "remote.origin.promisor", "true"], mirror);
    fixtureGit(["config", "remote.origin.partialclonefilter", "blob:none"], mirror);
    await fixtureGitAsync([
      "fetch",
      "--force",
      "--no-tags",
      "--filter=blob:none",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "origin",
      "+refs/heads/main:refs/meridian/smoke/head",
    ], mirror);
    fixtureGit(["rev-parse", "refs/meridian/smoke/head^{commit}"], mirror);
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

function fixtureFile(worktree: string, path: string, status: "added" | "modified"): PrReviewFixtureFile {
  const diff = fixtureGit(["diff", "--unified=3", "main..pr-head", "--", path], worktree);
  const patchStart = diff.indexOf("@@");
  if (patchStart === -1) {
    throw new Error(`fixture diff for ${path} has no patch hunk`);
  }
  const patch = diff.slice(patchStart).trimEnd();
  const detail = parsePatchDetail(patch);
  const headerHunks = parsePatchHunks(patch);
  if (headerHunks.length === 0 || detail.hunks.length === 0 || detail.edits.length === 0 || detail.kinds.length === 0) {
    throw new Error(`real patch parsers found no review detail for ${path}`);
  }
  const [additions, deletions] = fixtureGit(["diff", "--numstat", "main..pr-head", "--", path], worktree)
    .trim()
    .split("\t")
    .map(Number);
  return {
    api: { filename: path, status, additions, deletions, patch },
    detail,
    headerHunks,
    headCode: fixtureGit(["show", `pr-head:${path}`], worktree),
  };
}

function copyOrdersFixture(worktree: string): void {
  for (const entry of readdirSync(FIXTURE)) {
    cpSync(join(FIXTURE, entry), join(worktree, entry), { recursive: true });
  }
}

function fixtureGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fixtureGitAsync(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolveGit, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: 90_000 }, (error, stdout) => {
      error ? reject(error) : resolveGit(stdout);
    });
  });
}

const LOYALTY_TIERS_SOURCE = `export function loyaltyTierFor(orderCount: number): string {
  // Keep the loyalty threshold explicit before choosing the customer's tier.
  return orderCount >= 10 ? "gold" : "standard";
}
`;

const ORDER_SERVICE_CHANGE = `

export function reviewFixtureMarker(): string {
  return "pr-head";
}
`;

const PYTHON_RISK_HEAD_SOURCE = `def risk_label(order_count: int) -> str:
    return "priority" if order_count >= 10 else "standard"
`;
