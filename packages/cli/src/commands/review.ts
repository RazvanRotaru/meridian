/**
 * `review`: extract the working tree, diff it against a base ref, and serve the PR-review view.
 *
 * One invocation resolves the git root, computes the changed-file set (merge-base → working tree,
 * or an explicit `--changed` list), and — only if something changed — extracts in place and stamps
 * the facts under `extensions.review`. Extract-then-diff in a single pass makes artifact-vs-diff
 * staleness impossible by construction: the diff describes exactly the tree the extractor just read.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChangedFile, ChangeStatus, GraphArtifact, JsonValue, ReviewContext } from "@meridian/core";
import { REVIEW_EXTENSION } from "@meridian/core";
import { resolveAgainst, resolveCwd, toPosix } from "../paths";
import { extractToArtifact } from "../extract-pipeline";
import { writeJsonAtomic } from "../json-io";
import { Reporter } from "../reporter";
import type { GlobalOptions } from "../reporter";
import { resolveOverlaySource } from "../server/overlay-source";
import { createBlueprintServer } from "../server/server";
import { serve } from "../server/serve";
import { collectReviewDiff, posixBasename, resolveHeadRef, resolveRemoteIdentity } from "../review/git-diff";
import type { ReviewDiff } from "../review/git-diff";

export interface ReviewOptions extends GlobalOptions {
  port: number; // default 4173 (parsePort)
  host: string; // default "127.0.0.1"
  open: boolean; // --no-open
  base?: string; // mutually exclusive with `changed`
  changed?: string[]; // explicit extraction-root-relative files; skips git diff
  pr?: string; // review-identity label override
  lang?: string;
  out?: string; // also persist the stamped artifact
}

export async function runReview(path: string, options: ReviewOptions): Promise<void> {
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const absoluteRoot = resolveAgainst(cwd, path);
  const context = await resolveReviewContext(absoluteRoot, options);
  if (context.changedFiles.length === 0) {
    reporter.info(`no changes vs ${context.baseRef ?? "the given files"} — nothing to review`);
    return; // exit 0 BEFORE extraction: an empty diff has nothing to show.
  }
  const artifact = withReviewExtension(await extractReviewedTree(absoluteRoot, cwd, options.lang), context);
  if (options.out) {
    writeJsonAtomic(resolveAgainst(cwd, options.out), artifact);
  }
  reportReview(reporter, context);
  await serveReview(artifact, absoluteRoot, cwd, options, reporter);
}

/** `--changed` skips git entirely; otherwise diff merge-base(base, HEAD) → working tree. */
async function resolveReviewContext(absoluteRoot: string, options: ReviewOptions): Promise<ReviewContext> {
  if (options.changed) {
    return explicitReviewContext(absoluteRoot, options.changed, options.pr);
  }
  return gitReviewContext(await collectReviewDiff(absoluteRoot, options.base), options.pr);
}

function gitReviewContext(diff: ReviewDiff, pr: string | undefined): ReviewContext {
  return {
    changedFiles: diff.changedFiles,
    baseRef: diff.baseRef,
    baseSha: diff.baseSha,
    headRef: diff.headRef,
    reviewKey: reviewKey(diff.repoIdentity, pr, diff.headRef, diff.baseRef),
    warnings: diff.warnings,
  };
}

/** Explicit files: no diff; refs are best-effort so the command still works outside a git repo. */
async function explicitReviewContext(absoluteRoot: string, changed: string[], pr: string | undefined): Promise<ReviewContext> {
  const headRef = await resolveHeadRef(absoluteRoot);
  const repoIdentity = (await resolveRemoteIdentity(absoluteRoot)) ?? posixBasename(absoluteRoot);
  const changedFiles = changed.map((file): ChangedFile => explicitChangedFile(absoluteRoot, file));
  return { changedFiles, baseRef: null, baseSha: null, headRef, reviewKey: reviewKey(repoIdentity, pr, headRef, null), warnings: [] };
}

/** Stat each explicit path against the extraction root: a path that no longer exists is a deletion,
 * so the renderer shows the honest "deleted" reason chip instead of mislabeling it "modified". */
function explicitChangedFile(absoluteRoot: string, file: string): ChangedFile {
  const status: ChangeStatus = existsSync(resolveAgainst(absoluteRoot, file)) ? "modified" : "deleted";
  return { status, path: toPosix(file) };
}

/** Tick scope (D1d): stable across pushes/rebases (ref names, not SHAs); `--pr` is the CI escape hatch. */
function reviewKey(repoIdentity: string, pr: string | undefined, headRef: string | null, baseRef: string | null): string {
  return `${repoIdentity}|${pr ?? headRef ?? "detached"}|${baseRef ?? "explicit"}`;
}

async function extractReviewedTree(absoluteRoot: string, cwd: string, language: string | undefined): Promise<GraphArtifact> {
  const result = await extractToArtifact({ absoluteRoot, cwd, language, materializeBoundary: true, excludeTests: false });
  return result.artifact;
}

/** Shallow clone; the review facts ride the extensions bag straight through /api/graph, for free. */
function withReviewExtension(artifact: GraphArtifact, context: ReviewContext): GraphArtifact {
  return { ...artifact, extensions: { ...artifact.extensions, [REVIEW_EXTENSION]: context as unknown as JsonValue } };
}

function reportReview(reporter: Reporter, context: ReviewContext): void {
  const shortSha = context.baseSha ? context.baseSha.slice(0, 8) : "n/a";
  reporter.info(
    `review: ${context.changedFiles.length} changed files vs ${context.baseRef ?? "explicit files"} ` +
      `(merge-base ${shortSha}, branch ${context.headRef ?? "detached"})`,
  );
  for (const warning of context.warnings) {
    reporter.info(`  warning: ${warning}`);
  }
}

async function serveReview(
  artifact: GraphArtifact,
  absoluteRoot: string,
  cwd: string,
  options: ReviewOptions,
  reporter: Reporter,
): Promise<void> {
  const server = createBlueprintServer({
    artifact,
    overlay: resolveOverlaySource(undefined, cwd),
    preselectedEnv: null,
    rendererRoot: rendererRoot(),
    sourceRoot: absoluteRoot, // click-to-source reads the very tree we just extracted.
  });
  await serve(server, { host: options.host, startPort: options.port, openBrowser: options.open }, reporter);
}

/** The renderer bundle sits next to `dist/bin.js` after `copy-renderer` (mirrors `view`). */
function rendererRoot(): string {
  return fileURLToPath(new URL("../renderer-dist/", import.meta.url));
}
