/**
 * The shared "source directory -> validated GraphArtifact" pipeline.
 *
 * `generate` and `web` both need detect-extractors -> extract -> stamp header -> validate; only
 * their I/O differs (generate writes a file, web keeps the artifact in memory). Centralizing it
 * here means one place enforces the fail-closed rule: a validation error throws before any
 * caller can persist or serve a half-formed graph.
 */

import { ExtractorRegistry, collectTestIds, materializeBoundaryNodes, materializeChannels, mergeExtractionResults, tagChangedNodes, tagTestNodes } from "@meridian/core";
import type {
  ChangedLineKinds,
  ChangedLineStats,
  ChangedRanges,
  ExtractOptions,
  ExtractionDiagnostic,
  ExtractionResult,
  GraphArtifact,
  LanguageExtractor,
} from "@meridian/core";
import { TypeScriptExtractor } from "@meridian/extractor-typescript";
import { PythonExtractor } from "@meridian/extractor-python";
import { CliError, EXIT } from "./errors";
import { changedSinceMetadata, type GitDiffExecutor } from "./git-diff";
import { rootRelativeToCwd } from "./paths";
import { buildArtifact } from "./artifact-header";
import { mergeWarnings, validateOrThrow } from "./validation";

const MAX_REPORTED_DIAGNOSTICS = 20;

export interface PipelineRequest {
  absoluteRoot: string;
  cwd: string;
  project?: string;
  include?: string[];
  exclude?: string[];
  depth?: ExtractOptions["depth"];
  includeExternal?: boolean;
  includeUnresolved?: boolean;
  /** Turn retained `ext:` / `unresolved:` targets into renderer-visible boundary nodes. */
  materializeBoundary: boolean;
  /** Drop test code from the artifact entirely; canonical product analysis keeps and tags it. */
  excludeTests?: boolean;
  /** Emit `references` edges for imported symbols used as values; canonical product analysis leaves this off. */
  valueRefs?: boolean;
  /** Tag nodes the PR changed (git diff --merge-base <ref> vs the working tree) `"changed"`. */
  changedSince?: string;
  /** Override the changed-since diff timeout for callers that operate on unusually large repos. */
  changedSinceTimeoutMs?: number;
  /** Credential-aware git runner for server-side partial clones; local extraction uses the default. */
  changedSinceGitExecutor?: GitDiffExecutor;
  /** Display name for the artifact; the web flow passes the repo label so the title isn't a temp dir. */
  targetName?: string;
  /** Source revision supplied by a caller that resolved the Git checkout. */
  vcs?: GraphArtifact["target"]["vcs"];
}

export interface PipelineResult {
  extractors: LanguageExtractor[];
  extraction: ExtractionResult;
  artifact: GraphArtifact;
  warnings: string[];
}

export async function extractToArtifact(request: PipelineRequest): Promise<PipelineResult> {
  const changedSince = await changedRangesFor(request);
  const changedFiles = changedSince ? Object.keys(changedSince.ranges) : [];
  const selectedExtractors = await selectExtractors(request.absoluteRoot, changedFiles);
  const run = await runExtractors(selectedExtractors, request, changedFiles.length > 0 ? changedFiles : undefined);
  const raw = run.extraction;
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
    vcs: request.vcs,
    changedSince:
      request.changedSince && changedSince
        ? { baseRef: request.changedSince, files: changedSince.ranges, stats: changedSince.stats, kinds: changedSince.kinds }
        : undefined,
  });
  const { warnings: validationWarnings } = validateOrThrow(artifact, "generated artifact");
  return {
    extractors: run.extractors,
    extraction,
    artifact,
    warnings: mergeWarnings(run.diagnosticWarnings, validationWarnings),
  };
}

export async function selectExtractors(absoluteRoot: string, hintedFiles: readonly string[] = []): Promise<LanguageExtractor[]> {
  const registry = new ExtractorRegistry()
    .register(new TypeScriptExtractor())
    .register(new PythonExtractor());
  const detected = await registry.matching(absoluteRoot);
  const selectedLanguages = new Set(detected.map((extractor) => extractor.language));
  for (const extractor of registry.all()) {
    if (hintedFiles.some((file) => extractor.extensions.some((extension) => hasExtension(file, extension)))) {
      selectedLanguages.add(extractor.language);
    }
  }
  const extractors = registry.all().filter((extractor) => selectedLanguages.has(extractor.language));
  if (extractors.length === 0) {
    const available = registry.all().map((entry) => entry.language).join(", ");
    throw new CliError(EXIT.extractor, `could not detect a language under ${absoluteRoot} (available: ${available})`);
  }
  return extractors;
}

/**
 * Language-agnostic test classification: tag test-path nodes (any extractor benefits), or —
 * when explicitly requested by a lower-level caller, drop test code plus every edge touching it,
 * restoring a lean
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
 * dropped upstream are dropped with them so the manifest never dangles.
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
): Promise<{ ranges: ChangedRanges; stats: ChangedLineStats; kinds: ChangedLineKinds } | null> {
  if (!request.changedSince) {
    return null;
  }
  return changedSinceMetadata(
    request.absoluteRoot,
    request.changedSince,
    request.changedSinceTimeoutMs,
    request.changedSinceGitExecutor,
  );
}

/** Tag the nodes the diff touched: core joins the ranges onto node spans (tags compose with "test"). */
function classifyChanges(extraction: ExtractionResult, ranges: ChangedRanges | null): ExtractionResult {
  if (!ranges) {
    return extraction;
  }
  return { ...extraction, nodes: tagChangedNodes(extraction.nodes, ranges) };
}

async function runExtractors(
  extractors: readonly LanguageExtractor[],
  request: PipelineRequest,
  changedFiles: string[] | undefined,
): Promise<{ extractors: LanguageExtractor[]; extraction: ExtractionResult; diagnosticWarnings: string[] }> {
  const completed: Array<{ extractor: LanguageExtractor; result: ExtractionResult }> = [];
  const diagnosticWarnings: string[] = [];
  for (const extractor of extractors) {
    let result: ExtractionResult;
    try {
      result = await extractor.extract({
        root: request.absoluteRoot,
        project: request.project,
        include: request.include,
        // An explicit include is an intentional hard boundary. Otherwise changed-since/PR files must
        // remain reviewable even when a solution tsconfig forgot to reference their project.
        supplementalFiles: request.include ? undefined : changedFiles,
        exclude: request.exclude,
        depth: request.depth,
        includeExternal: request.includeExternal,
        includeUnresolved: request.includeUnresolved,
        valueRefs: request.valueRefs,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new CliError(EXIT.extractor, `${extractor.displayName} extraction failed: ${reason}`);
    }
    diagnosticWarnings.push(...diagnosticWarningsOrThrow(extractor, result.diagnostics));
    completed.push({ extractor, result });
  }
  const nonempty = completed.filter(({ result }) => result.stats.files > 0);
  if (nonempty.length === 0) {
    throw new CliError(EXIT.extractor, `detected extractors found no source files under ${request.absoluteRoot}`);
  }
  return {
    extractors: nonempty.map(({ extractor }) => extractor),
    extraction: mergeExtractionResults(nonempty.map(({ result }) => result)),
    diagnosticWarnings,
  };
}

function diagnosticWarningsOrThrow(
  extractor: LanguageExtractor,
  diagnostics: readonly ExtractionDiagnostic[],
): string[] {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    const details = errors
      .slice(0, MAX_REPORTED_DIAGNOSTICS)
      .map((diagnostic) => `  - ${formatDiagnostic(extractor, diagnostic)}`);
    if (errors.length > MAX_REPORTED_DIAGNOSTICS) {
      details.push(`  … and ${errors.length - MAX_REPORTED_DIAGNOSTICS} more`);
    }
    throw new CliError(
      EXIT.extractor,
      `${extractor.displayName} extraction reported ${errors.length} error diagnostic${errors.length === 1 ? "" : "s"}`,
      details,
    );
  }
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === "warn")
    .map((diagnostic) => formatDiagnostic(extractor, diagnostic));
}

function formatDiagnostic(extractor: LanguageExtractor, diagnostic: ExtractionDiagnostic): string {
  const message = oneLine(diagnostic.message);
  const nodeId = diagnostic.nodeId ? oneLine(diagnostic.nodeId) : "";
  const location = nodeId && !message.includes(nodeId) ? ` [${nodeId}]` : "";
  return `${extractor.displayName}: ${message}${location}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hasExtension(file: string, extension: string): boolean {
  return file.toLowerCase().endsWith(extension.toLowerCase());
}
