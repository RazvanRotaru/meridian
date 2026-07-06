/**
 * The Module-map spec: from a root file, the reachable files grouped into directory FRAMES with the
 * card/frame data the ring layout and the surface consume. Pure derivation — buildModuleGraph then
 * computeReach then group by nearest `package` (via `clusterIdOf`). NO category hiding happens here:
 * the full blast radius is always built, and the wiring layer paints hidden categories out.
 */

import { parseNodeId } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { clusterIdOf, clusterLabel } from "./compositionClusters";
import { computeReach } from "./importReach";
import { categorize, type ModuleCategory } from "./moduleCategory";
import { buildModuleGraph, resolveModuleRoot, weightKey, type ModuleGraph } from "./moduleGraph";

// `type` aliases (not interfaces) so they carry the implicit index signature @xyflow/react's
// `Node<T extends Record<string, unknown>>` demands — the same reason CompNodeData/rfTypes use `type`.
export type ModuleCardData = {
  label: string;
  fullPath: string;
  category: ModuleCategory;
  depth: number;
  inCount: number;
  outCount: number;
  isEntry: boolean;
};

export type ModuleFrameData = {
  label: string;
  fileCount: number;
  ring: number;
};

export interface ModuleMapSpec {
  files: Array<{ id: string; frameId: string; data: ModuleCardData }>;
  frames: Array<{ id: string; ring: number; data: ModuleFrameData }>;
  edges: Array<{ id: string; source: string; target: string; weight: number; crossFrame: boolean }>;
  rootId: string | null;
  maxObservedDepth: number;
}

export interface ModuleMapOptions {
  rootId: string;
  maxDepth: number | null;
  entryModules?: string[];
}

// The shared inputs every builder reads — threaded so the builders stay 1-argument and single-purpose.
interface Derivation {
  index: GraphIndex;
  graph: ModuleGraph;
  reach: Map<string, number>;
  frameOf: Map<string, string>;
  rootId: string;
}

/** Build the reachable-file map centred on `opts.rootId`, self-healing a stale root via the fallbacks. */
export function deriveModuleMap(index: GraphIndex, opts: ModuleMapOptions): ModuleMapSpec {
  const graph = buildModuleGraph(index);
  const rootId = effectiveRoot(index, graph, opts);
  if (rootId === null) {
    return emptySpec();
  }
  const reach = computeReach(graph, rootId, opts.maxDepth);
  const derivation: Derivation = { index, graph, reach, rootId, frameOf: mapFilesToFrames(reach, index) };
  return {
    files: buildCards(derivation),
    frames: buildFrames(derivation),
    edges: buildImportEdges(derivation),
    rootId,
    maxObservedDepth: maxObservedDepth(reach),
  };
}

/** The valid root to walk from: the caller's if it's a real file, else the resolved fallback. */
function effectiveRoot(index: GraphIndex, graph: ModuleGraph, opts: ModuleMapOptions): string | null {
  if (graph.fileIds.has(opts.rootId)) {
    return opts.rootId;
  }
  return resolveModuleRoot(index, opts.entryModules);
}

/** Each reachable file to its frame — the nearest `package` ancestor, or the shared "(root)" frame. */
function mapFilesToFrames(reach: Map<string, number>, index: GraphIndex): Map<string, string> {
  const frameOf = new Map<string, string>();
  for (const fileId of reach.keys()) {
    frameOf.set(fileId, clusterIdOf(fileId, index.nodesById));
  }
  return frameOf;
}

/** One card per reachable file, sorted by id so the layout and tests are deterministic. */
function buildCards(derivation: Derivation): ModuleMapSpec["files"] {
  return sortedIds(derivation.reach).map((id) => ({
    id,
    frameId: derivation.frameOf.get(id) as string,
    data: cardData(derivation, id),
  }));
}

function cardData(derivation: Derivation, id: string): ModuleCardData {
  const { graph, index, rootId } = derivation;
  const modulePath = parseNodeId(id).modulePath;
  const isEntry = id === rootId;
  return {
    label: index.nodesById.get(id)?.displayName ?? basename(modulePath),
    fullPath: modulePath,
    category: isEntry ? "entry" : categorize(modulePath),
    depth: derivation.reach.get(id) as number,
    inCount: graph.in.get(id)?.size ?? 0,
    outCount: graph.out.get(id)?.size ?? 0,
    isEntry,
  };
}

/** One frame per directory cluster that owns a reachable file; its ring is its shallowest member. */
function buildFrames(derivation: Derivation): ModuleMapSpec["frames"] {
  const ringByFrame = new Map<string, number>();
  const countByFrame = new Map<string, number>();
  for (const [fileId, frameId] of derivation.frameOf) {
    const depth = derivation.reach.get(fileId) as number;
    ringByFrame.set(frameId, Math.min(ringByFrame.get(frameId) ?? depth, depth));
    countByFrame.set(frameId, (countByFrame.get(frameId) ?? 0) + 1);
  }
  return frameSpecs(ringByFrame, countByFrame, derivation.index).sort(byRingThenLabel);
}

function frameSpecs(
  ringByFrame: Map<string, number>,
  countByFrame: Map<string, number>,
  index: GraphIndex,
): ModuleMapSpec["frames"] {
  return [...ringByFrame].map(([id, ring]) => ({
    id,
    ring,
    data: { label: clusterLabel(id, index.nodesById), fileCount: countByFrame.get(id) as number, ring },
  }));
}

function byRingThenLabel(a: ModuleMapSpec["frames"][number], b: ModuleMapSpec["frames"][number]): number {
  return a.ring - b.ring || a.data.label.localeCompare(b.data.label) || a.id.localeCompare(b.id);
}

/** Import wires among reachable files; `crossFrame` marks a wire spanning two directory clusters. */
function buildImportEdges(derivation: Derivation): ModuleMapSpec["edges"] {
  const edges: ModuleMapSpec["edges"] = [];
  for (const source of sortedIds(derivation.reach)) {
    for (const target of sortedTargets(derivation.graph, source)) {
      if (derivation.reach.has(target)) {
        edges.push(importEdge(derivation, source, target));
      }
    }
  }
  return edges;
}

function importEdge(derivation: Derivation, source: string, target: string): ModuleMapSpec["edges"][number] {
  return {
    id: `import:${source}->${target}`,
    source,
    target,
    weight: derivation.graph.weight.get(weightKey(source, target)) ?? 1,
    crossFrame: derivation.frameOf.get(source) !== derivation.frameOf.get(target),
  };
}

function maxObservedDepth(reach: Map<string, number>): number {
  let max = 0;
  for (const depth of reach.values()) {
    max = Math.max(max, depth);
  }
  return max;
}

function sortedIds(reach: Map<string, number>): string[] {
  return [...reach.keys()].sort();
}

function sortedTargets(graph: ModuleGraph, source: string): string[] {
  return [...(graph.out.get(source) ?? [])].sort();
}

function basename(modulePath: string): string {
  const segments = modulePath.split("/");
  return segments[segments.length - 1] ?? modulePath;
}

function emptySpec(): ModuleMapSpec {
  return { files: [], frames: [], edges: [], rootId: null, maxObservedDepth: 0 };
}
