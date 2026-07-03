/**
 * `change`: mint a change-lens overlay (`change/1.0`) from a git revision range.
 *
 * Reads three cheap `git diff` projections of the range, then joins them onto the artifact's
 * node source spans: a module is changed when its file is, a function/method/class when any
 * new-side hunk intersects its [startLine, endLine]. Containers are left to the renderer to
 * roll up. Nothing is written on error (fail closed, like `generate`).
 */

import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ChangeOverlay, ChangeStatus, GraphArtifact, GraphNode, NodeChange } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { resolveAgainst, resolveCwd } from "../paths";
import { readJsonFile, writeJsonAtomic } from "../json-io";
import { validateOrThrow } from "../validation";
import { Reporter, type GlobalOptions } from "../reporter";
import { parseHunkRanges, parseNameStatus, parseNumstat, runGit, type HunkRange } from "../git-diff";
import { nowIso } from "../clock";

export interface ChangeOptions extends GlobalOptions {
  repo: string;
  range: string;
  prefix?: string;
  out?: string;
}

export async function runChange(graph: string, options: ChangeOptions): Promise<void> {
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const artifact = validateOrThrow(readJsonFile(resolveAgainst(cwd, graph)), `graph ${graph}`).artifact;
  const repoRoot = requireDirectory(resolveAgainst(cwd, options.repo));
  const range = requireRange(options.range);
  const prefix = normalizePrefix(options.prefix ?? "");

  const pathspec = prefix === "" ? [] : ["--", prefix];
  const [numstatOut, nameStatusOut, hunksOut] = await Promise.all([
    runGit(repoRoot, ["diff", "--numstat", range, ...pathspec]),
    runGit(repoRoot, ["diff", "--name-status", range, ...pathspec]),
    runGit(repoRoot, ["diff", "-U0", range, ...pathspec]),
  ]);

  const overlay = buildChangeOverlay({
    artifact,
    repoRoot,
    range,
    prefix,
    numstat: parseNumstat(numstatOut),
    statuses: parseNameStatus(nameStatusOut),
    hunks: parseHunkRanges(hunksOut),
  });

  const outPath = resolveAgainst(cwd, options.out ?? "meridian.change.json");
  writeJsonAtomic(outPath, overlay);
  const changedNodes = Object.keys(overlay.nodes).length;
  const changedFiles = Object.keys(overlay.files).length;
  reporter.info(`range       ${range}`);
  reporter.info(`files       ${changedFiles} changed within ${prefix === "" ? "repo root" : prefix}`);
  reporter.info(`nodes       ${changedNodes} matched onto the graph`);
  reporter.info(`wrote       ${outPath}`);
  reporter.payload({ range, changedFiles, changedNodes, out: outPath });
}

interface BuildInputs {
  artifact: GraphArtifact;
  repoRoot: string;
  range: string;
  prefix: string;
  numstat: ReturnType<typeof parseNumstat>;
  statuses: Map<string, "A" | "M" | "D">;
  hunks: Map<string, HunkRange[]>;
}

export function buildChangeOverlay(inputs: BuildInputs): ChangeOverlay {
  const files: ChangeOverlay["files"] = {};
  for (const stat of inputs.numstat) {
    const targetPath = stripPrefix(stat.path, inputs.prefix);
    if (targetPath === null) {
      continue;
    }
    files[targetPath] = {
      status: statusOf(inputs.statuses.get(stat.path)),
      additions: stat.additions,
      deletions: stat.deletions,
    };
  }

  const nodes: ChangeOverlay["nodes"] = {};
  const nodesByFile = groupNodesByFile(inputs.artifact.nodes);
  for (const [targetPath, fileChange] of Object.entries(files)) {
    const candidates = nodesByFile.get(targetPath) ?? [];
    const ranges = inputs.hunks.get(joinPrefix(inputs.prefix, targetPath)) ?? [];
    for (const node of candidates) {
      const change = nodeChange(node, fileChange.status, fileChange, ranges);
      if (change) {
        nodes[node.id] = change;
      }
    }
  }

  return {
    schemaVersion: "change/1.0",
    range: inputs.range,
    repoRoot: inputs.repoRoot,
    prefix: inputs.prefix,
    generatedAt: nowIso(),
    nodes,
    files,
  };
}

/**
 * A module node takes the whole-file totals. A spanned declaration (function/method/class...)
 * is changed only when a new-side hunk intersects its span; its ± are the sum of intersecting
 * hunk sizes on the new side (an honest per-symbol approximation of "lines touched here").
 */
function nodeChange(
  node: GraphNode,
  fileStatus: ChangeStatus,
  fileChange: { additions: number; deletions: number },
  ranges: HunkRange[],
): NodeChange | null {
  const location = node.location;
  if (!location) {
    return null;
  }
  const isWholeFileNode = node.kind === "module";
  if (isWholeFileNode) {
    return { status: fileStatus, additions: fileChange.additions, deletions: fileChange.deletions };
  }
  const start = location.startLine;
  const end = location.endLine ?? location.startLine;
  const touched = ranges.filter((range) => range.start <= end && range.end >= start);
  if (touched.length === 0) {
    return null;
  }
  const additions = touched.reduce((sum, range) => sum + (range.end - range.start + 1), 0);
  return { status: fileStatus === "added" ? "added" : "modified", additions, deletions: 0 };
}

function groupNodesByFile(nodes: GraphNode[]): Map<string, GraphNode[]> {
  const byFile = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const file = node.location?.file;
    if (!file) {
      continue;
    }
    const bucket = byFile.get(file);
    if (bucket) {
      bucket.push(node);
    } else {
      byFile.set(file, [node]);
    }
  }
  return byFile;
}

function statusOf(code: "A" | "M" | "D" | undefined): ChangeStatus {
  if (code === "A") {
    return "added";
  }
  if (code === "D") {
    return "removed";
  }
  return "modified";
}

/** repo-relative -> target-relative; null when the path lies outside the prefix. */
function stripPrefix(path: string, prefix: string): string | null {
  if (prefix === "") {
    return path;
  }
  const withSlash = `${prefix}/`;
  return path.startsWith(withSlash) ? path.slice(withSlash.length) : null;
}

function joinPrefix(prefix: string, targetPath: string): string {
  return prefix === "" ? targetPath : `${prefix}/${targetPath}`;
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  if (trimmed.includes("..")) {
    throw new CliError(EXIT.usage, "--prefix must not contain '..'");
  }
  return trimmed;
}

function requireRange(range: string): string {
  if (!/^[\w./~^-]+\.\.[\w./~^-]*$/.test(range) && !/^[\w./~^-]+$/.test(range)) {
    throw new CliError(EXIT.usage, `--range '${range}' does not look like a git revision range`);
  }
  return range;
}

function requireDirectory(path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(path);
  try {
    if (!statSync(join(absolute, ".git")).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new CliError(EXIT.usage, `--repo ${absolute} is not a git repository root`);
  }
  return absolute;
}
