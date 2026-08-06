/** Production-path Python PR review: exact bounded pair, expansion, search hydration, and re-prepare. */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildNodeId,
  type GraphArtifact,
  type GraphProjectionRequestV1,
  type GraphProjectionV1,
  type GraphSymbolSearchResultV1,
} from "@meridian/core";
import {
  runRepositoryAnalysisChild,
  type RepositoryAnalysisChildOptions,
  type RepositoryAnalysisChildResult,
  type SerializableRepositoryAnalysisRequest,
} from "../src/server/repository-analysis-child";
import { createWebService, type WebService } from "../src/server/web-server";
import {
  RENDERER_INDEX,
  ensureBuilt,
  listenServer,
  startSmartGitServer,
  verifySmartHttpRemote,
} from "./harness";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const REPOSITORY = "e2e/python-partial";
const PR_NUMBER = 7;
const CHANGED = [
  { path: "backend/feature/consumer.py", status: "modified" },
  { path: "backend/feature/new_logic.py", status: "added" },
] as const;
const NEW_MODULE = buildNodeId({ lang: "py", modulePath: "backend.feature.new_logic" });
const NEW_FUNCTION = buildNodeId({
  lang: "py",
  modulePath: "backend.feature.new_logic",
  qualname: "new_logic",
});
const CONSUMER_MODULE = buildNodeId({ lang: "py", modulePath: "backend.feature.consumer" });
const CONSUMER_FUNCTION = buildNodeId({
  lang: "py",
  modulePath: "backend.feature.consumer",
  qualname: "consume_new",
});
const LAYER_ONE_MODULE = buildNodeId({ lang: "py", modulePath: "backend.layer_one" });
const LAYER_ONE_FUNCTION = buildNodeId({
  lang: "py",
  modulePath: "backend.layer_one",
  qualname: "first",
});
const LAYER_TWO_MODULE = buildNodeId({ lang: "py", modulePath: "backend.layer_two" });
const DISCONNECTED_FUNCTION = buildNodeId({
  lang: "py",
  modulePath: "backend.disconnected",
  qualname: "isolated",
});

interface Fixture {
  dir: string;
  bareRepo: string;
  baseSha: string;
  headSha: string;
  basePythonFileCount: number;
  headPythonFileCount: number;
}

interface AnalysisObservation {
  request: SerializableRepositoryAnalysisRequest;
  result: RepositoryAnalysisChildResult;
  selectedFiles: string[];
  artifactNodeFiles: string[];
}

describe("Python progressive PR review (real Git, HTTP, and workers)", () => {
  it("keeps semantic work bounded while preparing, expanding, hydrating, and re-preparing", async () => {
    ensureBuilt();
    let fixture: Fixture | undefined;
    const observations: AnalysisObservation[] = [];
    let smartGit: Server | undefined;
    let service: WebService | undefined;
    const restoreRedirect = installGitRedirectState();
    try {
      fixture = buildFixture();
      const smart = await startSmartGitServer(fixture);
      smartGit = smart.server;
      await verifySmartHttpRemote(smart.repoUrl);
      redirectGitHubClone(smart.repoUrl);
      service = createWebService({
        rendererRoot: dirname(RENDERER_INDEX),
        webUiPath: WEB_UI,
        cwd: REPO_ROOT,
        cacheRoot: join(fixture.dir, "cache"),
        fallbackToken: "python-partial-e2e-token",
        fallbackUser: { login: "python-partial-e2e", avatarUrl: null },
        repositoryAnalysis: async (request, options) => observeAnalysis(
          observations,
          request,
          options,
        ),
      });
      const baseUrl = await listenServer(service.server);
      const body = {
        repository: REPOSITORY,
        prNumber: PR_NUMBER,
        baseRef: "main",
        headRef: "pr-head",
        headSha: fixture.headSha,
      };

      const first = await prepare(baseUrl, body);
      expect(first.filter(isTerminal).map((line) => line.stage)).toEqual(["ready", "done"]);
      const ready = first.at(-2)!;
      const done = first.at(-1)!;
      expect(ready.stage).toBe("ready");
      expect(done.stage).toBe("done");
      expect(withoutStage(done)).toEqual(withoutStage(ready));
      expect(done).toMatchObject({
        headSha: fixture.headSha,
        baseSha: fixture.baseSha,
        mergeBaseSha: fixture.baseSha,
        completeness: "provisional",
        changedFiles: CHANGED,
      });
      expect(done.pairId).toMatch(/^[a-f0-9]{20}$/);
      expect(done.graphId).toBe(`pr-partial-${done.pairId}-${fixture.headSha}`);
      expect(done.comparisonGraphId).toBe(`pr-partial-base-${done.pairId}-${fixture.baseSha}`);
      expect(observations).toHaveLength(2);
      expect(analysisCoordinates(observations)).toEqual([
        { commit: fixture.headSha, depth: 1 },
        { commit: fixture.baseSha, depth: 1 },
      ]);
      expect(observations[0]!.selectedFiles.length).toBeLessThan(fixture.headPythonFileCount);
      expect(observations[1]!.selectedFiles.length).toBeLessThan(fixture.basePythonFileCount);
      expect(observations[0]!.selectedFiles).not.toContain("backend/disconnected.py");
      expect(observations[1]!.selectedFiles).not.toContain("backend/disconnected.py");
      expect(observations[0]!.artifactNodeFiles).not.toContain("backend/disconnected.py");
      expect(observations[1]!.artifactNodeFiles).not.toContain("backend/disconnected.py");

      await expectRawGraphUnavailable(baseUrl, done.graphId as string);
      await expectRawGraphUnavailable(baseUrl, done.comparisonGraphId as string);
      const initialCache = done.initialProjectionCache as Record<string, unknown>;
      expect(initialCache).toMatchObject({ version: 1, depth: 1, prefetchDepth: 3, ready: true });
      const head = await project(
        baseUrl,
        changedFilesRequest(done.graphId as string, done.graphId as string, 1, 3),
        "hit",
      );
      const comparison = await project(
        baseUrl,
        changedFilesRequest(done.comparisonGraphId as string, done.graphId as string, 1, 3),
        "hit",
      );
      expectProjection(head, done.graphId as string, fixture.headSha, 1);
      expectProjection(comparison, done.comparisonGraphId as string, fixture.baseSha, 1);
      expect(head.loadedFileIds.length).toBeLessThan(fixture.headPythonFileCount);
      expect(comparison.loadedFileIds.length).toBeLessThan(fixture.basePythonFileCount);
      expect(head.rootFileIds).toEqual(expect.arrayContaining([CONSUMER_MODULE, NEW_MODULE]));
      expect(comparison.rootFileIds).toContain(CONSUMER_MODULE);
      expect(comparison.rootFileIds).not.toContain(NEW_MODULE);
      expect(head.rootFileIds.every((fileId) => head.readyFileIds.includes(fileId))).toBe(true);
      expect(comparison.rootFileIds.every((fileId) => comparison.readyFileIds.includes(fileId))).toBe(true);
      expect(head.nodes.some((node) => node.id === NEW_FUNCTION)).toBe(true);
      expect(comparison.nodes.some((node) => node.id === NEW_MODULE)).toBe(false);
      expect(head.nodes.some((node) => node.id === LAYER_TWO_MODULE)).toBe(false);
      expect(head.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "imports", source: CONSUMER_MODULE, target: NEW_MODULE }),
        expect.objectContaining({ kind: "imports", source: NEW_MODULE, target: LAYER_ONE_MODULE }),
        expect.objectContaining({ kind: "calls", source: CONSUMER_FUNCTION, target: NEW_FUNCTION }),
        expect.objectContaining({ kind: "calls", source: NEW_FUNCTION, target: LAYER_ONE_FUNCTION }),
      ]));

      const symbols = await fetchSymbols(baseUrl, done.graphId as string);
      const disconnected = symbols.symbols.find((symbol) => symbol.id === DISCONNECTED_FUNCTION);
      expect(symbols).toMatchObject({
        graphId: done.graphId,
        generation: head.generation,
        complete: true,
      });
      expect(disconnected).toMatchObject({ file: "backend/disconnected.py" });
      expect(head.loadedFileIds).not.toContain(disconnected!.fileId);
      const hydrated = await project(baseUrl, {
        version: 1,
        graphId: done.graphId as string,
        roots: { kind: "files", fileIds: [disconnected!.fileId] },
        requestedDepth: 1,
        prefetchDepth: 1,
      }, "miss");
      expect(hydrated.readyFileIds).toContain(disconnected!.fileId);
      expect(hydrated.nodes.some((node) => node.id === DISCONNECTED_FUNCTION)).toBe(true);
      expect(hydrated.loadedFileIds.length).toBeLessThan(fixture.headPythonFileCount);

      const expanded = await project(
        baseUrl,
        changedFilesRequest(done.graphId as string, done.graphId as string, 2, 2),
        "miss",
      );
      expectProjection(expanded, done.graphId as string, fixture.headSha, 2);
      expect(expanded.loadedFileIds.length).toBeGreaterThan(head.loadedFileIds.length);
      expect(expanded.loadedFileIds.length).toBeLessThan(fixture.headPythonFileCount);
      expect(expanded.nodes.some((node) => node.id === LAYER_TWO_MODULE)).toBe(true);
      expect(expanded.loadedFileIds).not.toContain(disconnected!.fileId);
      expect(observations).toHaveLength(4);
      expect(analysisCoordinates(observations)).toEqual([
        { commit: fixture.headSha, depth: 1 },
        { commit: fixture.baseSha, depth: 1 },
        { commit: fixture.headSha, depth: 1 },
        { commit: fixture.headSha, depth: 2 },
      ]);
      for (const observation of observations.slice(2)) {
        const extractionFiles = observation.request.initialGraph?.extractionFiles;
        expect(extractionFiles).toBeDefined();
        expect(extractionFiles!.length).toBeLessThan(fixture.headPythonFileCount);
      }

      const callsBeforeReprepare = observations.length;
      const second = await prepare(baseUrl, body);
      expect(second.map((line) => line.stage)).toEqual(["ready", "done"]);
      expect(second.at(-1)).toMatchObject({
        graphId: done.graphId,
        comparisonGraphId: done.comparisonGraphId,
        headSha: fixture.headSha,
        mergeBaseSha: fixture.baseSha,
      });
      expect(observations).toHaveLength(callsBeforeReprepare);

      const viewUrl = done.viewUrl as string;
      expect(viewUrl).toContain("progressive=1");
      expect(viewUrl).toContain("partial=1");
      const response = await fetch(`${baseUrl}${viewUrl}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(done.graphId as string);
      expect(observations).toHaveLength(callsBeforeReprepare);
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await service?.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await closeServer(smartGit);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        restoreRedirect();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (fixture !== undefined) rmSync(fixture.dir, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Python PR E2E cleanup failed");
    }
  }, 60_000);
});

async function observeAnalysis(
  observations: AnalysisObservation[],
  request: SerializableRepositoryAnalysisRequest,
  options: RepositoryAnalysisChildOptions,
): Promise<RepositoryAnalysisChildResult> {
  const result = await runRepositoryAnalysisChild(request, options);
  const artifact = readAnalysisArtifact(result.material.path);
  observations.push({
    request: structuredClone(request),
    result,
    selectedFiles: initialSelectedFiles(artifact),
    artifactNodeFiles: [...new Set(artifact.nodes.map((node) => node.location.file))],
  });
  return result;
}

function readAnalysisArtifact(path: string): GraphArtifact {
  return JSON.parse(readFileSync(path, "utf8")) as GraphArtifact;
}

function initialSelectedFiles(artifact: GraphArtifact): string[] {
  const marker = artifact.extensions?.prInitialGraph as { selectedFiles?: unknown } | undefined;
  if (!Array.isArray(marker?.selectedFiles)
    || !marker.selectedFiles.every((value): value is string => typeof value === "string")) {
    throw new TypeError("repository analysis omitted its bounded initial-file selection");
  }
  return [...marker.selectedFiles];
}

function analysisCoordinates(
  observations: readonly AnalysisObservation[],
): Array<{ commit: string | undefined; depth: number | undefined }> {
  return observations.map(({ request }) => ({
    commit: request.vcs?.commit,
    depth: request.initialGraph?.depth,
  }));
}

async function prepare(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${baseUrl}/api/pr/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(text.endsWith("\n")).toBe(true);
  return text.slice(0, -1).split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function isTerminal(line: Record<string, unknown>): boolean {
  return line.stage === "ready" || line.stage === "done";
}

function withoutStage(line: Record<string, unknown>): Record<string, unknown> {
  const { stage: _stage, ...rest } = line;
  return rest;
}

function changedFilesRequest(
  graphId: string,
  seedGraphId: string,
  requestedDepth: number,
  prefetchDepth: number,
): GraphProjectionRequestV1 {
  return {
    version: 1,
    graphId,
    roots: { kind: "changed-files", seedGraphId },
    requestedDepth,
    prefetchDepth,
  };
}

async function project(
  baseUrl: string,
  request: GraphProjectionRequestV1,
  expectedCache: "hit" | "miss",
): Promise<GraphProjectionV1> {
  const response = await fetch(`${baseUrl}/api/graph/project`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(response.headers.get("x-meridian-graph-projection-cache")).toBe(expectedCache);
  return JSON.parse(text) as GraphProjectionV1;
}

function expectProjection(
  projection: GraphProjectionV1,
  graphId: string,
  commit: string,
  depth: number,
): void {
  expect(projection).toMatchObject({
    version: 1,
    graphId,
    requestedDepth: depth,
    loadedDepth: depth,
    target: { vcs: { commit } },
  });
  expect(projection.counts.slice).toEqual({
    nodes: projection.nodes.length,
    edges: projection.edges.length,
    files: projection.loadedFileIds.length,
  });
}

async function fetchSymbols(baseUrl: string, graphId: string): Promise<GraphSymbolSearchResultV1> {
  const response = await fetch(`${baseUrl}/api/graph/symbols?id=${encodeURIComponent(graphId)}`);
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as GraphSymbolSearchResultV1;
}

async function expectRawGraphUnavailable(baseUrl: string, graphId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/graph?id=${encodeURIComponent(graphId)}`);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "raw graph payload is unavailable for a projection-only graph",
  });
}

function buildFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "meridian-python-partial-e2e-"));
  try {
    const bareRepo = join(dir, "repo.git");
    const worktree = join(dir, "worktree");
    git(["init", "--bare", bareRepo]);
    git(["clone", bareRepo, worktree]);
    git(["config", "user.name", "Meridian Python E2E"], worktree);
    git(["config", "user.email", "python-e2e@meridian.test"], worktree);
    git(["config", "commit.gpgsign", "false"], worktree);
    writeFixtureBase(worktree);
    git(["switch", "-c", "main"], worktree);
    commitAll(worktree, "seed Python service");
    git(["push", "-u", "origin", "main"], worktree);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], bareRepo);
    const baseSha = git(["rev-parse", "HEAD"], worktree);
    const basePythonFileCount = pythonFileCount(worktree, baseSha);

    git(["switch", "-c", "pr-head"], worktree);
    writeFileSync(join(worktree, "backend/feature/new_logic.py"), [
      "from backend.layer_one import first",
      "",
      "def new_logic() -> str:",
      "    return first()",
      "",
    ].join("\n"));
    appendFileSync(join(worktree, "backend/feature/consumer.py"), [
      "",
      "from backend.feature.new_logic import new_logic",
      "",
      "def consume_new() -> str:",
      "    return new_logic()",
    ].join("\n"));
    commitAll(worktree, "add Python review change");
    git(["push", "origin", "pr-head", `pr-head:refs/pull/${PR_NUMBER}/head`], worktree);
    const headSha = git(["rev-parse", "HEAD"], worktree);
    return {
      dir,
      bareRepo,
      baseSha,
      headSha,
      basePythonFileCount,
      headPythonFileCount: pythonFileCount(worktree, headSha),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function pythonFileCount(worktree: string, commit: string): number {
  return git(["ls-tree", "-r", "--name-only", commit], worktree)
    .split("\n").filter((path) => path.endsWith(".py")).length;
}

function writeFixtureBase(root: string): void {
  const files: Record<string, string> = {
    "backend/__init__.py": "",
    "backend/core/__init__.py": "def normalize(value: str) -> str:\n    return value.strip()\n",
    "backend/feature/__init__.py": "",
    "backend/feature/consumer.py": [
      "from backend.core import normalize",
      "",
      "def consume(value: str) -> str:",
      "    return normalize(value)",
      "",
    ].join("\n"),
    "backend/layer_one.py": "from backend.layer_two import second\n\ndef first() -> str:\n    return second()\n",
    "backend/layer_two.py": "from backend.layer_three import third\n\ndef second() -> str:\n    return third()\n",
    "backend/layer_three.py": "def third() -> str:\n    return 'done'\n",
    "backend/disconnected.py": "def isolated() -> str:\n    return 'isolated'\n",
  };
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
}

function commitAll(worktree: string, message: string): void {
  git(["add", "."], worktree);
  git(["commit", "-m", message], worktree);
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function installGitRedirectState(): () => void {
  const previous = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  };
  return () => {
    restoreEnv("GIT_CONFIG_COUNT", previous.count);
    restoreEnv("GIT_CONFIG_KEY_0", previous.key);
    restoreEnv("GIT_CONFIG_VALUE_0", previous.value);
  };
}

function redirectGitHubClone(repoUrl: string): void {
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${repoUrl}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = `https://github.com/${REPOSITORY}.git`;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
