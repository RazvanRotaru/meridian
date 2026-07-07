/**
 * The PR-review pipeline behind one call: build the review model (matched files, ranked affected
 * flows, kept/boundary node ids) and lay out the minimal containment subgraph with nested ELK. Kept
 * pure of store concerns so the store can wrap it in a stale-layout guard, exactly like
 * `deriveModuleMapLayout`. The import graph is built once and passed in (the store caches it).
 */

import type { Edge, Node } from "@xyflow/react";
import type { LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "../derive/moduleGraph";
import type { ChangeStatus } from "../derive/changeStatus";
import { buildReviewModel, type BuildReviewModelOptions, type ReviewModel } from "../derive/reviewModel";
import { matchAffectedFiles } from "../derive/matchAffectedFiles";
import { affectedNodes } from "../derive/affectedNodes";
import { buildMinimalSubgraph, type MinimalSubgraphSpec } from "../derive/minimalSubgraph";
import { layoutMinimalSubgraph } from "../layout/minimalSubgraphLayout";

export interface PrReviewLayout {
  model: ReviewModel;
  nodes: Node[];
  edges: Edge[];
}

export async function derivePrReviewLayout(
  index: GraphIndex,
  moduleGraph: ModuleGraph,
  flows: LogicFlows,
  affectedFiles: string[],
  statusByFile: Record<string, ChangeStatus> = {},
  options: BuildReviewModelOptions = {},
): Promise<PrReviewLayout> {
  const model = buildReviewModel(index, moduleGraph, flows, affectedFiles, statusByFile, options);
  const { nodes, edges } = await layoutMinimalSubgraph(subgraphSpec(index, moduleGraph, affectedFiles, statusByFile, options));
  return { model, nodes, edges };
}

/**
 * `buildReviewModel` keeps only the kept/boundary ids from the subgraph — not the richer layout spec
 * (nested nodes + folded wires) — so rebuild that spec from the same seeds for the ELK pass. Both use
 * identical options, so the model's kept/boundary ids and the laid-out nodes stay in lockstep.
 */
function subgraphSpec(
  index: GraphIndex,
  moduleGraph: ModuleGraph,
  affectedFiles: string[],
  statusByFile: Record<string, ChangeStatus>,
  options: BuildReviewModelOptions,
): MinimalSubgraphSpec {
  const matchedFiles = matchAffectedFiles(index, affectedFiles).matched.map((entry) => entry.file);
  const seedModuleIds = affectedNodes(index, matchedFiles).seedModuleIds;
  return buildMinimalSubgraph(index, moduleGraph, seedModuleIds, options, statusByFile).spec;
}
