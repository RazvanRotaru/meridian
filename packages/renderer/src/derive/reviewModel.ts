/**
 * The PR-review model, composed from the smaller pure passes: match the changed paths to module
 * nodes, expand to the affected node universe, build the minimal containment subgraph (kept +
 * boundary ids), and rank the affected flows. This is the single derivation the store calls; each
 * step lives in its own module with its own tests. Pure; no React, no store, no ELK.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "./moduleGraph";
import type { ChangeStatus } from "./changeStatus";
import { matchAffectedFiles, normalizePath } from "./matchAffectedFiles";
import { affectedNodes } from "./affectedNodes";
import { buildMinimalSubgraph } from "./minimalSubgraph";
import { reviewFlows, type NotCoveredFile, type RankedReviewFlow } from "./reviewFlows";

export type { RankedReviewFlow, NotCoveredFile } from "./reviewFlows";

export interface ReviewModel {
  /** Affected files resolved to real graph files, normalized and sorted. */
  matchedFiles: string[];
  /** Candidate paths that matched no file. */
  unmatched: string[];
  ambiguous: { path: string; candidates: string[] }[];
  /** Qualifying flows, changed-first. */
  flows: RankedReviewFlow[];
  notCovered: NotCoveredFile[];
  /** Node ids in the minimal containment subtree (seeds + boundary + ancestors). */
  keptNodeIds: string[];
  /** The faded 1-hop boundary file node ids. */
  boundaryNodeIds: string[];
  /** Affected files whose status is "removed": no node exists at HEAD, surfaced in the side pane. */
  removed: string[];
}

export interface BuildReviewModelOptions {
  boundaryCap?: number;
  includeBoundary?: boolean;
}

export function buildReviewModel(
  index: GraphIndex,
  moduleGraph: ModuleGraph,
  flows: LogicFlows,
  affectedFiles: string[],
  statusByFile: Record<string, ChangeStatus> = {},
  options: BuildReviewModelOptions = {},
): ReviewModel {
  const removed = removedFiles(affectedFiles, statusByFile);
  const match = matchAffectedFiles(index, affectedFiles);
  const nodes = affectedNodes(index, match.matched.map((entry) => entry.file));
  const subgraph = buildMinimalSubgraph(index, moduleGraph, nodes.seedModuleIds, options, statusByFile);
  const { flows: ranked, notCovered } = reviewFlows(flows, index, nodes.affectedCallableIds, nodes.affectedFilesResolved);
  return {
    matchedFiles: nodes.affectedFilesResolved,
    // A removed file has no node at HEAD, so it lands in `unmatched`; reclassify it to `removed` so
    // it reads as "gone", not as a typo/unresolved path.
    unmatched: match.unmatched.filter((path) => !removed.includes(path)),
    ambiguous: match.ambiguous,
    flows: ranked,
    notCovered,
    keptNodeIds: subgraph.keptNodeIds,
    boundaryNodeIds: subgraph.boundaryNodeIds,
    removed,
  };
}

/** Affected paths flagged "removed" (normalized, deduped, sorted) — no node exists for them at HEAD. */
function removedFiles(affectedFiles: string[], statusByFile: Record<string, ChangeStatus>): string[] {
  const removed = new Set<string>();
  for (const file of affectedFiles) {
    const path = normalizePath(file);
    if (statusByFile[path] === "removed") {
      removed.add(path);
    }
  }
  return [...removed].sort();
}
