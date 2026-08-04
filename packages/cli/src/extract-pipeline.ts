/**
 * The shared "source directory -> validated GraphArtifact" pipeline.
 *
 * `generate` and `web` both need detect-extractors -> extract -> stamp header -> validate; only
 * their I/O differs (generate writes a file, web keeps the artifact in memory). Centralizing it
 * here means one place enforces the fail-closed rule: a validation error throws before any
 * caller can persist or serve a half-formed graph.
 */

import { ExtractorRegistry, collectTestIds, compareBinaryStrings, materializeBoundaryNodes, materializeChannels, mergeExtractionResults, tagChangedNodes, tagTestNodes } from "@meridian/core";
import type {
  ChangedDiffLines,
  ChangedFileManifestEntry,
  ChangedLineKinds,
  ChangedLineStats,
  ChangedRanges,
  ExtractOptions,
  ExtractionDiagnostic,
  ExtractionProgress,
  ExtractionResult,
  FormattingOnlyProof,
  GraphArtifact,
  LanguageExtractor,
} from "@meridian/core";
import {
  MAX_INITIAL_PROJECTION_SELECTED_FILES,
  TypeScriptExtractor,
  selectInitialTypeScriptProjectionFiles,
} from "@meridian/extractor-typescript";
import type { TypeScriptRevisionShardPolicy } from "@meridian/extractor-typescript";
import {
  PythonExtractor,
  selectInitialPythonProjectionFiles,
} from "@meridian/extractor-python";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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
  /** Emit `references` edges for imported symbols used as values. */
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
  /** Internal file hints used to select extractors when the source root is deliberately empty. */
  hintedFiles?: readonly string[];
  /** Permit selected extractors to return an empty artifact for an intentionally absent PR side. */
  allowEmpty?: boolean;
  /** Internal provisional PR graph selection; canonical callers leave this undefined. */
  initialGraph?: {
    depth: number;
    seedFiles?: readonly string[];
    selectedFiles?: readonly string[];
    /** Hidden allocator stabilizers; omitted from projection/frontier metadata and canvas roots. */
    extractionFiles?: readonly string[];
    frontierFiles?: readonly string[];
    lineage?: {
      graphId: string;
      generation: string;
    };
  };
  /** Non-semantic extractor observations; graph materialization never depends on this hook. */
  onExtractionProgress?: (progress: ExtractionProgress) => void;
  /** Exact verified PR manifest observation, emitted before any language extractor starts. */
  onChangedManifest?: (manifest: readonly ChangedFileManifestEntry[]) => void;
  /** Internal server-owned execution policy; never derived from a repository or HTTP body. */
  typeScriptRevisionShards?: TypeScriptRevisionShardPolicy;
}

export interface PipelineResult {
  extractors: LanguageExtractor[];
  extraction: ExtractionResult;
  artifact: GraphArtifact;
  warnings: string[];
}

export async function extractToArtifact(request: PipelineRequest): Promise<PipelineResult> {
  const changedSince = await changedRangesFor(request);
  if (changedSince !== null && request.onChangedManifest !== undefined) {
    // Give observers detached records: even a hostile callback cannot mutate the manifest used to
    // tag and stamp the canonical artifact. Observation failures never fail extraction.
    const observed = changedSince.manifest.map((entry) => ({ ...entry }));
    try {
      request.onChangedManifest(observed);
    } catch {
      // The graph remains authoritative; early review-shell telemetry is best effort.
    }
  }
  // The canonical manifest is complete even when a diff has no HEAD-side ranges. Only paths that
  // exist at HEAD can be supplemental extraction inputs; deleted paths remain in artifact metadata
  // for review projection but must never be handed to a language extractor.
  const changedFiles = changedSince
    ? changedSince.manifest.filter((file) => file.status !== "deleted").map((file) => file.path)
    : [];
  // Language selection must also see deleted paths and populated-side hints: neither exists in an
  // intentionally empty checkout, while both still identify which registered extractors own it.
  // Supplemental extraction inputs remain HEAD-only so deleted paths are never opened as files.
  const selectionHints = [
    ...(changedSince?.manifest.map((file) => file.path) ?? []),
    ...(request.hintedFiles ?? []),
  ];
  const selectedExtractors = await selectExtractors(
    request.absoluteRoot,
    selectionHints,
    request.typeScriptRevisionShards,
  );
  const initialSelection = request.initialGraph === undefined
    ? null
    : await initialGraphSelection(request, changedSince?.manifest ?? null);
  const effectiveRequest = initialSelection === null
    ? request
    : {
        ...request,
        include: initialSelection.extractionFiles,
        // An empty bounded side is valid even when the exact checkout itself is populated: all
        // changed files may exist only in the opposite revision (all-additions/all-deletions), or
        // the PR may touch no supported source file. This authority remains internal to the
        // provisional request and does not weaken the canonical empty-extraction guard.
        // A bounded Python seed can be syntactically invalid and therefore have no semantic graph
        // node. Its exact manifest row remains reviewable while this side lands as an intentionally
        // empty partial artifact; canonical extraction keeps the ordinary nonempty requirement.
        allowEmpty: true,
        typeScriptRevisionShards: undefined,
      };
  const run = await runExtractors(
    selectedExtractors,
    effectiveRequest,
    changedFiles.length > 0 ? changedFiles : undefined,
    initialSelection !== null,
  );
  const raw = run.extraction;
  const classified = channelize(
    classifyChanges(classifyTests(raw, request.excludeTests ?? false), changedSince?.ranges ?? null),
  );
  const extraction = request.materializeBoundary
    ? { ...classified, nodes: materializeBoundaryNodes(classified.nodes, classified.edges) }
    : classified;
  const builtArtifact = buildArtifact({
    absoluteRoot: request.absoluteRoot,
    rootRelativeToCwd: rootRelativeToCwd(request.cwd, request.absoluteRoot),
    language: extraction.language,
    extraction,
    name: request.targetName,
    vcs: request.vcs,
    changedSince:
      request.changedSince && changedSince
        ? {
            baseRef: request.changedSince,
            files: changedSince.ranges,
            stats: changedSince.stats,
            kinds: changedSince.kinds,
            diffLines: changedSince.diffLines,
            manifest: changedSince.manifest,
            formattingOnly: changedSince.formattingOnly,
          }
        : undefined,
  });
  const artifact = initialSelection === null
    ? builtArtifact
    : {
        ...builtArtifact,
        extensions: {
          ...(builtArtifact.extensions ?? {}),
          prInitialGraph: {
            version: 1,
            complete: false,
            depth: request.initialGraph!.depth,
            seedFiles: initialSelection.seeds,
            selectedFiles: initialSelection.files,
            frontierFiles: initialSelection.frontier,
          },
          ...(request.initialGraph!.lineage === undefined
            ? {}
            : {
                prPartialGraph: {
                  version: 1,
                  graphId: request.initialGraph!.lineage.graphId,
                  generation: request.initialGraph!.lineage.generation,
                },
              }),
        },
      } satisfies GraphArtifact;
  const { warnings: validationWarnings } = validateOrThrow(artifact, "generated artifact");
  return {
    extractors: run.extractors,
    extraction,
    artifact,
    warnings: mergeWarnings(run.diagnosticWarnings, validationWarnings),
  };
}

async function initialGraphSelection(
  request: PipelineRequest,
  manifest: readonly ChangedFileManifestEntry[] | null,
): Promise<{ files: string[]; extractionFiles: string[]; seeds: string[]; frontier: string[] }> {
  const selection = request.initialGraph!;
  if (!Number.isSafeInteger(selection.depth) || selection.depth < 1 || selection.depth > 8) {
    throw new CliError(EXIT.validation, "initial graph depth must be an integer between 1 and 8");
  }
  const hasPreselection = selection.selectedFiles !== undefined
    || selection.extractionFiles !== undefined
    || selection.frontierFiles !== undefined
    || selection.lineage !== undefined;
  if (hasPreselection) {
    if (
      selection.seedFiles === undefined
      || selection.selectedFiles === undefined
      || selection.extractionFiles === undefined
      || selection.frontierFiles === undefined
      || selection.lineage === undefined
    ) {
      throw new CliError(EXIT.validation, "initial graph preselection is incomplete");
    }
    const seeds = validatePreselectedPaths(request.absoluteRoot, selection.seedFiles, "seed");
    const files = validatePreselectedPaths(request.absoluteRoot, selection.selectedFiles, "selected");
    const extractionFiles = validatePreselectedPaths(request.absoluteRoot, selection.extractionFiles, "extraction");
    const frontier = validatePreselectedPaths(request.absoluteRoot, selection.frontierFiles, "frontier");
    const selected = new Set(files);
    const extracted = new Set(extractionFiles);
    if (seeds.some((file) => !selected.has(file)) || frontier.some((file) => !selected.has(file))) {
      throw new CliError(EXIT.validation, "initial graph preselection is not closed over its roots and frontier");
    }
    if (files.some((file) => !extracted.has(file)) || extractionFiles.length > MAX_INITIAL_PROJECTION_SELECTED_FILES) {
      throw new CliError(EXIT.validation, "initial graph extraction files do not cover its projection");
    }
    return { files, extractionFiles, seeds, frontier };
  }
  const rawSeeds = selection.seedFiles === undefined
    ? manifest?.filter((file) => file.status !== "deleted").map((file) => file.path)
    : [...selection.seedFiles];
  if (rawSeeds === undefined) {
    throw new CliError(EXIT.validation, "initial graph changed-file roots need an exact manifest");
  }
  const seedFiles = [...new Set(rawSeeds)].sort(compareBinaryStrings);
  const typeScriptSeeds = seedFiles.filter((file) =>
    file.endsWith(".ts") || file.endsWith(".tsx"),
  );
  const pythonSeeds = seedFiles.filter((file) => file.endsWith(".py"));
  // A legitimately empty side (all additions on the merge base, or all deletions on HEAD) still
  // needs an immutable zero-node artifact so the two-sided readiness gate can complete.
  if (typeScriptSeeds.length === 0 && pythonSeeds.length === 0) {
    return { files: [], extractionFiles: [], seeds: [], frontier: [] };
  }
  const typeScriptProjection = typeScriptSeeds.length === 0
    ? null
    : selectInitialTypeScriptProjectionFiles({
        root: request.absoluteRoot,
        seeds: typeScriptSeeds,
        depth: selection.depth,
        exclude: request.exclude,
      });
  if (typeScriptSeeds.length > 0 && typeScriptProjection === null) {
    throw new CliError(EXIT.extractor, "could not prove the initial source graph neighbourhood");
  }
  const remainingSelectedFiles = MAX_INITIAL_PROJECTION_SELECTED_FILES
    - (typeScriptProjection?.files.length ?? 0);
  if (pythonSeeds.length > 0 && remainingSelectedFiles <= 0) {
    throw new CliError(EXIT.extractor, "initial source graph exceeded its aggregate selected-file limit");
  }
  const pythonProjection = pythonSeeds.length === 0
    ? null
    : await selectInitialPythonProjectionFiles({
        root: request.absoluteRoot,
        seeds: pythonSeeds,
        depth: selection.depth,
        exclude: request.exclude,
        maxSelectedFiles: remainingSelectedFiles,
      });
  if (pythonSeeds.length > 0 && pythonProjection === null) {
    throw new CliError(EXIT.extractor, "could not prove the initial source graph neighbourhood");
  }
  const projections = [typeScriptProjection, pythonProjection];
  const files = sortedUnion(projections.flatMap((projection) => projection?.files ?? []));
  const extractionFiles = sortedUnion([
    ...(typeScriptProjection?.files ?? []),
    ...(pythonProjection?.extractionFiles ?? []),
  ]);
  if (extractionFiles.length > MAX_INITIAL_PROJECTION_SELECTED_FILES) {
    throw new CliError(EXIT.extractor, "initial source graph exceeded its aggregate selected-file limit");
  }
  return {
    files,
    extractionFiles,
    seeds: sortedUnion(projections.flatMap((projection) => projection?.seeds ?? [])),
    frontier: sortedUnion(projections.flatMap((projection) => projection?.frontier ?? [])),
  };
}

function sortedUnion(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareBinaryStrings);
}

/** Re-prove every server-selected path inside the child against the exact immutable workspace. */
function validatePreselectedPaths(
  root: string,
  values: readonly string[],
  label: "seed" | "selected" | "extraction" | "frontier",
): string[] {
  const normalized = [...values];
  for (let index = 0; index < normalized.length; index += 1) {
    const path = normalized[index]!;
    if (
      path.length === 0
      || path.includes("\0")
      || path.includes("\\")
      || isAbsolute(path)
      || path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
      || (!/\.tsx?$/.test(path) && !path.endsWith(".py"))
      || /\.d\.ts$/.test(path)
      || (index > 0 && compareBinaryStrings(normalized[index - 1]!, path) >= 0)
    ) {
      throw new CliError(EXIT.validation, `initial graph ${label} files are invalid`);
    }
    let canonical: string;
    try {
      canonical = realpathSync.native(resolve(root, path));
    } catch {
      throw new CliError(EXIT.validation, `initial graph ${label} file is unavailable`);
    }
    const relativePath = relative(realpathSync.native(root), canonical).replaceAll("\\", "/");
    if (relativePath !== path || relativePath.startsWith("../") || relativePath === "..") {
      throw new CliError(EXIT.validation, `initial graph ${label} file escaped its exact workspace`);
    }
  }
  return normalized;
}

export async function selectExtractors(
  absoluteRoot: string,
  hintedFiles: readonly string[] = [],
  typeScriptRevisionShards?: TypeScriptRevisionShardPolicy,
): Promise<LanguageExtractor[]> {
  const registry = new ExtractorRegistry()
    .register(new TypeScriptExtractor(typeScriptRevisionShards))
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
): Promise<{
  ranges: ChangedRanges;
  stats: ChangedLineStats;
  kinds: ChangedLineKinds;
  diffLines: ChangedDiffLines;
  manifest: ChangedFileManifestEntry[];
  formattingOnly: FormattingOnlyProof;
} | null> {
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
  partialExactSelection: boolean,
): Promise<{ extractors: LanguageExtractor[]; extraction: ExtractionResult; diagnosticWarnings: string[] }> {
  const completed: Array<{ extractor: LanguageExtractor; result: ExtractionResult }> = [];
  const diagnosticWarnings: string[] = [];
  for (const extractor of extractors) {
    // A provisional mixed-language slice owns one aggregate path list, but each parser must see
    // only the paths it owns. Preserve an explicit empty array: it is the trusted hard zero-file
    // boundary, whereas `undefined` retains canonical all-source discovery.
    const include = partialExactSelection
      ? request.include?.filter((file) => (
          extractor.extensions.some((extension) => hasExtension(file, extension))
        ))
      : request.include;
    let result: ExtractionResult;
    try {
      result = await extractor.extract({
        root: request.absoluteRoot,
        project: request.project,
        include,
        // An explicit include is an intentional hard boundary. Otherwise changed-since/PR files must
        // remain reviewable even when a solution tsconfig forgot to reference their project.
        supplementalFiles: request.include === undefined ? changedFiles : undefined,
        exclude: request.exclude,
        depth: request.depth,
        includeExternal: request.includeExternal,
        includeUnresolved: request.includeUnresolved,
        valueRefs: request.valueRefs,
        onProgress: request.onExtractionProgress,
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new CliError(EXIT.extractor, `${extractor.displayName} extraction failed: ${reason}`);
    }
    diagnosticWarnings.push(...diagnosticWarningsOrThrow(extractor, result.diagnostics));
    completed.push({ extractor, result });
  }
  const nonempty = completed.filter(({ result }) => result.stats.files > 0);
  if (nonempty.length === 0 && !request.allowEmpty) {
    throw new CliError(EXIT.extractor, `detected extractors found no source files under ${request.absoluteRoot}`);
  }
  // Every independently extracted slice in one partial lineage must repeat the repository's
  // detected language identity. A Python-only slice in a mixed repository therefore retains the
  // zero-file TypeScript result (and vice versa), keeping `target.language` stable as `mixed` when
  // the renderer merges later slices. Canonical extraction continues to report only languages
  // that actually produced files, except for its existing explicitly-empty behavior.
  const included = partialExactSelection
    ? completed
    : (nonempty.length > 0 ? nonempty : completed);
  return {
    extractors: included.map(({ extractor }) => extractor),
    extraction: mergeExtractionResults(included.map(({ result }) => result)),
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
