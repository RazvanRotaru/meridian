/**
 * The minimal subgraph the overlay renders, in three tiers grown from a seed selection:
 *   - SEED     — the picked node (the Map cards that were selected); the only initially-permanent node.
 *   - PERSISTENT — a ghost the reader drilled through, which commits it (auto-promotes to persistent).
 *                  The committed graph, alongside the seeds.
 *   - GHOST    — the seed's always-shown 1-hop import ring (both directions), plus any neighbour
 *                revealed by clicking a node's directional [+] stub, one hop past the persistent
 *                frontier. Tentative: "Clear expansions" drops the revealed ghosts.
 * A node whose import neighbours aren't all shown carries directional STUB nodes: a [+n] on the left
 * for hidden importers ("in"), a [+n] on the right for hidden imports ("out"). Files nest in their
 * ancestor package frames (single-child chains collapse). Pure; no React, no ELK. Reuses the module
 * import graph and the Module-map card-data shapes so the overlay renders with the Map's own cards.
 */

import type { GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { weightKey, type ModuleGraph } from "./moduleGraph";
import { categorize } from "./moduleCategory";
import { normalizePath } from "./matchAffectedFiles";
import { collapseChains, type ChainCollapse } from "./collapseChains";
import type { ModuleCardData } from "./moduleLevel";
import type { ModulePackageData } from "./packageOverview";

const MODULE_KIND = "module";

export type Direction = "in" | "out";
export type MinimalTier = "seed" | "persistent" | "ghost";

/** A directional [+n] expander: the hidden-neighbour count in one direction off a source file.
 * `type` (not interface) so it carries @xyflow/react's implicit index signature on Node<T>. */
export type MinimalStubData = {
  sourceId: string;
  direction: Direction;
  count: number;
};

export interface MinimalSubgraphNode {
  id: string;
  kind: "group" | "file" | "stub";
  parentId: string | null;
  /** Files only: which tier the card renders as (a stub/group leaves this null). */
  tier: MinimalTier | null;
  /** Joined path segments when this frame is a collapsed package chain. */
  collapsedLabel?: string;
  data: ModuleCardData | ModulePackageData | MinimalStubData;
}

export interface MinimalSubgraphEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  /** "import" wires connect two visible files; "stub" wires tether a [+n] to its source file. */
  kind: "import" | "stub";
}

export interface MinimalSubgraphSpec {
  nodes: MinimalSubgraphNode[];
  edges: MinimalSubgraphEdge[];
}

/** One clicked directional expansion — reveals `id`'s `direction` neighbours as ghosts. */
export interface ExpansionEntry {
  id: string;
  direction: Direction;
}

export function buildMinimalSubgraph(
  index: GraphIndex,
  graph: ModuleGraph,
  seedIds: ReadonlySet<string>,
  keptIds: ReadonlySet<string> = new Set(),
  expanded: readonly ExpansionEntry[] = [],
): MinimalSubgraphSpec {
  const persistent = collectPersistent(index, seedIds, keptIds);
  const visible = collectVisible(index, graph, seedIds, persistent, expanded);
  const { keptNodeIds, fileCountByGroup } = closeOverAncestors(index, visible);
  const collapse = collapseChains(index, keptNodeIds);
  const context: NodeContext = { seedIds, persistent, visible, collapse, fileCountByGroup };
  const stubs = computeStubs(graph, visible);
  return {
    nodes: [...buildContainmentNodes(index, graph, keptNodeIds, context), ...stubNodes(stubs, collapse)],
    edges: [...importEdges(graph, visible), ...stubEdges(stubs)],
  };
}

/** Persistent files: the seeds and any ghost the reader drilled through (committed). The seed's
 * 1-hop ring is NOT persistent — it renders as ghosts until drilled through. */
function collectPersistent(index: GraphIndex, seedIds: ReadonlySet<string>, keptIds: ReadonlySet<string>): Set<string> {
  const persistent = new Set<string>();
  for (const seed of seedIds) {
    if (isModule(index, seed)) {
      persistent.add(seed);
    }
  }
  for (const kept of keptIds) {
    if (isModule(index, kept)) {
      persistent.add(kept);
    }
  }
  return persistent;
}

/** All visible files: the persistent set, the seed's always-shown 1-hop ring (both directions,
 * rendered as ghosts), and each expansion's revealed direction-neighbours (also ghosts). */
function collectVisible(index: GraphIndex, graph: ModuleGraph, seedIds: ReadonlySet<string>, persistent: ReadonlySet<string>, expanded: readonly ExpansionEntry[]): Set<string> {
  const visible = new Set<string>(persistent);
  for (const seed of seedIds) {
    if (!isModule(index, seed)) {
      continue;
    }
    for (const neighbor of bothNeighbors(graph, seed)) {
      if (isModule(index, neighbor)) {
        visible.add(neighbor);
      }
    }
  }
  for (const { id, direction } of expanded) {
    if (!visible.has(id)) {
      continue; // an expansion whose source is no longer shown is inert.
    }
    for (const neighbor of directionNeighbors(graph, id, direction)) {
      if (isModule(index, neighbor)) {
        visible.add(neighbor);
      }
    }
  }
  return visible;
}

interface NodeContext {
  seedIds: ReadonlySet<string>;
  persistent: ReadonlySet<string>;
  visible: ReadonlySet<string>;
  collapse: ChainCollapse;
  fileCountByGroup: Map<string, number>;
}

/** Ancestor-close the visible files (root..file inclusive) and tally visible files per ancestor frame. */
function closeOverAncestors(index: GraphIndex, visible: ReadonlySet<string>) {
  const keptNodeIds = new Set<string>();
  const fileCountByGroup = new Map<string, number>();
  for (const fileId of visible) {
    for (const ancestor of index.ancestorsOf(fileId)) {
      keptNodeIds.add(ancestor.id);
      if (ancestor.id !== fileId) {
        fileCountByGroup.set(ancestor.id, (fileCountByGroup.get(ancestor.id) ?? 0) + 1);
      }
    }
  }
  return { keptNodeIds, fileCountByGroup };
}

function buildContainmentNodes(index: GraphIndex, graph: ModuleGraph, keptNodeIds: Set<string>, context: NodeContext): MinimalSubgraphNode[] {
  const nodes: MinimalSubgraphNode[] = [];
  for (const id of keptNodeIds) {
    const node = index.nodesById.get(id);
    if (!node || context.collapse.absorbed.has(id)) {
      continue;
    }
    nodes.push(node.kind === MODULE_KIND ? fileNode(node, graph, context) : groupNode(node, context));
  }
  return nodes.sort((a, b) => a.id.localeCompare(b.id));
}

function fileNode(node: GraphNode, graph: ModuleGraph, context: NodeContext): MinimalSubgraphNode {
  const file = normalizePath(node.location.file);
  return {
    id: node.id,
    kind: "file",
    parentId: context.collapse.parentById.get(node.id) ?? null,
    tier: tierOf(node.id, context),
    data: {
      label: node.displayName,
      fullPath: file,
      category: categorize(file),
      inCount: graph.in.get(node.id)?.size ?? 0,
      outCount: graph.out.get(node.id)?.size ?? 0,
      isEntry: false,
      // The overlay is read-only: file cards never expand in place, so no container affordance.
      isContainer: false,
      isExpanded: false,
      unitCount: 0,
    },
  };
}

function tierOf(id: string, context: NodeContext): MinimalTier {
  if (context.seedIds.has(id)) {
    return "seed";
  }
  return context.persistent.has(id) ? "persistent" : "ghost";
}

function groupNode(node: GraphNode, context: NodeContext): MinimalSubgraphNode {
  const collapsedLabel = context.collapse.labelById.get(node.id);
  return {
    id: node.id,
    kind: "group",
    parentId: context.collapse.parentById.get(node.id) ?? null,
    tier: null,
    collapsedLabel,
    data: { label: collapsedLabel ?? node.displayName, fileCount: context.fileCountByGroup.get(node.id) ?? 0, ca: 0, ce: 0 },
  };
}

/** For each visible file, a [+n] descriptor per direction that still has hidden neighbours. */
function computeStubs(graph: ModuleGraph, visible: ReadonlySet<string>): MinimalStubData[] {
  const stubs: MinimalStubData[] = [];
  for (const id of [...visible].sort()) {
    const inHidden = countHidden(graph.in.get(id), visible);
    if (inHidden > 0) {
      stubs.push({ sourceId: id, direction: "in", count: inHidden });
    }
    const outHidden = countHidden(graph.out.get(id), visible);
    if (outHidden > 0) {
      stubs.push({ sourceId: id, direction: "out", count: outHidden });
    }
  }
  return stubs;
}

function countHidden(neighbors: ReadonlySet<string> | undefined, visible: ReadonlySet<string>): number {
  let hidden = 0;
  for (const neighbor of neighbors ?? []) {
    if (!visible.has(neighbor)) {
      hidden += 1;
    }
  }
  return hidden;
}

/** A stub sits in its source file's frame; ELK's edge places it left (in) or right (out) of it. */
function stubNodes(stubs: readonly MinimalStubData[], collapse: ChainCollapse): MinimalSubgraphNode[] {
  return stubs.map((stub) => ({
    id: stubId(stub),
    kind: "stub" as const,
    parentId: collapse.parentById.get(stub.sourceId) ?? null,
    tier: null,
    data: stub,
  }));
}

/** Import wires between two visible files (folded to one per ordered pair, self-loops dropped). */
function importEdges(graph: ModuleGraph, visible: ReadonlySet<string>): MinimalSubgraphEdge[] {
  const edges: MinimalSubgraphEdge[] = [];
  for (const source of [...visible].sort()) {
    for (const target of [...(graph.out.get(source) ?? [])].sort()) {
      if (source !== target && visible.has(target)) {
        edges.push({ id: `min:${source}->${target}`, source, target, weight: graph.weight.get(weightKey(source, target)) ?? 1, kind: "import" });
      }
    }
  }
  return edges;
}

/** A faint tether from each [+n] stub to its source (in points into the file, out points out). */
function stubEdges(stubs: readonly MinimalStubData[]): MinimalSubgraphEdge[] {
  return stubs.map((stub) => {
    const id = stubId(stub);
    const [source, target] = stub.direction === "in" ? [id, stub.sourceId] : [stub.sourceId, id];
    return { id: `stubedge:${id}`, source, target, weight: 1, kind: "stub" as const };
  });
}

function stubId(stub: MinimalStubData): string {
  return `stub:${stub.sourceId}|${stub.direction}`;
}

function isModule(index: GraphIndex, id: string): boolean {
  return index.nodesById.get(id)?.kind === MODULE_KIND;
}

function bothNeighbors(graph: ModuleGraph, id: string): string[] {
  return [...(graph.in.get(id) ?? []), ...(graph.out.get(id) ?? [])];
}

function directionNeighbors(graph: ModuleGraph, id: string, direction: Direction): ReadonlySet<string> {
  return (direction === "in" ? graph.in.get(id) : graph.out.get(id)) ?? new Set<string>();
}
