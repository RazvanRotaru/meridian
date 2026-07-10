/**
 * The minimal subgraph the overlay renders — the SELECTION EXTRACTED as a curated MEMBER/GHOST view,
 * in the existing three-tier vocabulary:
 *   - SEED       — an ORIGIN member (a card that was in the raw selection); kept verbatim, never
 *                  decomposed (a selected package stays ONE package card).
 *   - PERSISTENT — a member the reader PROMOTED from a ghost (added to the working set).
 *   - GHOST      — a 1-hop import neighbour of the CURRENT members, restricted to ids that were on the
 *                  Module map (`onMapIds`), minus the members. Dimmed; clicking one promotes it. The
 *                  ring is recomputed from the member set every build, so promoting reaches past 1 hop.
 * Members and ghosts may be FILE (module) cards or GROUP (package/dir) leaf cards — a group member is
 * a single card, not a frame of its files. Import + per-kind dep wires connect any two visible boxes
 * (file-level edges lifted to the visible frontier). File members nest in their ancestor package
 * frames (single-child chains collapse) and can expand IN PLACE into their declarations. Pure; no
 * React, no ELK.
 */

import type { GraphNode, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { weightKey, type ModuleGraph } from "./moduleGraph";
import { categorize } from "./moduleCategory";
import { normalizePath } from "./matchAffectedFiles";
import { collapseChains, type ChainCollapse } from "./collapseChains";
import { subtreeFileCount } from "./moduleFrontier";
import type { ModuleCardData } from "./moduleLevel";
import type { ModulePackageData } from "./packageOverview";
import type { BlockDeps } from "./blockDeps";
import { depWireEdges } from "./codeWalk";
import { walkFileCode, type FileCodeWalk, type MinimalExpansion } from "./minimalExpansion";

const MODULE_KIND = "module";

export type MinimalTier = "seed" | "persistent" | "ghost";

export interface MinimalSubgraphNode {
  id: string;
  kind: "group" | "file";
  parentId: string | null;
  /** Leaf cards (a file, or a group member/ghost) carry their tier; a containment FRAME leaves it null. */
  tier: MinimalTier | null;
  /** Joined path segments when this frame is a collapsed package chain. */
  collapsedLabel?: string;
  data: ModuleCardData | ModulePackageData;
}

export interface MinimalSubgraphEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  /** "import"/"dep" wires both connect two visible boxes; the paint colours each by kind. */
  kind: "import" | "dep";
  /** import edges only: true when source and target sit in different package frames (gold-coloured). */
  crossPackage?: boolean;
  /** dep edges only: the underlying coupling kind (calls / instantiates / …) the paint colours by. */
  depKind?: string;
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

/**
 * Build the curated subgraph: the `memberIds` working set (verbatim, any kind), plus its 1-hop ghost
 * ring restricted to `onMapIds`. `originIds` (the raw selection) decides seed vs persistent tiers.
 */
export function buildMinimalSubgraph(
  index: GraphIndex,
  graph: ModuleGraph,
  memberIds: ReadonlySet<string>,
  originIds: ReadonlySet<string>,
  onMapIds: ReadonlySet<string> = new Set(),
  code: CodeContext = NO_CODE,
): MinimalSubgraphSpec {
  const ghosts = collectGhosts(index, graph, memberIds, onMapIds);
  const visible = new Set<string>([...memberIds, ...ghosts]);
  const groupLeaf = new Set([...visible].filter((id) => !isModule(index, id)));
  const fileVisible = new Set([...visible].filter((id) => isModule(index, id)));
  const { keptNodeIds, fileCountByGroup } = closeOverAncestors(index, fileVisible);
  const collapse = collapseChains(index, keptNodeIds);
  const walks = walkVisibleFiles(index, graph, fileVisible, code);
  const context: NodeContext = { memberIds, originIds, collapse, fileCountByGroup, walks };
  return {
    nodes: [
      ...buildContainmentNodes(index, graph, keptNodeIds, groupLeaf, context),
      ...buildLeafGroupNodes(index, [...groupLeaf], context),
    ],
    edges: [...importEdges(index, graph, visible), ...depEdges(index, visible, code)],
    expansions: [...walks.values()].map((walk) => walk.expansion).filter((exp): exp is MinimalExpansion => exp !== null),
  };
}

/** The ghost ring: on-map import neighbours of the members, minus the members. A file inside a member
 * is REPRESENTED by that member, so an edge from member-content to outside content promotes the
 * outside content's nearest on-map box (a file if it was on the map, else its package) to a ghost. */
function collectGhosts(index: GraphIndex, graph: ModuleGraph, memberIds: ReadonlySet<string>, onMapIds: ReadonlySet<string>): Set<string> {
  const ghosts = new Set<string>();
  const memberBoxOf = (id: string) => nearestInSet(index, id, memberIds);
  const onMapBoxOf = (id: string) => nearestInSet(index, id, onMapIds);
  const consider = (inner: string, outer: string): void => {
    if (memberBoxOf(inner) === null || memberBoxOf(outer) !== null) {
      return; // `inner` must be inside a member and `outer` outside every member.
    }
    const box = onMapBoxOf(outer);
    if (box !== null && !memberIds.has(box)) {
      ghosts.add(box);
    }
  };
  for (const [source, targets] of graph.out) {
    for (const target of targets) {
      consider(source, target);
      consider(target, source);
    }
  }
  return ghosts;
}

/** The nearest ancestor-or-self of `id` that is in `set` (self first). `ancestorsOf` is root..self,
 * so scanning from the end finds the closest. Null when no ancestor-or-self qualifies. */
function nearestInSet(index: GraphIndex, id: string, set: ReadonlySet<string>): string | null {
  const ancestors = index.ancestorsOf(id);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (set.has(ancestors[i].id)) {
      return ancestors[i].id;
    }
  }
  return null;
}

interface NodeContext {
  memberIds: ReadonlySet<string>;
  originIds: ReadonlySet<string>;
  collapse: ChainCollapse;
  fileCountByGroup: Map<string, number>;
  walks: Map<string, FileCodeWalk>;
}

/** Walk every visible FILE's code once (with the shared `expanded` set): the file card reads its
 * container facts from here, and an expanded file also carries its drawn subtree. */
function walkVisibleFiles(index: GraphIndex, graph: ModuleGraph, fileVisible: ReadonlySet<string>, code: CodeContext): Map<string, FileCodeWalk> {
  const walks = new Map<string, FileCodeWalk>();
  for (const id of fileVisible) {
    if (!isModule(index, id)) {
      continue; // defensive: only file modules carry a code walk.
    }
    walks.set(id, walkFileCode(id, index, graph, code.expanded, code.blockDeps, code.flows));
  }
  return walks;
}

/** Ancestor-close the visible files (root..file inclusive) and tally visible files per ancestor frame. */
function closeOverAncestors(index: GraphIndex, fileVisible: ReadonlySet<string>) {
  const keptNodeIds = new Set<string>();
  const fileCountByGroup = new Map<string, number>();
  for (const fileId of fileVisible) {
    for (const ancestor of index.ancestorsOf(fileId)) {
      keptNodeIds.add(ancestor.id);
      if (ancestor.id !== fileId) {
        fileCountByGroup.set(ancestor.id, (fileCountByGroup.get(ancestor.id) ?? 0) + 1);
      }
    }
  }
  return { keptNodeIds, fileCountByGroup };
}

/** File cards + their ancestor containment FRAMES. A group that is itself a leaf member/ghost card
 * (`groupLeaf`) is skipped here — it is emitted as its own card, never a frame of files. */
function buildContainmentNodes(index: GraphIndex, graph: ModuleGraph, keptNodeIds: Set<string>, groupLeaf: ReadonlySet<string>, context: NodeContext): MinimalSubgraphNode[] {
  const nodes: MinimalSubgraphNode[] = [];
  for (const id of keptNodeIds) {
    const node = index.nodesById.get(id);
    if (!node || groupLeaf.has(id) || context.collapse.absorbed.has(id)) {
      continue;
    }
    nodes.push(node.kind === MODULE_KIND ? fileNode(node, graph, context) : frameNode(node, context));
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

/** Membership decides ghost vs not FIRST; origin only splits seed from persistent AMONG members. A
 * demoted origin re-enters the ghost ring structurally (collectGhosts re-adds it via its remaining
 * member couplings), so it must read as a ghost too — dimmed, wearing the "+" — else it strands at
 * full seed brightness with no affordance to re-add it. */
function tierOf(id: string, context: NodeContext): MinimalTier {
  if (!context.memberIds.has(id)) {
    return "ghost";
  }
  return context.originIds.has(id) ? "seed" : "persistent";
}

/** A containment FRAME (a package/dir ancestor of file members): tier null, coupling counts elided. */
function frameNode(node: GraphNode, context: NodeContext): MinimalSubgraphNode {
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

/** A selected/ghosted GROUP as ONE leaf package card (flat, tiered) — never decomposed into files. */
function buildLeafGroupNodes(index: GraphIndex, ids: string[], context: NodeContext): MinimalSubgraphNode[] {
  return ids
    .sort()
    .map((id) => index.nodesById.get(id))
    .filter((node): node is GraphNode => node !== undefined)
    .map((node) => ({
      id: node.id,
      kind: "group" as const,
      parentId: null,
      tier: tierOf(node.id, context),
      data: { label: node.displayName, fileCount: subtreeFileCount(index, node.id), ca: 0, ce: 0 },
    }));
}

/** Import wires between two visible boxes: file-level edges lifted so each endpoint rises to its
 * nearest visible ancestor-or-self (folding a group member's files onto its card). Folded to one per
 * ordered box pair, self-loops dropped. `crossPackage` colours a boundary-crossing wire gold. */
function importEdges(index: GraphIndex, graph: ModuleGraph, visible: ReadonlySet<string>): MinimalSubgraphEdge[] {
  const boxOf = (id: string) => nearestInSet(index, id, visible);
  const aggregates = new Map<string, { source: string; target: string; weight: number }>();
  for (const [source, targets] of graph.out) {
    const sourceBox = boxOf(source);
    if (sourceBox === null) {
      continue;
    }
    for (const target of targets) {
      const targetBox = boxOf(target);
      if (targetBox === null || targetBox === sourceBox) {
        continue;
      }
      const weight = graph.weight.get(weightKey(source, target)) ?? 1;
      const existing = aggregates.get(`${sourceBox}->${targetBox}`);
      if (existing) {
        existing.weight += weight;
      } else {
        aggregates.set(`${sourceBox}->${targetBox}`, { source: sourceBox, target: targetBox, weight });
      }
    }
  }
  return [...aggregates.values()]
    .sort((a, b) => (a.source === b.source ? a.target.localeCompare(b.target) : a.source.localeCompare(b.source)))
    .map(({ source, target, weight }) => ({
      id: `min:${source}->${target}`,
      source,
      target,
      weight,
      kind: "import" as const,
      crossPackage: nearestPackage(index, source) !== nearestPackage(index, target),
    }));
}

/** Per-kind dependency wires between visible files — the SAME lift the Map draws (calls /
 * instantiates / extends / implements / references), so the overlay reads like the Map at the same
 * level. Every visible file counts as a "code" endpoint here: with only file cards drawn, file↔file
 * coupling IS this level's dep story. An off-overlay endpoint lifts to nothing and drops; an
 * intra-file coupling folds to a self-loop and drops (both inside `liftEdges`). A group (package)
 * card carries no code walk, so it simply contributes no dep wire — file↔file coupling is the story. */
function depEdges(index: GraphIndex, visible: ReadonlySet<string>, code: CodeContext): MinimalSubgraphEdge[] {
  return depWireEdges(code.blockDeps, visible, index, (id) => visible.has(id), new Set()).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    kind: "dep" as const,
    depKind: edge.depKind,
  }));
}

/** The id of the box's nearest package-kind ancestor-or-self (null when it has none). `ancestorsOf` is
 * root..self, so the LAST package entry is the closest one. */
function nearestPackage(index: GraphIndex, id: string): string | null {
  const ancestors = index.ancestorsOf(id);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (ancestors[i].kind === "package") {
      return ancestors[i].id;
    }
  }
  return null;
}

function isModule(index: GraphIndex, id: string): boolean {
  return index.nodesById.get(id)?.kind === MODULE_KIND;
}
