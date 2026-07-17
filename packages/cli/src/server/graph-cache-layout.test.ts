import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  finalizedGenerationDirectory,
  graphGenerationContainerForNestedPath,
  graphGenerationStagePath,
  localArtifactGenerations,
  parseFinalizedGenerationPath,
  parseGraphGenerationStagePath,
  prBaseArtifactEntry,
  prExactLookupFile,
  prHeadArtifactEntry,
  repositoryArtifactEntry,
  visitFinalizedGenerationRootsAsync,
  visitPrExactLookupFilesAsync,
} from "./graph-cache-layout";

const REPOSITORY_KEY = "1".repeat(24);
const SECURITY_DIGEST = "2".repeat(64);
const SUBDIR_KEY = "3".repeat(24);
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const ANALYSIS_KEY = "4".repeat(24);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("graph cache layout", () => {
  it("round-trips only current finalized and staging coordinates", () => {
    const root = temporaryRoot();
    const repository = finalizedGenerationDirectory(
      repositoryArtifactEntry(root, REPOSITORY_KEY, HEAD_SHA, ANALYSIS_KEY),
      "repository-one",
    );
    const head = finalizedGenerationDirectory(
      prHeadArtifactEntry(
        root,
        REPOSITORY_KEY,
        SECURITY_DIGEST,
        SUBDIR_KEY,
        HEAD_SHA,
        BASE_SHA,
        ANALYSIS_KEY,
      ),
      "head-one",
    );
    const base = finalizedGenerationDirectory(
      prBaseArtifactEntry(
        root,
        REPOSITORY_KEY,
        SECURITY_DIGEST,
        SUBDIR_KEY,
        BASE_SHA,
        ANALYSIS_KEY,
        "populated",
      ),
      "base-one",
    );
    const local = join(localArtifactGenerations(root), "local-one");
    const token = "c".repeat(48);
    const stage = graphGenerationStagePath(root, token);

    expect(parseFinalizedGenerationPath(root, repository)).toMatchObject({
      kind: "repository",
      generationId: "repository-one",
    });
    expect(parseFinalizedGenerationPath(root, head)).toMatchObject({
      kind: "pr-head",
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      generationId: "head-one",
    });
    expect(parseFinalizedGenerationPath(root, base)).toMatchObject({
      kind: "pr-base",
      mergeBaseSha: BASE_SHA,
      generationId: "base-one",
    });
    expect(parseFinalizedGenerationPath(root, local)).toEqual({
      kind: "local",
      generationId: "local-one",
    });
    expect(parseGraphGenerationStagePath(root, stage)).toMatchObject({
      kind: "stage",
      token,
    });
    expect(graphGenerationContainerForNestedPath(root, join(head, "projection", "nodes.json")))
      .toMatchObject({ kind: "finalized", directory: head });
    expect(graphGenerationContainerForNestedPath(root, join(stage, "projection", "nodes.json")))
      .toMatchObject({ kind: "stage", directory: stage });

    expect(parseFinalizedGenerationPath(
      root,
      join(root, "source-checkouts", "repo", "generations", "lookalike"),
    )).toBeNull();
    expect(graphGenerationContainerForNestedPath(
      root,
      join(root, "pr-artifacts", REPOSITORY_KEY, HEAD_SHA, "repo", "generations", "lookalike"),
    )).toBeNull();
    expect(() => graphGenerationStagePath(root, "not-a-stage-token"))
      .toThrow(/stage token is invalid/);
    expect(() => finalizedGenerationDirectory(dirname(repository), ".stage-legacy"))
      .toThrow(/generation id is invalid/);
  });

  it("enumerates exact schema leaves without entering unowned cache subtrees", async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const generation = finalizedGenerationDirectory(
      repositoryArtifactEntry(root, REPOSITORY_KEY, HEAD_SHA, ANALYSIS_KEY),
      "owned",
    );
    mkdirSync(generation, { recursive: true, mode: 0o700 });
    const exact = prExactLookupFile(
      root,
      REPOSITORY_KEY,
      SECURITY_DIGEST,
      SUBDIR_KEY,
      HEAD_SHA,
      BASE_SHA,
      ANALYSIS_KEY,
    );
    mkdirSync(dirname(exact), { recursive: true, mode: 0o700 });
    writeFileSync(exact, "{}\n");

    const unownedArtifacts = join(root, "artifacts", REPOSITORY_KEY, "checkout", "repo");
    mkdirSync(unownedArtifacts, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(unownedArtifacts, "linked-repository"), "dir");
    const unownedAliases = join(root, "pr-exact-lookups", "legacy", "repo");
    mkdirSync(unownedAliases, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(unownedAliases, "linked-repository"), "dir");

    const generationRoots: string[] = [];
    await visitFinalizedGenerationRootsAsync(root, (path) => { generationRoots.push(path); });
    expect(generationRoots).toEqual([realpathSync(dirname(generation))]);
    const aliases: string[] = [];
    await visitPrExactLookupFilesAsync(root, (coordinate) => { aliases.push(coordinate.path); });
    expect(aliases).toEqual([realpathSync(exact)]);
  });

  it("fails closed when a matching owned coordinate or exact alias leaf is a symlink", async () => {
    const generationRoot = temporaryRoot();
    const outsideDirectory = temporaryRoot();
    const artifacts = join(generationRoot, "artifacts");
    mkdirSync(artifacts, { mode: 0o700 });
    symlinkSync(outsideDirectory, join(artifacts, REPOSITORY_KEY), "dir");
    await expect(visitFinalizedGenerationRootsAsync(generationRoot, () => undefined))
      .rejects.toThrow(/owned coordinate is unsafe/);

    const aliasRoot = temporaryRoot();
    const outsideFile = join(temporaryRoot(), "outside.json");
    writeFileSync(outsideFile, "{}\n");
    const exact = prExactLookupFile(
      aliasRoot,
      REPOSITORY_KEY,
      SECURITY_DIGEST,
      SUBDIR_KEY,
      HEAD_SHA,
      BASE_SHA,
      ANALYSIS_KEY,
    );
    mkdirSync(dirname(exact), { recursive: true, mode: 0o700 });
    symlinkSync(outsideFile, exact);
    await expect(visitPrExactLookupFilesAsync(aliasRoot, () => undefined))
      .rejects.toThrow(/owned coordinate is unsafe/);
  });

  it("offers bounded, cancellable cooperative traversal for background maintenance", async () => {
    const root = temporaryRoot();
    const generation = finalizedGenerationDirectory(
      repositoryArtifactEntry(root, REPOSITORY_KEY, HEAD_SHA, ANALYSIS_KEY),
      "async-owned",
    );
    mkdirSync(generation, { recursive: true, mode: 0o700 });
    const exact = prExactLookupFile(
      root,
      REPOSITORY_KEY,
      SECURITY_DIGEST,
      SUBDIR_KEY,
      HEAD_SHA,
      BASE_SHA,
      ANALYSIS_KEY,
    );
    mkdirSync(dirname(exact), { recursive: true, mode: 0o700 });
    writeFileSync(exact, "{}\n");

    const rootsFound: string[] = [];
    await visitFinalizedGenerationRootsAsync(root, (path) => { rootsFound.push(path); });
    expect(rootsFound).toEqual([realpathSync(dirname(generation))]);
    const aliasesFound: string[] = [];
    await visitPrExactLookupFilesAsync(root, (coordinate) => {
      aliasesFound.push(coordinate.path);
    });
    expect(aliasesFound).toEqual([realpathSync(exact)]);

    await expect(visitFinalizedGenerationRootsAsync(root, () => undefined, { maxEntries: 1 }))
      .rejects.toThrow(/entry limit/);
    const controller = new AbortController();
    controller.abort(new Error("stop cache traversal"));
    await expect(visitPrExactLookupFilesAsync(root, () => undefined, {
      signal: controller.signal,
    })).rejects.toThrow(/stop cache traversal/);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-graph-cache-layout-"));
  roots.push(root);
  return root;
}
