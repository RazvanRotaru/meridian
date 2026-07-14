import { createHash } from "node:crypto";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import {
  analyzeRepository,
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis";
import { validateOrThrow } from "../validation";
import { generatorVersion } from "../version";
import { parseGitHubSource, sanitizeSubdir } from "./clone";
import { base64Auth, runGit, runGitClone } from "./git-exec";
import { prepareWebCache } from "./web-cache";
import { repositoryCacheKey } from "./web-cache-checkout";
import {
  createStageDirectory,
  isDirectory,
  publishImmutable,
  readJson,
  removeEntry,
  touchMetadata,
  writePrivateJson,
} from "./web-cache-storage";
import { WebError } from "./web-error";
import type { PrAnalyzeRequest } from "./web-pr-request";
import type { ArtifactSource } from "./web-source";

type GitHubSource = Extract<ArtifactSource, { kind: "github" }>;
type PrStage = "clone" | "checkout" | "extract";

const FORMAT_VERSION = 2;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const CLONE_TIMEOUT_MS = 600_000;
const GIT_TIMEOUT_MS = 300_000;

interface PrMetadata {
  formatVersion: number;
  analysisVersion: number;
  repositoryKey: string;
  headSha: string;
  baseSha: string;
  analysisKey: string;
  warnings: string[];
}

export interface CachedPrGraph {
  artifact: GraphArtifact;
  baseSha: string;
  cache: "hit" | "miss";
  headSha: string;
  sourceDir: string;
  warnings: string[];
}

export async function cachedPrGraph(inputs: {
  cacheRoot: string;
  source: GitHubSource;
  body: PrAnalyzeRequest;
  cwd: string;
  token?: string;
  refresh?: boolean;
  onStage(stage: PrStage): void | Promise<void>;
}): Promise<CachedPrGraph> {
  prepareWebCache(inputs.cacheRoot);
  const remoteUrl = parseGitHubSource(`${inputs.source.owner}/${inputs.source.repo}`);
  const revisions = await remoteRevisions(remoteUrl, inputs.body, inputs.cwd, inputs.token);
  const repositoryKey = repositoryCacheKey(remoteUrl);
  const analysisKey = prAnalysisKey(inputs.source, inputs.body);
  const entry = join(inputs.cacheRoot, "pr-artifacts", repositoryKey, revisions.headSha, revisions.baseSha, analysisKey);
  const cached = inputs.refresh ? null : await readCached(entry, repositoryKey, revisions, analysisKey, inputs.source);
  if (cached) {
    return { ...cached, cache: "hit" };
  }
  removeEntry(entry);
  return createCachedGraph(entry, repositoryKey, revisions, analysisKey, remoteUrl, inputs);
}

async function createCachedGraph(
  entry: string,
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
  remoteUrl: string,
  inputs: Parameters<typeof cachedPrGraph>[0],
): Promise<CachedPrGraph> {
  const stage = createStageDirectory(join(inputs.cacheRoot, "pr-staging"));
  const repoDir = join(stage, "repo");
  try {
    await inputs.onStage("clone");
    await cloneFullHistory(remoteUrl, repoDir, inputs.token);
    await inputs.onStage("checkout");
    await checkoutPrHead(repoDir, inputs.body, inputs.token);
    await verifyRevisions(repoDir, inputs.body.baseRef, revisions);
    await inputs.onStage("extract");
    const { artifact, warnings } = await extractPr(repoDir, inputs.source, inputs.body, remoteUrl, revisions, inputs.token);
    writePrivateJson(join(stage, "artifact.json"), artifact);
    writePrivateJson(join(stage, "metadata.json"), {
      formatVersion: FORMAT_VERSION,
      analysisVersion: REPOSITORY_ANALYSIS_VERSION,
      repositoryKey,
      ...revisions,
      analysisKey,
      warnings,
    } satisfies PrMetadata);
    publishImmutable(stage, entry);
    const published = await readCached(entry, repositoryKey, revisions, analysisKey, inputs.source);
    if (!published) throw new WebError(422, "cached PR analysis failed verification");
    return { ...published, cache: "miss" };
  } catch (error) {
    removeEntry(stage);
    throw error;
  }
}

async function readCached(
  entry: string,
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
  source: GitHubSource,
): Promise<Omit<CachedPrGraph, "cache"> | null> {
  const repoDir = join(entry, "repo");
  if (!isDirectory(repoDir)) return null;
  try {
    const metadata = readJson(join(entry, "metadata.json")) as Partial<PrMetadata>;
    if (!validMetadata(metadata, repositoryKey, revisions, analysisKey)) return null;
    const actualHead = requireCommit((await runGit(["rev-parse", "HEAD"], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS })).trim());
    if (actualHead !== revisions.headSha) return null;
    const { artifact, warnings } = validateOrThrow(readJson(join(entry, "artifact.json")), "cached PR artifact");
    touchMetadata(join(entry, "metadata.json"));
    return {
      artifact, ...revisions, sourceDir: sanitizeSubdir(repoDir, source.subdir),
      warnings: metadata.warnings.length > 0 ? metadata.warnings : warnings,
    };
  } catch {
    return null;
  }
}

function validMetadata(
  value: Partial<PrMetadata>,
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
): value is PrMetadata {
  return value.formatVersion === FORMAT_VERSION && value.repositoryKey === repositoryKey
    && value.analysisVersion === REPOSITORY_ANALYSIS_VERSION
    && value.headSha === revisions.headSha && value.baseSha === revisions.baseSha
    && value.analysisKey === analysisKey && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === "string");
}

async function remoteRevisions(url: string, body: PrAnalyzeRequest, cwd: string, token?: string) {
  const baseRef = `refs/heads/${body.baseRef}`;
  const headRef = `refs/pull/${body.prNumber}/head`;
  const output = await runGit(["ls-remote", "--exit-code", url, baseRef, headRef], { cwd, token, timeoutMs: GIT_TIMEOUT_MS });
  const rows = new Map(output.trim().split("\n").map((line) => {
    const [sha, ref] = line.trim().split(/\s+/, 2);
    return [ref, sha] as const;
  }));
  const baseSha = rows.get(baseRef);
  const headSha = rows.get(headRef);
  if (!baseSha || !headSha) throw new WebError(422, "pull request revisions were not found");
  return { baseSha: requireCommit(baseSha), headSha: requireCommit(headSha) };
}

async function cloneFullHistory(url: string, dir: string, token?: string): Promise<void> {
  const auth = token ? ["-c", `http.extraHeader=AUTHORIZATION: basic ${base64Auth(token)}`] : [];
  await runGitClone([...auth, "-c", "core.longpaths=true", "clone", "--no-tags", "--filter=blob:none", "--", url, dir], token, { timeoutMs: CLONE_TIMEOUT_MS });
}

async function checkoutPrHead(cwd: string, body: PrAnalyzeRequest, token?: string): Promise<void> {
  await runGit(["fetch", "origin", `+refs/heads/${body.baseRef}:refs/remotes/origin/${body.baseRef}`], { cwd, token, timeoutMs: GIT_TIMEOUT_MS });
  await runGit(["fetch", "origin", `pull/${body.prNumber}/head`], { cwd, token, timeoutMs: GIT_TIMEOUT_MS });
  await runGit(["checkout", "--detach", "FETCH_HEAD"], { cwd, token, timeoutMs: GIT_TIMEOUT_MS });
}

async function verifyRevisions(cwd: string, baseRef: string, expected: { headSha: string; baseSha: string }): Promise<void> {
  const headSha = requireCommit((await runGit(["rev-parse", "HEAD"], { cwd, timeoutMs: GIT_TIMEOUT_MS })).trim());
  const baseSha = requireCommit((await runGit(["rev-parse", `origin/${baseRef}`], { cwd, timeoutMs: GIT_TIMEOUT_MS })).trim());
  if (headSha !== expected.headSha || baseSha !== expected.baseSha) throw new WebError(409, "pull request changed during analysis; retry");
}

async function extractPr(cwd: string, source: GitHubSource, body: PrAnalyzeRequest, remoteUrl: string, revisions: { headSha: string; baseSha: string }, token?: string) {
  const root = sanitizeSubdir(cwd, source.subdir);
  return analyzeRepository({
    absoluteRoot: root,
    cwd: root,
    language: source.language,
    targetName: `${source.owner}/${source.repo}`,
    changedSince: `origin/${body.baseRef}`,
    changedSinceTimeoutMs: GIT_TIMEOUT_MS,
    changedSinceGitExecutor: (absoluteRoot, args, timeoutMs) => runGit(args, { cwd: absoluteRoot, token, timeoutMs }),
    vcs: { repository: remoteUrl, commit: revisions.headSha, branch: body.headRef },
  });
}

function prAnalysisKey(source: GitHubSource, body: PrAnalyzeRequest): string {
  return createHash("sha256").update(JSON.stringify({
    formatVersion: FORMAT_VERSION,
    analysisVersion: REPOSITORY_ANALYSIS_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: generatorVersion(),
    subdir: source.subdir ?? "",
    language: source.language ?? "auto",
    headRef: body.headRef,
    policy: REPOSITORY_ANALYSIS_POLICY,
  })).digest("hex").slice(0, 24);
}

function requireCommit(value: string): string {
  if (!COMMIT.test(value)) throw new WebError(422, "git returned an invalid commit id");
  return value.toLowerCase();
}
