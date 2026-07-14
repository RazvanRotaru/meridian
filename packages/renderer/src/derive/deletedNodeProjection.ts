/**
 * Project declarations that exist only on the merge-base graph onto a PR-head graph.
 *
 * A prepared review normally renders the freshly extracted HEAD artifact. That is the right
 * coordinate space for surviving and added declarations, but it necessarily omits declarations
 * (and whole files) removed by the PR. This helper builds a presentation-only composite: HEAD stays
 * authoritative for nodes, edges, extensions, and flows, while proven base-only declarations are
 * appended as edge-less tombstones. Their original ids and source locations are retained; only a
 * parentId may be remapped to the corresponding surviving HEAD container after a rename.
 *
 * Modified/renamed files fail closed unless the PR supplied a complete, count-verified diff body.
 * A removed file is different: its status proves the whole pre-image disappeared, so every
 * extracted unit in its base module can be projected even when GitHub omitted the patch body.
 */

import {
  changedDiffLinesFromExtensions,
  changedLineStatsFromExtensions,
  computeAffectedNodes,
  NON_BLOCK_KINDS,
  rangesOverlap,
} from "@meridian/core";
import type {
  AffectedNode,
  ChangedDiffLine,
  ChangedDiffLines,
  ChangedLineStats,
  GraphArtifact,
  GraphNode,
  LineRange,
  ReviewContext,
} from "@meridian/core";
import { buildGraphIndex, type GraphIndex } from "../graph/graphIndex";
import type { PrChangedFile } from "../state/prTypes";
import { matchAffectedFiles, normalizePath } from "./matchAffectedFiles";
import type { ReviewUnitRow } from "./reviewFiles";

export interface DeletedReviewUnit extends ReviewUnitRow {
  /** Tombstones always read the merge-base source, never the PR-head source. */
  sourceSide: "base";
  /** Canonical location.file in the merge-base artifact. */
  basePath: string;
  /** Current PR path used by the files checklist (the new path for a rename). */
  reviewPath: string;
}

export interface DeletedReviewFileProjection {
  /** Current PR/checklist path. */
  path: string;
  /** Canonical merge-base node/source path (the previous path for a rename). */
  basePath: string;
  /** File module on the presentation graph (base module for a removal, HEAD module otherwise). */
  moduleId: string;
  /** Direct base-only affected entries to merge into the ordinary HEAD-side affected list. */
  affected: AffectedNode[];
  /** Checklist-ready deleted units, keyed to `path` but retaining old-side coordinates. */
  units: DeletedReviewUnit[];
  /** Exact rows the base-source code view should use when the patch was available. */
  diffLines: readonly ChangedDiffLine[];
  /** True when removal status, rather than a complete patch body, proves the whole pre-image gone. */
  wholeFileDeleted: boolean;
}

export interface DeletedNodeProjection {
  /** HEAD artifact plus edge-less base tombstones. Returns the input by identity when empty. */
  artifact: GraphArtifact;
  /** Index over `artifact`. Returns the input by identity when empty. */
  index: GraphIndex;
  /** Every node appended from the base artifact, including containment-only ancestors. */
  baseSourceNodeIds: Set<string>;
  /** Only declarations directly proven absent (containers added solely for attachment are excluded). */
  deletedNodeIds: Set<string>;
  /** HEAD counterparts touched by old-side deletions (for deletion-only edits inside survivors). */
  survivingAffectedHeadIds: Set<string>;
  /** Exact comparison-side declaration spans, keyed by their surviving HEAD counterpart id.
   * Source previews use these old coordinates to keep a deletion at a declaration boundary from
   * leaking into the preceding declaration merely because its HEAD cursor is `endLine + 1`. */
  baseSpanByHeadId: Map<string, LineRange>;
  /** Aggregate of `files[].affected`, already using current PR paths and deleted status. */
  affected: AffectedNode[];
  /** Per-file metadata for merging checklist rows and routing old-side source. */
  files: DeletedReviewFileProjection[];
}

export interface DeletedNodeProjectionArgs {
  headArtifact: GraphArtifact;
  headIndex: GraphIndex;
  baseArtifact: GraphArtifact;
  baseIndex: GraphIndex;
  /** Usually the Tests-filtered visible review context. */
  context: ReviewContext;
  /** Raw PR files retain exact deleted rows and completeness proof absent from ReviewContext. */
  prFiles: readonly PrChangedFile[];
}

interface FilePlan {
  path: string;
  basePath: string;
  baseModuleId: string;
  headModuleId: string | null;
  baseNodes: GraphNode[];
  raw: PrChangedFile | undefined;
  removed: boolean;
  deletedRanges: LineRange[];
  diffLines: readonly ChangedDiffLine[];
  exactDiff: boolean;
}

interface Counterparts {
  /** Confident base declaration -> surviving HEAD declaration. */
  byBaseId: Map<string, string>;
  /** Ambiguous declarations are treated as possibly surviving, so projection fails closed. */
  uncertainBaseIds: Set<string>;
}

/** Pure two-sided deletion projection. Base dependency edges/extensions are intentionally ignored. */
export function deriveDeletedNodeProjection(args: DeletedNodeProjectionArgs): DeletedNodeProjection {
  const rawByPath = new Map(args.prFiles.map((file) => [normalizePath(file.path), file]));
  const canonicalDiffLines = changedDiffLinesFromExtensions(args.headArtifact.extensions);
  const canonicalStats = changedLineStatsFromExtensions(args.headArtifact.extensions);
  const plans: FilePlan[] = [];
  const counterparts: Counterparts = { byBaseId: new Map(), uncertainBaseIds: new Set() };

  for (const changed of args.context.changedFiles) {
    if (changed.status === "added") {
      continue;
    }
    const raw = rawByPath.get(normalizePath(changed.path));
    const baseCandidate = raw?.previousPath ?? changed.previousPath ?? changed.path;
    const baseModuleId = matchedModuleId(args.baseIndex, baseCandidate);
    if (baseModuleId === null) {
      continue;
    }
    const baseModule = args.baseIndex.nodesById.get(baseModuleId);
    if (!baseModule) {
      continue;
    }
    const removed = changed.status === "deleted" || raw?.status === "removed";
    const headModuleId = removed ? null : matchedModuleId(args.headIndex, changed.path);
    const baseNodes = moduleSubtree(args.baseIndex, baseModuleId);
    const headPath = headModuleId === null ? null : args.headIndex.nodesById.get(headModuleId)?.location.file ?? null;
    // Prepared artifacts carry the authoritative local `git diff --merge-base -U0` transaction.
    // Prefer it over GitHub's patch, which may be omitted or truncated. Path resolution accepts the
    // extraction-root alias only when it identifies one unique metadata key.
    const canonicalRows = exactCanonicalDiff(
      [headPath, changed.path, baseModule.location.file, baseCandidate],
      canonicalDiffLines,
      canonicalStats,
    );
    const rawRows = exactRawDiff(raw);
    const diffLines = canonicalRows ?? rawRows ?? [];
    const exactDiff = canonicalRows !== null || rawRows !== null;
    const deletedRanges = deletedRangesFromRows(diffLines);
    const plan: FilePlan = {
      path: changed.path,
      basePath: baseModule.location.file,
      baseModuleId,
      headModuleId,
      baseNodes,
      raw,
      removed,
      deletedRanges,
      diffLines,
      exactDiff,
    };
    plans.push(plan);

    // A removed status proves there is no file counterpart. For surviving/renamed files, map
    // semantic containment identities so a path-only id change never becomes a phantom deletion.
    if (!removed && headModuleId !== null) {
      addFileCounterparts(args.baseIndex, baseModuleId, args.headIndex, headModuleId, counterparts);
    }
  }

  const appendedNodes: GraphNode[] = [];
  const appendedById = new Map<string, GraphNode>();
  const baseSourceNodeIds = new Set<string>();
  const deletedNodeIds = new Set<string>();
  const survivingAffectedHeadIds = new Set<string>();
  const baseSpanByHeadId = new Map<string, LineRange>();

  // Counterpart pairing is deliberately semantic and fail-closed (including renamed files). Keep
  // the comparison location beside the HEAD id so downstream source slicing never has to repeat a
  // weaker id/path guess. This includes unchanged survivors as well as deletion-touched ones: the
  // file-global diff rows are shared by every declaration preview in the changed file.
  for (const [baseId, headId] of counterparts.byBaseId) {
    const baseNode = args.baseIndex.nodesById.get(baseId);
    if (!baseNode || !args.headIndex.nodesById.has(headId)) {
      continue;
    }
    baseSpanByHeadId.set(headId, {
      start: baseNode.location.startLine,
      end: baseNode.location.endLine ?? baseNode.location.startLine,
    });
  }

  const ensureProjected = (baseId: string): string | null => {
    if (args.headIndex.nodesById.has(baseId)) {
      return baseId;
    }
    const counterpartId = counterparts.byBaseId.get(baseId);
    if (counterpartId && args.headIndex.nodesById.has(counterpartId)) {
      return counterpartId;
    }
    if (appendedById.has(baseId)) {
      return baseId;
    }
    const baseNode = args.baseIndex.nodesById.get(baseId);
    if (!baseNode) {
      return null;
    }
    const baseParentId = args.baseIndex.parentOf.get(baseId) ?? null;
    const parentId = baseParentId === null ? null : ensureProjected(baseParentId);
    const projected: GraphNode = parentId === (baseNode.parentId ?? null)
      ? baseNode
      : { ...baseNode, parentId };
    appendedById.set(baseId, projected);
    appendedNodes.push(projected);
    baseSourceNodeIds.add(baseId);
    return baseId;
  };

  const files: DeletedReviewFileProjection[] = [];
  const allAffected: AffectedNode[] = [];
  for (const plan of plans) {
    // Exact line rows are required for a surviving file. `diffComplete: false` and an omitted patch
    // both project nothing, even if partial oldHunks happen to be present in ReviewContext.
    if (!plan.removed && (!plan.exactDiff || plan.deletedRanges.length === 0)) {
      continue;
    }

    let candidates: GraphNode[];
    let presentationNodes: GraphNode[];
    if (plan.removed) {
      presentationNodes = plan.baseNodes;
      // The vanished file card is itself deleted/red, alongside every declaration it contained.
      // Checklist units still filter the module below, but graph status must not make the removed
      // file look like a surviving neutral container around red children.
      candidates = plan.baseNodes;
    } else {
      const exact = computeAffectedNodes(plan.baseNodes, [{
        path: plan.basePath,
        status: "deleted",
        oldHunks: plan.deletedRanges,
      }]);
      candidates = exact
        .map((entry) => args.baseIndex.nodesById.get(entry.nodeId))
        .filter((node): node is GraphNode => node !== undefined);
      presentationNodes = candidates;
      // A pure deletion inside a surviving declaration has no green/new-side row to discover on
      // HEAD. Carry its confidently paired HEAD id out explicitly so callers keep that declaration
      // affected without reusing a deletion seam that could spill onto the following declaration.
      for (const node of candidates) {
        const headId = args.headIndex.nodesById.has(node.id)
          ? node.id
          : counterparts.byBaseId.get(node.id);
        if (headId && args.headIndex.nodesById.has(headId)) {
          survivingAffectedHeadIds.add(headId);
        }
      }
    }

    // HEAD id presence wins, then confident semantic counterparts. Ambiguous duplicate declarations
    // are suppressed rather than guessed: absence must be proven before a red tombstone is shown.
    const direct = candidates.filter((node) =>
      !args.headIndex.nodesById.has(node.id)
      && !counterparts.byBaseId.has(node.id)
      && !counterparts.uncertainBaseIds.has(node.id),
    );
    if (direct.length === 0) {
      continue;
    }

    // A fully removed file retains its whole extracted hierarchy, not merely the directly checkable
    // units. Modified files append only direct tombstones plus ancestors discovered recursively.
    for (const node of presentationNodes) {
      ensureProjected(node.id);
    }
    for (const node of direct) {
      ensureProjected(node.id);
      deletedNodeIds.add(node.id);
    }

    const moduleId = ensureProjected(plan.baseModuleId)
      ?? (plan.headModuleId === null ? plan.baseModuleId : counterparts.byBaseId.get(plan.baseModuleId) ?? plan.headModuleId);
    const affected = direct
      .map((node): AffectedNode => ({
        nodeId: node.id,
        status: "deleted",
        file: plan.path,
        overlapsHunk: plan.deletedRanges.length > 0,
      }))
      .sort(compareAffected);
    const units = direct
      .filter((node) => !NON_BLOCK_KINDS.has(node.kind))
      .map((node) => toDeletedUnit(node, plan, args.baseIndex))
      .sort((left, right) => left.startLine - right.startLine || left.nodeId.localeCompare(right.nodeId));
    allAffected.push(...affected);
    files.push({
      path: plan.path,
      basePath: plan.basePath,
      moduleId,
      affected,
      units,
      diffLines: plan.diffLines,
      wholeFileDeleted: plan.removed && !plan.exactDiff,
    });
  }

  if (appendedNodes.length === 0) {
    return {
      artifact: args.headArtifact,
      index: args.headIndex,
      baseSourceNodeIds,
      deletedNodeIds,
      survivingAffectedHeadIds,
      baseSpanByHeadId,
      affected: [],
      files: [],
    };
  }

  // Spread HEAD only: its edges and extensions (including logicFlow) remain authoritative. No base
  // dependency fact can leak into the presentation graph merely because its target was deleted.
  const artifact: GraphArtifact = { ...args.headArtifact, nodes: [...args.headArtifact.nodes, ...appendedNodes] };
  return {
    artifact,
    index: buildGraphIndex(artifact),
    baseSourceNodeIds,
    deletedNodeIds,
    survivingAffectedHeadIds,
    baseSpanByHeadId,
    affected: allAffected.sort(compareAffected),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function matchedModuleId(index: GraphIndex, path: string): string | null {
  const result = matchAffectedFiles(index, [path]);
  return result.matched.length === 1 && result.ambiguous.length === 0 ? result.matched[0].moduleId : null;
}

function moduleSubtree(index: GraphIndex, moduleId: string): GraphNode[] {
  return [...index.nodesById.values()].filter((node) => index.isWithinFocus(moduleId, node.id));
}

/** Exact old-side deletion rows coalesced into inclusive ranges. */
function deletedRangesFromRows(rows: readonly ChangedDiffLine[]): LineRange[] {
  const lines = rows
    .filter((row): row is ChangedDiffLine & { oldLine: number } => row.kind === "deleted" && row.oldLine !== null)
    .map((row) => row.oldLine)
    .sort((left, right) => left - right);
  const ranges: LineRange[] = [];
  for (const line of [...new Set(lines)]) {
    const last = ranges.at(-1);
    if (last && line <= last.end + 1) {
      last.end = Math.max(last.end, line);
    } else {
      ranges.push({ start: line, end: line });
    }
  }
  return ranges;
}

/** The prepared artifact's changedSince payload is an all-or-nothing local git transaction. */
function exactCanonicalDiff(
  aliases: readonly (string | null)[],
  diffLines: ChangedDiffLines | null,
  stats: ChangedLineStats | null,
): readonly ChangedDiffLine[] | null {
  if (diffLines === null || stats === null) {
    return null;
  }
  const metadataKeys = [...new Set([...Object.keys(diffLines), ...Object.keys(stats)])];
  const key = uniquePathAlias(aliases, metadataKeys);
  if (key === null) {
    return null;
  }
  const rows = diffLines[key] ?? [];
  const delta = stats[key];
  if (!delta || countRows(rows, "added") !== delta.added || countRows(rows, "deleted") !== delta.deleted) {
    return null;
  }
  return rows;
}

/** GitHub rows are trusted only when its parser verified the complete body against +/- totals. */
function exactRawDiff(file: PrChangedFile | undefined): readonly ChangedDiffLine[] | null {
  if (file?.diffComplete !== true) {
    return null;
  }
  const rows = file.diffLines ?? [];
  return countRows(rows, "added") === file.additions && countRows(rows, "deleted") === file.deletions
    ? rows
    : null;
}

function countRows(rows: readonly ChangedDiffLine[], kind: ChangedDiffLine["kind"]): number {
  return rows.filter((row) => row.kind === kind).length;
}

function uniquePathAlias(aliases: readonly (string | null)[], keys: readonly string[]): string | null {
  const normalizedAliases = [...new Set(aliases.filter((alias): alias is string => alias !== null).map(normalizePath))];
  const normalizedKeys = new Map(keys.map((key) => [normalizePath(key), key]));
  const exact = normalizedAliases
    .map((alias) => normalizedKeys.get(alias))
    .filter((key): key is string => key !== undefined);
  if (new Set(exact).size === 1) {
    return exact[0];
  }
  if (new Set(exact).size > 1) {
    return null;
  }
  const suffix = keys.filter((key) => {
    const normalizedKey = normalizePath(key);
    return normalizedAliases.some((alias) =>
      alias.endsWith(`/${normalizedKey}`) || normalizedKey.endsWith(`/${alias}`),
    );
  });
  return new Set(suffix).size === 1 ? suffix[0] : null;
}

function addFileCounterparts(
  baseIndex: GraphIndex,
  baseModuleId: string,
  headIndex: GraphIndex,
  headModuleId: string,
  result: Counterparts,
): void {
  result.byBaseId.set(baseModuleId, headModuleId);
  const baseGroups = groupBySemanticPath(moduleSubtree(baseIndex, baseModuleId), baseIndex, baseModuleId);
  const headGroups = groupBySemanticPath(moduleSubtree(headIndex, headModuleId), headIndex, headModuleId);
  for (const [key, baseNodes] of baseGroups) {
    const headNodes = headGroups.get(key);
    if (!headNodes || headNodes.length === 0) {
      continue;
    }
    pairSemanticGroup(baseNodes, headNodes, result);
  }
}

function groupBySemanticPath(
  nodes: readonly GraphNode[],
  index: GraphIndex,
  moduleId: string,
): Map<string, GraphNode[]> {
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.id === moduleId) {
      continue;
    }
    const path = index.ancestorsOf(node.id);
    const moduleIndex = path.findIndex((ancestor) => ancestor.id === moduleId);
    if (moduleIndex === -1) {
      continue;
    }
    const key = path
      .slice(moduleIndex + 1)
      .map((ancestor) => `${ancestor.kind}\u0000${ancestor.qualifiedName}`)
      .join("\u0001");
    const group = groups.get(key);
    group ? group.push(node) : groups.set(key, [node]);
  }
  return groups;
}

/**
 * Pair declarations only when identity is unambiguous. Signatures disambiguate overloads; a final
 * one-to-one remainder tolerates an edited signature. Any larger unresolved group is uncertain and
 * therefore suppressed from deletion projection instead of being source-order guessed.
 */
function pairSemanticGroup(baseNodes: readonly GraphNode[], headNodes: readonly GraphNode[], result: Counterparts): void {
  const remainingBase = new Set(baseNodes);
  const remainingHead = new Set(headNodes);

  for (const base of baseNodes) {
    const exact = headNodes.find((head) => head.id === base.id);
    if (exact) {
      result.byBaseId.set(base.id, exact.id);
      remainingBase.delete(base);
      remainingHead.delete(exact);
    }
  }

  const baseBySignature = uniqueBySignature(remainingBase);
  const headBySignature = uniqueBySignature(remainingHead);
  for (const [signature, base] of baseBySignature) {
    const head = headBySignature.get(signature);
    if (head) {
      result.byBaseId.set(base.id, head.id);
      remainingBase.delete(base);
      remainingHead.delete(head);
    }
  }

  if (remainingBase.size === 1 && remainingHead.size === 1) {
    const base = [...remainingBase][0];
    const head = [...remainingHead][0];
    result.byBaseId.set(base.id, head.id);
    remainingBase.clear();
    remainingHead.clear();
  }

  if (remainingHead.size > 0) {
    for (const base of remainingBase) {
      result.uncertainBaseIds.add(base.id);
    }
  }
}

function uniqueBySignature(nodes: ReadonlySet<GraphNode>): Map<string, GraphNode> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.signature) {
      counts.set(node.signature, (counts.get(node.signature) ?? 0) + 1);
    }
  }
  const unique = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.signature && counts.get(node.signature) === 1) {
      unique.set(node.signature, node);
    }
  }
  return unique;
}

function toDeletedUnit(node: GraphNode, plan: FilePlan, baseIndex: GraphIndex): DeletedReviewUnit {
  const start = node.location.startLine;
  const end = node.location.endLine ?? start;
  const ranges = plan.deletedRanges.filter((range) => rangesOverlap(start, end, range));
  const digest = ranges.length > 0
    ? ranges.map((range) => `${range.start}-${range.end}`).join(",")
    : "whole-file";
  return {
    nodeId: node.id,
    displayName: node.displayName,
    kind: node.kind,
    startLine: start,
    endLine: end,
    depth: baseIndex
      .ancestorsOf(node.id)
      .filter((ancestor) => ancestor.id !== node.id && !NON_BLOCK_KINDS.has(ancestor.kind)).length,
    isTest: baseIndex.testIds.has(node.id),
    fingerprint: `${start}:${end}|base:${digest}`,
    sourceSide: "base",
    basePath: plan.basePath,
    reviewPath: plan.path,
  };
}

function compareAffected(left: AffectedNode, right: AffectedNode): number {
  return left.file.localeCompare(right.file) || left.nodeId.localeCompare(right.nodeId);
}
