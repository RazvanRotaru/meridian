/**
 * Match PR "changed file" paths to the graph's module (file) nodes.
 *
 * A PR gives repo-relative paths; a node carries `location.file` relative to the extraction root, so
 * the two rarely match verbatim. We match on `location.file` ONLY (never the node id's modulePath,
 * which is a dotted package path for Python) by: EXACT match first, else the LONGEST `/`-boundary
 * suffix of the candidate. Git paths keep backslashes opaque; extractor output is already
 * host-canonical before it reaches this join. Equal-length suffix rivals — the monorepo
 * duplicated-tail trap — are reported as ambiguous rather than guessed. Pure; no React, no store.
 */

import type { GraphIndex } from "../graph/graphIndex";

const MODULE_KIND = "module";

export interface FileMatch {
  /** The exact candidate path from the PR (apart from harmless leading `./` segments). */
  path: string;
  /** The module node it resolved to. */
  moduleId: string;
  /** That module node's exact `location.file` — the canonical "affected file". */
  file: string;
}

export interface AmbiguousMatch {
  /** The exact candidate that matched several module nodes equally well. */
  path: string;
  /** Competing module node ids, sorted — the disambiguation suggestions. */
  candidates: string[];
}

export interface MatchResult {
  matched: FileMatch[];
  /** Exact candidates that matched no module node. */
  unmatched: string[];
  ambiguous: AmbiguousMatch[];
}

/** Normalize a path for comparison: backslashes to `/`, then strip any leading `./` segments. */
export function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/** Match every candidate to a module node by `location.file` (exact, else longest `/`-suffix). */
export function matchAffectedFiles(index: GraphIndex, affectedFiles: string[]): MatchResult {
  const modules = moduleFiles(index);
  const result: MatchResult = { matched: [], unmatched: [], ambiguous: [] };
  for (const candidate of dedupe(affectedFiles.map(stripLeadingDotSegments))) {
    classify(candidate, modules, result);
  }
  return result;
}

interface ModuleFile {
  id: string;
  /** Exact `location.file`; normalization is a compatibility fallback only. */
  file: string;
}

function moduleFiles(index: GraphIndex): ModuleFile[] {
  const files: ModuleFile[] = [];
  for (const node of index.nodesById.values()) {
    if (node.kind === MODULE_KIND && node.location?.file) {
      files.push({ id: node.id, file: node.location.file });
    }
  }
  return files;
}

function classify(candidate: string, modules: ModuleFile[], result: MatchResult): void {
  const exact = modules.filter((module) => module.file === candidate);
  if (exact.length > 0) {
    record(candidate, exact, result);
    return;
  }
  const dotNormalized = modules.filter(
    (module) => stripLeadingDotSegments(module.file) === candidate,
  );
  if (dotNormalized.length > 0) {
    record(candidate, dotNormalized, result);
    return;
  }
  const suffix = longestSuffixMatches(candidate, modules);
  if (suffix.length === 0) {
    result.unmatched.push(candidate);
    return;
  }
  record(candidate, suffix, result);
}

/** Winners of the `/`-boundary suffix contest: every rival sharing the longest matching file. */
function longestSuffixMatches(candidate: string, modules: ModuleFile[]): ModuleFile[] {
  let bestLength = 0;
  let winners: ModuleFile[] = [];
  for (const module of modules) {
    const moduleFile = stripLeadingDotSegments(module.file);
    if (!candidate.endsWith(`/${moduleFile}`)) {
      continue;
    }
    if (moduleFile.length > bestLength) {
      bestLength = moduleFile.length;
      winners = [module];
    } else if (moduleFile.length === bestLength) {
      winners.push(module);
    }
  }
  return winners;
}

/** One node wins => matched; several distinct nodes => ambiguous (equal files still repeat by id). */
function record(candidate: string, winners: ModuleFile[], result: MatchResult): void {
  const ids = dedupe(winners.map((winner) => winner.id)).sort();
  if (ids.length === 1) {
    result.matched.push({ path: candidate, moduleId: ids[0], file: winners[0].file });
    return;
  }
  result.ambiguous.push({ path: candidate, candidates: ids });
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function stripLeadingDotSegments(path: string): string {
  let stripped = path;
  while (stripped.startsWith("./")) stripped = stripped.slice(2);
  return stripped;
}
