/**
 * The shared "source directory -> validated GraphArtifact" pipeline.
 *
 * `generate` and `web` both need select-extractor -> extract -> stamp header -> validate; only
 * their I/O differs (generate writes a file, web keeps the artifact in memory). Centralizing it
 * here means one place enforces the fail-closed rule: a validation error throws before any
 * caller can persist or serve a half-formed graph.
 */

import { ExtractorRegistry, collectTestIds, materializeBoundaryNodes, materializeChannels, tagChangedNodes, tagTestNodes } from "@meridian/core";
import type { ChangedLineStats, ChangedRanges, ExtractOptions, ExtractionResult, GraphArtifact, LanguageExtractor } from "@meridian/core";
import { TypeScriptExtractor } from "@meridian/extractor-typescript";
import { PythonExtractor } from "@meridian/extractor-python";
import { CliError, EXIT } from "./errors";
import { changedSinceMetadata } from "./git-diff";
import { rootRelativeToCwd } from "./paths";
import { buildArtifact } from "./artifact-header";
import { validateOrThrow } from "./validation";

export interface PipelineRequest {
  absoluteRoot: string;
  cwd: string;
  language?: string;
  project?: string;
  include?: string[];
  exclude?: string[];
  depth?: ExtractOptions["depth"];
  includeExternal?: boolean;
  includeUnresolved?: boolean;
  /** `generate` materializes boundary nodes; the web flow keeps the graph lean (default off). */
  materializeBoundary: boolean;
  /** Drop test code from the artifact entirely (`--exclude-tests`); default is include + tag. */
  excludeTests?: boolean;
  /** Tag nodes the PR changed (git diff --merge-base <ref> vs the working tree) `"changed"`. */
  changedSince?: string;
  /** Display name for the artifact; the web flow passes the repo label so the title isn't a temp dir. */
  targetName?: string;
}

export interface PipelineResult {
  extractor: LanguageExtractor;
  extraction: ExtractionResult;
  artifact: GraphArtifact;
  warnings: string[];
}

export async function extractToArtifact(request: PipelineRequest): Promise<PipelineResult> {
  const extractor = await selectExtractor(request.absoluteRoot, request.language);
  const raw = await runExtract(extractor, request);
  const changedSince = await changedRangesFor(request);
  const classified = channelize(
    classifyChanges(classifyTests(raw, request.excludeTests ?? false), changedSince?.ranges ?? null),
  );
  const extraction = request.materializeBoundary
    ? { ...classified, nodes: materializeBoundaryNodes(classified.nodes, classified.edges) }
    : classified;
  const artifact = buildArtifact({
    absoluteRoot: request.absoluteRoot,
    rootRelativeToCwd: rootRelativeToCwd(request.cwd, request.absoluteRoot),
    language: extraction.language,
    extraction,
    name: request.targetName,
    changedSince:
      request.changedSince && changedSince
        ? { baseRef: request.changedSince, files: changedSince.ranges, stats: changedSince.stats }
        : undefined,
  });
  const { warnings } = validateOrThrow(artifact, "generated artifact");
  return { extractor, extraction, artifact, warnings };
}

export async function selectExtractor(absoluteRoot: string, language: string | undefined): Promise<LanguageExtractor> {
  const registry = new ExtractorRegistry()
    .register(new TypeScriptExtractor())
    .register(new PythonExtractor());
  const extractor = await registry.select(absoluteRoot, language);
  if (!extractor) {
    const available = registry.all().map((entry) => entry.language).join(", ");
    const reason = language ? `no extractor for language '${language}'` : `could not detect a language under ${absoluteRoot}`;
    throw new CliError(EXIT.extractor, `${reason} (available: ${available})`);
  }
  return extractor;
}

/**
 * Language-agnostic test classification: tag test-path nodes (any extractor benefits), or —
 * under `--exclude-tests` — drop test code plus every edge touching it, restoring a lean
 * production-only graph.
 */
function classifyTests(extraction: ExtractionResult, excludeTests: boolean): ExtractionResult {
  const nodes = tagTestNodes(extraction.nodes);
  if (!excludeTests) {
    return { ...extraction, nodes };
  }
  const testIds = collectTestIds(nodes);
  return {
    ...extraction,
    nodes: nodes.filter((node) => !testIds.has(node.id)),
    edges: extraction.edges.filter((edge) => !testIds.has(edge.source) && !testIds.has(edge.target)),
  };
}

/**
 * Materialize the extractor's IPC ports into the graph: channel pseudo-nodes plus sends/handles
 * edges (language-agnostic — any extractor that reports ports benefits). Ports owned by nodes
 * dropped upstream (e.g. --exclude-tests) are dropped with them so the manifest never dangles.
 */
function channelize(extraction: ExtractionResult): ExtractionResult {
  const rawPorts = extraction.ports ?? [];
  if (rawPorts.length === 0) {
    return extraction;
  }
  const known = new Set(extraction.nodes.map((node) => node.id));
  const ports = rawPorts.filter((port) => known.has(port.nodeId));
  const { nodes, edges } = materializeChannels(extraction.nodes, extraction.edges, ports);
  return { ...extraction, nodes, edges, ports };
}

/**
 * The changed line ranges for `--changed-since <ref>` (a PR's diff), or null without the flag.
 * Fails closed like the rest of the pipeline — a bad ref or a non-repo root aborts the generate.
 * The ranges both tag nodes (below) and persist into `extensions.changedSince` so viewers can
 * mark the exact lines.
 */
async function changedRangesFor(
  request: PipelineRequest,
): Promise<{ ranges: ChangedRanges; stats: ChangedLineStats } | null> {
  if (!request.changedSince) {
    return null;
  }
  return changedSinceMetadata(request.absoluteRoot, request.changedSince);
}

/** Tag the nodes the diff touched: core joins the ranges onto node spans (tags compose with "test"). */
function classifyChanges(extraction: ExtractionResult, ranges: ChangedRanges | null): ExtractionResult {
  if (!ranges) {
    return extraction;
  }
  return { ...extraction, nodes: tagChangedNodes(extraction.nodes, ranges) };
}

async function runExtract(extractor: LanguageExtractor, request: PipelineRequest): Promise<ExtractionResult> {
  try {
    return await extractor.extract({
      root: request.absoluteRoot,
      project: request.project,
      include: request.include,
      exclude: request.exclude,
      depth: request.depth,
      includeExternal: request.includeExternal,
      includeUnresolved: request.includeUnresolved,
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(EXIT.extractor, `extraction failed: ${reason}`);
  }
}
