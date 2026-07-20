import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { changedFileManifestFromExtensions, SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import {
  analyzeRepository,
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis";
import type { RepositoryAnalysisRequest } from "../repository-analysis";
import { validateOrThrow } from "../validation";
import { generatorVersion } from "../version";
import { parseGitHubSource, resolveExtractionSubdir, sanitizeSubdir } from "./clone";
import { base64Auth, runGit, runGitClone } from "./git-exec";
import { prepareWebCache } from "./web-cache";
import { repositoryCacheKey } from "./web-cache-checkout";
import {
  artifactSummary,
  materializeValidatedArtifact,
  verifiedArtifactFile,
  type VerifiedFileArtifactMaterial,
  type WebGraphArtifactSummary,
} from "./web-graph-store";
import {
  createStageDirectory,
  isDirectory,
  publishImmutable,
  readJson,
  removeEntry,
  writePrivateJson,
} from "./web-cache-storage";
import { WebError } from "./web-error";
import type { PrAnalyzeRequest } from "./web-pr-request";
import type { ArtifactSource } from "./web-source";

type GitHubSource = Extract<ArtifactSource, { kind: "github" }>;
type PrStage = "clone" | "checkout" | "extract";

const FORMAT_VERSION = 7;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^[a-f0-9]{16}$/;
const CLONE_TIMEOUT_MS = 600_000;
const GIT_TIMEOUT_MS = 300_000;

interface PrSnapshotMetadata {
  formatVersion: number;
  analysisVersion: number;
  repositoryKey: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  analysisKey: string;
  artifactDigest: string;
  comparisonArtifactDigest: string;
  snapshotDigest: string;
  snapshotId: string;
  warnings: string[];
}

/**
 * The revision/analysis slot contains only this small mutable pointer. Every path handed to a
 * graph descriptor lives below the selected immutable snapshot and is therefore never rebound or
 * removed while this server process is alive.
 */
interface PrSnapshotPointer {
  formatVersion: number;
  repositoryKey: string;
  headSha: string;
  baseSha: string;
  analysisKey: string;
  snapshotDigest: string;
  snapshotId: string;
}

export interface CachedPrGraph {
  artifact: GraphArtifact;
  artifactMaterial: VerifiedFileArtifactMaterial;
  baseSha: string;
  cache: "hit" | "miss";
  comparisonMaterial: VerifiedFileArtifactMaterial;
  comparisonSourceDir: string;
  headSha: string;
  mergeBaseSha: string;
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
  const entry = join(
    inputs.cacheRoot,
    "pr-artifacts",
    prCacheSlotKey(repositoryKey, revisions, analysisKey),
  );
  const cached = inputs.refresh ? null : await readCached(entry, repositoryKey, revisions, analysisKey, inputs.source);
  if (cached) {
    return { ...cached, cache: "hit" };
  }
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
    const mergeBaseSha = await resolveMergeBase(repoDir, inputs.body.baseRef);
    const comparisonRepoDir = join(stage, "comparison-repo");
    await checkoutComparison(repoDir, comparisonRepoDir, mergeBaseSha, inputs.token);
    await inputs.onStage("extract");
    const roots = extractionRoots(repoDir, comparisonRepoDir, inputs.source.subdir);
    let head: Awaited<ReturnType<typeof extractPrHead>>;
    let comparison: Awaited<ReturnType<typeof extractPrComparison>>;
    if (roots.headMaterialized) {
      // A whole-subtree deletion has no HEAD files to detect. Analyze the populated comparison
      // first, then use all of its source paths to select every applicable empty-side extractor.
      comparison = await extractPrComparison(roots.comparison, inputs.source, remoteUrl, mergeBaseSha);
      head = await extractPrHead(
        roots.head,
        inputs.source,
        inputs.body,
        remoteUrl,
        revisions,
        mergeBaseSha,
        inputs.token,
        emptySideAnalysis(comparison.artifact),
      );
    } else {
      head = await extractPrHead(
        roots.head,
        inputs.source,
        inputs.body,
        remoteUrl,
        revisions,
        mergeBaseSha,
        inputs.token,
      );
      const comparisonRoot = resolveOrMaterializeComparisonRoot(comparisonRepoDir, inputs.source.subdir);
      // Normal two-sided analysis remains independently auto-detected. Only a materialized empty
      // comparison (a whole-subtree addition) inherits language hints from the populated HEAD.
      comparison = await extractPrComparison(
        comparisonRoot.root,
        inputs.source,
        remoteUrl,
        mergeBaseSha,
        comparisonRoot.materialized ? emptySideAnalysis(head.artifact) : undefined,
      );
    }
    const warnings = uniqueWarnings(head.warnings, comparison.warnings);
    requireExactArtifactCoordinates(head.artifact, comparison.artifact, revisions, mergeBaseSha);
    const artifactPath = join(stage, "artifact.json");
    const comparisonArtifactPath = join(stage, "comparison-artifact.json");
    const artifactMaterial = writeValidatedArtifact(artifactPath, head.artifact);
    const comparisonMaterial = writeValidatedArtifact(comparisonArtifactPath, comparison.artifact);
    const artifactDigest = artifactMaterial.byteDigest;
    const comparisonArtifactDigest = comparisonMaterial.byteDigest;
    const snapshotDigest = prSnapshotDigest({
      formatVersion: FORMAT_VERSION,
      analysisVersion: REPOSITORY_ANALYSIS_VERSION,
      repositoryKey,
      ...revisions,
      mergeBaseSha,
      analysisKey,
      artifactDigest,
      comparisonArtifactDigest,
      warnings,
    });
    // A digest alone is insufficient as a generation key: a corrupt/poisoned old checkout can
    // have the same analyzed artifacts as its clean replacement. A unique immutable generation
    // keeps both paths alive and lets the pointer move without mutating either snapshot.
    const snapshotId = randomBytes(8).toString("hex");
    writePrivateJson(join(stage, "metadata.json"), {
      formatVersion: FORMAT_VERSION,
      analysisVersion: REPOSITORY_ANALYSIS_VERSION,
      repositoryKey,
      ...revisions,
      mergeBaseSha,
      analysisKey,
      artifactDigest,
      comparisonArtifactDigest,
      snapshotDigest,
      snapshotId,
      warnings,
    } satisfies PrSnapshotMetadata);
    const destination = join(entry, "snapshots", snapshotId);
    const wonPublication = publishImmutable(stage, destination);
    const published = wonPublication
      ? publishedGeneratedSnapshot(
          destination,
          head.artifact,
          artifactMaterial.summary,
          artifactDigest,
          comparisonMaterial.summary,
          comparisonArtifactDigest,
          revisions,
          mergeBaseSha,
          warnings,
          inputs.source,
        )
      : await readSnapshot(
          destination,
          repositoryKey,
          revisions,
          analysisKey,
          snapshotId,
          snapshotDigest,
          inputs.source,
        );
    if (!published) throw new WebError(422, "cached PR analysis failed verification");
    writeCurrentPointer(entry, {
      formatVersion: FORMAT_VERSION,
      repositoryKey,
      ...revisions,
      analysisKey,
      snapshotDigest,
      snapshotId,
    });
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
  try {
    const pointer = readJson(join(entry, "metadata.json")) as Partial<PrSnapshotPointer>;
    if (!validPointer(pointer, repositoryKey, revisions, analysisKey)) return null;
    const cached = await readSnapshot(
      join(entry, "snapshots", pointer.snapshotId),
      repositoryKey,
      revisions,
      analysisKey,
      pointer.snapshotId,
      pointer.snapshotDigest,
      source,
    );
    if (!cached) return null;
    return cached;
  } catch {
    return null;
  }
}

async function readSnapshot(
  snapshot: string,
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
  snapshotId: string,
  snapshotDigest: string,
  source: GitHubSource,
): Promise<Omit<CachedPrGraph, "cache"> | null> {
  const repoDir = join(snapshot, "repo");
  if (!isDirectory(repoDir)) return null;
  try {
    const metadata = readJson(join(snapshot, "metadata.json")) as Partial<PrSnapshotMetadata>;
    if (!validSnapshotMetadata(
      metadata,
      repositoryKey,
      revisions,
      analysisKey,
      snapshotId,
      snapshotDigest,
    )) return null;
    const actualHead = requireCommit((await runGit(["rev-parse", "HEAD"], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS })).trim());
    if (actualHead !== revisions.headSha) return null;
    const artifactPath = join(snapshot, "artifact.json");
    const comparisonArtifactPath = join(snapshot, "comparison-artifact.json");
    // Validate and summarize the comparison inside its own stack frame. Its full object graph is
    // unreachable before HEAD bytes are read, bounding a hit to one materialized graph at a time.
    const comparison = readValidatedComparisonArtifact(
      comparisonArtifactPath,
      metadata.comparisonArtifactDigest,
      metadata.mergeBaseSha,
    );
    if (comparison === null) return null;
    const head = readValidatedArtifact(
      artifactPath,
      metadata.artifactDigest,
      "cached PR artifact",
    );
    if (head === null || !exactHeadArtifactCoordinates(head.artifact, revisions, metadata.mergeBaseSha)) {
      return null;
    }
    const comparisonSourceDir = resolveExtractionSubdir(join(snapshot, "comparison-repo"), source.subdir);
    return {
      artifact: head.artifact,
      artifactMaterial: head.material,
      comparisonMaterial: comparison.material,
      comparisonSourceDir,
      ...revisions,
      mergeBaseSha: metadata.mergeBaseSha,
      sourceDir: resolveExtractionSubdir(repoDir, source.subdir),
      warnings: metadata.warnings.length > 0 ? metadata.warnings : uniqueWarnings(head.warnings, comparison.warnings),
    };
  } catch {
    return null;
  }
}

function writeValidatedArtifact(
  path: string,
  artifact: GraphArtifact,
): { byteDigest: string; summary: WebGraphArtifactSummary } {
  const material = materializeValidatedArtifact(artifact);
  writeFileSync(path, material.bytes, { flag: "wx", mode: 0o600 });
  return { byteDigest: material.byteDigest, summary: material.summary };
}

function publishedGeneratedSnapshot(
  snapshot: string,
  artifact: GraphArtifact,
  artifactSummaryValue: WebGraphArtifactSummary,
  artifactDigest: string,
  comparisonSummary: WebGraphArtifactSummary,
  comparisonArtifactDigest: string,
  revisions: { headSha: string; baseSha: string },
  mergeBaseSha: string,
  warnings: string[],
  source: GitHubSource,
): Omit<CachedPrGraph, "cache"> {
  const artifactPath = join(snapshot, "artifact.json");
  const comparisonArtifactPath = join(snapshot, "comparison-artifact.json");
  const repoDir = join(snapshot, "repo");
  return {
    artifact,
    artifactMaterial: verifiedArtifactFile(artifactPath, artifactDigest, artifactSummaryValue),
    comparisonMaterial: verifiedArtifactFile(
      comparisonArtifactPath,
      comparisonArtifactDigest,
      comparisonSummary,
    ),
    comparisonSourceDir: resolveExtractionSubdir(join(snapshot, "comparison-repo"), source.subdir),
    ...revisions,
    mergeBaseSha,
    sourceDir: resolveExtractionSubdir(repoDir, source.subdir),
    warnings,
  };
}

function readValidatedArtifact(
  path: string,
  expectedDigest: string,
  label: string,
): { artifact: GraphArtifact; material: VerifiedFileArtifactMaterial; warnings: string[] } | null {
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expectedDigest) return null;
  const { artifact, warnings } = validateOrThrow(JSON.parse(bytes.toString("utf8")), label);
  return {
    artifact,
    material: verifiedArtifactFile(path, expectedDigest, artifactSummary(artifact)),
    warnings,
  };
}

function readValidatedComparisonArtifact(
  path: string,
  expectedDigest: string,
  mergeBaseSha: string,
): { material: VerifiedFileArtifactMaterial; warnings: string[] } | null {
  const validated = readValidatedArtifact(path, expectedDigest, "cached PR comparison artifact");
  if (validated === null || validated.artifact.target.vcs?.commit !== mergeBaseSha) return null;
  return { material: validated.material, warnings: validated.warnings };
}

function requireExactArtifactCoordinates(
  artifact: GraphArtifact,
  comparisonArtifact: GraphArtifact,
  revisions: { headSha: string; baseSha: string },
  mergeBaseSha: string,
): void {
  if (
    !exactHeadArtifactCoordinates(artifact, revisions, mergeBaseSha)
    || comparisonArtifact.target.vcs?.commit !== mergeBaseSha
  ) {
    throw new WebError(422, "PR analysis did not match its exact HEAD and merge-base coordinates");
  }
}

function exactHeadArtifactCoordinates(
  artifact: GraphArtifact,
  revisions: { headSha: string; baseSha: string },
  mergeBaseSha: string,
): boolean {
  const changedSince = artifact.extensions?.changedSince;
  return artifact.target.vcs?.commit === revisions.headSha
    && changedSince !== null
    && typeof changedSince === "object"
    && !Array.isArray(changedSince)
    && (changedSince as Record<string, unknown>).baseRef === mergeBaseSha
    && changedFileManifestFromExtensions(artifact.extensions) !== null;
}

function validPointer(
  value: Partial<PrSnapshotPointer>,
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
): value is PrSnapshotPointer {
  return value.formatVersion === FORMAT_VERSION && value.repositoryKey === repositoryKey
    && value.headSha === revisions.headSha && value.baseSha === revisions.baseSha
    && value.analysisKey === analysisKey
    && typeof value.snapshotDigest === "string" && SHA256.test(value.snapshotDigest)
    && typeof value.snapshotId === "string" && SNAPSHOT_ID.test(value.snapshotId);
}

function validSnapshotMetadata(
  value: Partial<PrSnapshotMetadata>,
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
  snapshotId: string,
  snapshotDigest: string,
): value is PrSnapshotMetadata {
  if (
    value.formatVersion !== FORMAT_VERSION || value.repositoryKey !== repositoryKey
    || value.analysisVersion !== REPOSITORY_ANALYSIS_VERSION
    || value.headSha !== revisions.headSha || value.baseSha !== revisions.baseSha
    || typeof value.mergeBaseSha !== "string" || !COMMIT.test(value.mergeBaseSha)
    || value.analysisKey !== analysisKey || !Array.isArray(value.warnings)
    || typeof value.artifactDigest !== "string" || !SHA256.test(value.artifactDigest)
    || typeof value.comparisonArtifactDigest !== "string" || !SHA256.test(value.comparisonArtifactDigest)
    || value.snapshotId !== snapshotId || value.snapshotDigest !== snapshotDigest
    || !SNAPSHOT_ID.test(value.snapshotId) || !SHA256.test(value.snapshotDigest)
    || !value.warnings.every((warning) => typeof warning === "string")
  ) {
    return false;
  }
  return prSnapshotDigest(value as PrSnapshotMetadata) === snapshotDigest;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function prSnapshotDigest(value: Omit<PrSnapshotMetadata, "snapshotDigest" | "snapshotId">): string {
  return createHash("sha256").update(JSON.stringify({
    formatVersion: value.formatVersion,
    analysisVersion: value.analysisVersion,
    repositoryKey: value.repositoryKey,
    headSha: value.headSha,
    baseSha: value.baseSha,
    mergeBaseSha: value.mergeBaseSha,
    analysisKey: value.analysisKey,
    artifactDigest: value.artifactDigest,
    comparisonArtifactDigest: value.comparisonArtifactDigest,
    warnings: value.warnings,
  })).digest("hex");
}

/** Atomic pointer replacement with a per-writer temporary, safe for overlapping refreshes. */
function writeCurrentPointer(entry: string, pointer: PrSnapshotPointer): void {
  mkdirSync(entry, { recursive: true, mode: 0o700 });
  const destination = join(entry, "metadata.json");
  const temporary = join(entry, `.metadata-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
  } catch (error) {
    removeEntry(temporary);
    throw error;
  }
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

async function resolveMergeBase(cwd: string, baseRef: string): Promise<string> {
  // GitHub compares base...head, and multiple best bases in a criss-cross history make argument
  // order observable. Resolve once in that exact order, then use this SHA for both source sides.
  const output = await runGit(["merge-base", `origin/${baseRef}`, "HEAD"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return requireCommit(output.trim());
}

async function checkoutComparison(cwd: string, comparisonDir: string, mergeBaseSha: string, token?: string): Promise<void> {
  await runGit(["worktree", "add", "--detach", comparisonDir, mergeBaseSha], { cwd, token, timeoutMs: GIT_TIMEOUT_MS });
}

async function extractPrHead(
  root: string,
  source: GitHubSource,
  body: PrAnalyzeRequest,
  remoteUrl: string,
  revisions: { headSha: string; baseSha: string },
  mergeBaseSha: string,
  token?: string,
  analysis?: EmptySideAnalysis,
) {
  return analyzeRepository({
    absoluteRoot: root,
    cwd: root,
    targetName: `${source.owner}/${source.repo}`,
    // Pin the exact base used by comparison source. `--merge-base <sha>` remains deterministic
    // because this SHA is already an ancestor of HEAD, even for histories with several best bases.
    changedSince: mergeBaseSha,
    changedSinceTimeoutMs: GIT_TIMEOUT_MS,
    changedSinceGitExecutor: (absoluteRoot, args, timeoutMs) => runGit(args, { cwd: absoluteRoot, token, timeoutMs }),
    vcs: { repository: remoteUrl, commit: revisions.headSha, branch: body.headRef },
    ...analysis,
  });
}

async function extractPrComparison(
  root: string,
  source: GitHubSource,
  remoteUrl: string,
  mergeBaseSha: string,
  analysis?: EmptySideAnalysis,
) {
  return analyzeRepository({
    absoluteRoot: root,
    cwd: root,
    targetName: `${source.owner}/${source.repo}`,
    vcs: { repository: remoteUrl, commit: mergeBaseSha },
    ...analysis,
  });
}

type EmptySideAnalysis = Pick<RepositoryAnalysisRequest, "hintedFiles" | "allowEmpty"> & { allowEmpty: true };

type ExtractionRoots =
  | { head: string; headMaterialized: false; comparison: null }
  | { head: string; headMaterialized: true; comparison: string };

/**
 * Resolve the configured extraction root across both immutable revisions. A subdirectory missing
 * on exactly one side is a legitimate whole-subtree addition/deletion: materialize an empty,
 * untracked directory on that side so the regular extractor and merge-base diff pipeline can stay
 * unchanged. Missing on both sides remains the same user error as before.
 *
 * Comparison validation is intentionally deferred when HEAD exists. Besides avoiding needless
 * work before HEAD extraction, this preserves the pipeline's established failure boundary: an
 * unsafe comparison checkout is still rejected before comparison extraction, after HEAD finished.
 */
function extractionRoots(headRepo: string, comparisonRepo: string, subdir?: string): ExtractionRoots {
  const headCandidate = lexicalExtractionSubdir(headRepo, subdir);
  const comparisonCandidate = lexicalExtractionSubdir(comparisonRepo, subdir);
  const headExists = entryExists(headCandidate);
  const comparisonExists = entryExists(comparisonCandidate);

  if (headExists) {
    return { head: resolveExtractionSubdir(headRepo, subdir), headMaterialized: false, comparison: null };
  }
  if (!comparisonExists) {
    // Retain the public error and, importantly, do not turn an arbitrary typo into a writable path.
    resolveExtractionSubdir(headRepo, subdir);
    throw new WebError(400, "source subfolder was not found in the repository");
  }

  // Validate the side that proves this is a deletion before creating anything in HEAD. A file or
  // escaping symlink is not evidence that the configured extraction directory existed.
  const comparison = resolveExtractionSubdir(comparisonRepo, subdir);
  return {
    head: materializeEmptyExtractionRoot(headRepo, subdir),
    headMaterialized: true,
    comparison,
  };
}

/** Resolve comparison normally, or create its empty pre-image for a whole-subtree addition. */
function resolveOrMaterializeComparisonRoot(
  comparisonRepo: string,
  subdir?: string,
): { root: string; materialized: boolean } {
  const candidate = lexicalExtractionSubdir(comparisonRepo, subdir);
  return entryExists(candidate)
    ? { root: resolveExtractionSubdir(comparisonRepo, subdir), materialized: false }
    : { root: materializeEmptyExtractionRoot(comparisonRepo, subdir), materialized: true };
}

/** File extensions from nodes plus the exact Git manifest preserve every populated-side language. */
function emptySideAnalysis(artifact: GraphArtifact): EmptySideAnalysis {
  const manifest = changedFileManifestFromExtensions(artifact.extensions) ?? [];
  return {
    allowEmpty: true,
    hintedFiles: [...new Set([
      ...artifact.nodes.map((node) => node.location.file),
      ...manifest.map((file) => file.path),
    ])].sort(),
  };
}

/**
 * Create only the absent suffix of an already-sanitized repository-relative path. Before recursive
 * mkdir can follow any existing parent symlink/junction, resolve the nearest existing ancestor
 * through the same canonical containment gate used on cache hits. The final directory is resolved
 * again after creation, closing both traversal and symlink-escape paths without weakening support
 * for a safe in-repository symlink parent.
 */
function materializeEmptyExtractionRoot(repoDir: string, subdir?: string): string {
  const canonicalRepoDir = sanitizeSubdir(repoDir);
  const candidate = lexicalExtractionSubdir(repoDir, subdir);
  if (entryExists(candidate)) {
    return resolveExtractionSubdir(repoDir, subdir);
  }
  let ancestor = dirname(candidate);
  while (!entryExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new WebError(400, "source subfolder was not found in the repository");
    }
    ancestor = parent;
  }
  // `relative` is safe here because lexicalExtractionSubdir already proved candidate is contained.
  // Use the canonical root as both paths may differ only by an OS alias (for example /var and
  // /private/var on macOS); mixing those spellings would manufacture a false lexical escape.
  // resolveExtractionSubdir additionally rejects a file, dangling link, or canonical escape.
  resolveExtractionSubdir(canonicalRepoDir, relative(canonicalRepoDir, ancestor));
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  return resolveExtractionSubdir(repoDir, subdir);
}

/** Resolve a repository-relative candidate without requiring its final suffix to exist. The clone
 * helper intentionally validates only existing directories; whole-subtree additions/deletions need
 * the lexical path first so the nearest existing ancestor can be checked before materialization. */
function lexicalExtractionSubdir(repoDir: string, subdir?: string): string {
  const root = sanitizeSubdir(repoDir);
  const clean = subdir?.trim();
  const candidate = clean ? resolve(root, clean) : root;
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WebError(400, "source subfolder escapes the repository");
  }
  return candidate;
}

/** lstat (rather than stat) distinguishes an absent suffix from a dangling/malicious link entry. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function uniqueWarnings(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

function prAnalysisKey(source: GitHubSource, body: PrAnalyzeRequest): string {
  return createHash("sha256").update(JSON.stringify({
    formatVersion: FORMAT_VERSION,
    analysisVersion: REPOSITORY_ANALYSIS_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: generatorVersion(),
    subdir: source.subdir ?? "",
    headRef: body.headRef,
    policy: REPOSITORY_ANALYSIS_POLICY,
  })).digest("hex").slice(0, 24);
}

/**
 * Keep the cache path bounded even for Git's 64-character object format. Full revision provenance
 * remains in the pointer and immutable snapshot metadata, where every cache read validates it.
 */
function prCacheSlotKey(
  repositoryKey: string,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    formatVersion: FORMAT_VERSION,
    repositoryKey,
    headSha: revisions.headSha,
    baseSha: revisions.baseSha,
    analysisKey,
  })).digest("hex").slice(0, 24);
}

function requireCommit(value: string): string {
  if (!COMMIT.test(value)) throw new WebError(422, "git returned an invalid commit id");
  return value.toLowerCase();
}
