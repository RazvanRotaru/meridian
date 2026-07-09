/**
 * The minimal subgraph the overlay renders, in three tiers grown from a seed selection:
 *   - SEED     — the picked node (the Map cards that were selected); the only initially-permanent node.
 *   - PERSISTENT — a ghost the reader drilled through, which commits it (auto-promotes to persistent).
 *                  The committed graph, alongside the seeds.
 *   - GHOST    — the seed's 1-hop neighbours that were VISIBLE on the Module map (the on-map ring),
 *                plus every neighbour revealed by clicking a node's [+] stub, one hop past the
 *                persistent frontier. The auto ring is restricted to on-map neighbours, but
 *                expansions are UNRESTRICTED — that's how the reader deliberately goes off-map.
 *                Tentative: "Clear expansions" drops the revealed ghosts.
 * A node whose import neighbours aren't all shown carries ONE STUB: a single [+n] whose n is the count
 * of hidden import neighbours in BOTH directions (importers + imports, deduped); clicking it reveals
 * them all at once. Files nest in their ancestor package frames (single-child chains collapse). Pure;
 * no React, no ELK. Reuses the module import graph and the Module-map card-data shapes so the overlay
 * renders with the Map's own cards.
 */

import type { GraphNode, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { weightKey, type ModuleGraph } from "./moduleGraph";
import { categorize } from "./moduleCategory";
import { normalizePath } from "./matchAffectedFiles";
import { collapseChains, type ChainCollapse } from "./collapseChains";
import type { ModuleCardData } from "./moduleLevel";
import type { ModulePackageData } from "./packageOverview";
import type { BlockDeps } from "./blockDeps";
import { walkFileCode, type FileCodeWalk, type MinimalExpansion } from "./minimalExpansion";

const MODULE_KIND = "module";

export type MinimalTier = "seed" | "persistent" | "ghost";

/** A single [+n] expander: the count of a source file's hidden import neighbours across BOTH
 * directions (importers + imports, deduped). `type` (not interface) so it carries @xyflow/react's
 * implicit index signature on Node<T>. */
export type MinimalStubData = {
  sourceId: string;
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
  /** import edges only: true when source and target sit in different package frames (gold-coloured). */
  crossPackage?: boolean;
}

export interface MinimalSubgraphSpec {
  nodes: MinimalSubgraphNode[];
  edges: MinimalSubgraphEdge[];
  /** One entry per EXPANDED visible file: its nested code subtree, for the per-file frame layout. */
  expansions: MinimalExpansion[];
}

/** The code-walk inputs needed to make file cards containers and expand them in place — the SAME
 * `expanded` set the Map uses, plus the block-dependency + logic-flow substrates its walk reads. */
export interface CodeContext {
  expanded: ReadonlySet<string>;
  blockDeps: BlockDeps;
  flows: LogicFlows;
}

const NO_CODE: CodeContext = { expanded: new Set(), blockDeps: { edges: [] }, flows: {} };

export function buildMinimalSubgraph(
  index: GraphIndex,
  graph: ModuleGraph,
  seedIds: ReadonlySet<string>,
  keptIds: ReadonlySet<string> = new Set(),
  expanded: readonly string[] = [],
  onMapIds: ReadonlySet<string> = new Set(),
  code: CodeContext = NO_CODE,
): MinimalSubgraphSpec {
  const persistent = collectPersistent(index, seedIds, keptIds);
  const visible = collectVisible(index, graph, seedIds, persistent, expanded, onMapIds);
  const { keptNodeIds, fileCountByGroup } = closeOverAncestors(index, visible);
  const collapse = collapseChains(index, keptNodeIds);
  const walks = walkVisibleFiles(index, graph, visible, code);
  const context: NodeContext = { seedIds, persistent, visible, collapse, fileCountByGroup, walks };
  const stubs = computeStubs(graph, visible);
  return {
    nodes: [...buildContainmentNodes(index, graph, keptNodeIds, context), ...stubNodes(stubs, collapse)],
    edges: [...importEdges(index, graph, visible), ...stubEdges(stubs)],
    expansions: [...walks.values()].map((walk) => walk.expansion).filter((exp): exp is MinimalExpansion => exp !== null),
  };
}

/** Walk every visible file's code once (with the shared `expanded` set): the file card reads its
 * container facts from here, and an expanded file also carries its drawn subtree. */
function walkVisibleFiles(index: GraphIndex, graph: ModuleGraph, visible: ReadonlySet<string>, code: CodeContext): Map<string, FileCodeWalk> {
  const walks = new Map<string, FileCodeWalk>();
  for (const id of visible) {
    walks.set(id, walkFileCode(id, index, graph, code.expanded, code.blockDeps, code.flows));
  }
  return walks;
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

/** All visible files: the persistent set, the seed's 1-hop ring restricted to on-map neighbours
 * (rendered as ghosts), and each expansion's revealed neighbours in BOTH directions (also ghosts, and
 * UNRESTRICTED — expansions deliberately reach past what was on the map). */
function collectVisible(index: GraphIndex, graph: ModuleGraph, seedIds: ReadonlySet<string>, persistent: ReadonlySet<string>, expanded: readonly string[], onMapIds: ReadonlySet<string>): Set<string> {
  const visible = new Set<string>(persistent);
  for (const seed of seedIds) {
    if (!isModule(index, seed)) {
      continue;
    }
    for (const neighbor of bothNeighbors(graph, seed)) {
      if (isModule(index, neighbor) && onMapIds.has(neighbor)) {
        visible.add(neighbor);
      }
    }
  }
  for (const id of expanded) {
    if (!visible.has(id)) {
      continue; // an expansion whose source is no longer shown is inert.
    }
    for (const neighbor of bothNeighbors(graph, id)) {
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
  walks: Map<string, FileCodeWalk>;
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
  // Container facts (chevron + expand-in-place) come from the SAME code walk the Map uses, so a file
  // card gains its chevron and opens into its declarations exactly like the Module map's card.
  const walk = context.walks.get(node.id);
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
      isContainer: walk?.isContainer ?? false,
      isExpanded: walk?.isExpanded ?? false,
      unitCount: walk?.unitCount ?? 0,
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

/** For each visible file, a SINGLE [+n] descriptor when it has any hidden import neighbour — n counts
 * the DISTINCT hidden neighbours across both directions (a file that both imports and is imported by
 * the source counts once). No stub when every neighbour is already shown. */
function computeStubs(graph: ModuleGraph, visible: ReadonlySet<string>): MinimalStubData[] {
  const stubs: MinimalStubData[] = [];
  for (const id of [...visible].sort()) {
    const hidden = new Set<string>();
    for (const neighbor of bothNeighbors(graph, id)) {
      if (!visible.has(neighbor)) {
        hidden.add(neighbor);
      }
    }
    if (hidden.size > 0) {
      stubs.push({ sourceId: id, count: hidden.size });
    }
  }
  return stubs;
}

/** A stub sits in its source file's frame, hung beside it by placement. */
function stubNodes(stubs: readonly MinimalStubData[], collapse: ChainCollapse): MinimalSubgraphNode[] {
  return stubs.map((stub) => ({
    id: stubId(stub),
    kind: "stub" as const,
    parentId: collapse.parentById.get(stub.sourceId) ?? null,
    tier: null,
    data: stub,
  }));
}

/** Import wires between two visible files (folded to one per ordered pair, self-loops dropped).
 * Each carries `crossPackage` — do the two files live under different package frames? — so the
 * overlay can colour cross-package wires gold like the Module map, same-package wires grey. */
function importEdges(index: GraphIndex, graph: ModuleGraph, visible: ReadonlySet<string>): MinimalSubgraphEdge[] {
  const edges: MinimalSubgraphEdge[] = [];
  for (const source of [...visible].sort()) {
    const sourcePackage = nearestPackage(index, source);
    for (const target of [...(graph.out.get(source) ?? [])].sort()) {
      if (source !== target && visible.has(target)) {
        const crossPackage = sourcePackage !== nearestPackage(index, target);
        edges.push({ id: `min:${source}->${target}`, source, target, weight: graph.weight.get(weightKey(source, target)) ?? 1, kind: "import", crossPackage });
      }
    }
  }
  return edges;
}

/** The id of the file's nearest package-kind ancestor (null when it has none). `ancestorsOf` is
 * root..self, so the LAST package entry is the closest one to the file. */
function nearestPackage(index: GraphIndex, id: string): string | null {
  const ancestors = index.ancestorsOf(id);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (ancestors[i].kind === "package") {
      return ancestors[i].id;
    }
  }
  return null;
}

/** A faint tether from each source file to its [+n] stub. */
function stubEdges(stubs: readonly MinimalStubData[]): MinimalSubgraphEdge[] {
  return stubs.map((stub) => {
    const id = stubId(stub);
    return { id: `stubedge:${id}`, source: stub.sourceId, target: id, weight: 1, kind: "stub" as const };
  });
}

function stubId(stub: MinimalStubData): string {
  return `stub:${stub.sourceId}`;
}

function isModule(index: GraphIndex, id: string): boolean {
  return index.nodesById.get(id)?.kind === MODULE_KIND;
}

function bothNeighbors(graph: ModuleGraph, id: string): string[] {
  return [...(graph.in.get(id) ?? []), ...(graph.out.get(id) ?? [])];
}
