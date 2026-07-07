/**
 * The PR-review model, composed from the smaller pure passes: match the changed paths to module
 * nodes, expand to the affected node universe, build the minimal containment subgraph (kept +
 * boundary ids), and rank the affected flows. This is the single derivation the store calls; each
 * step lives in its own module with its own tests. Pure; no React, no store, no ELK.
 */

import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "./moduleGraph";
import { matchAffectedFiles } from "./matchAffectedFiles";
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
  options: BuildReviewModelOptions = {},
): ReviewModel {
  const match = matchAffectedFiles(index, affectedFiles);
  const nodes = affectedNodes(index, match.matched.map((entry) => entry.file));
  const subgraph = buildMinimalSubgraph(index, moduleGraph, nodes.seedModuleIds, options);
  const { flows: ranked, notCovered } = reviewFlows(flows, index, nodes.affectedCallableIds, nodes.affectedFilesResolved);
  return {
    matchedFiles: nodes.affectedFilesResolved,
    unmatched: match.unmatched,
    ambiguous: match.ambiguous,
    flows: ranked,
    notCovered,
    keptNodeIds: subgraph.keptNodeIds,
    boundaryNodeIds: subgraph.boundaryNodeIds,
  };
}
