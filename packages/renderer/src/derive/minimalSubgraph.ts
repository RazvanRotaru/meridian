/**
 * The minimal subgraph the overlay renders — the SELECTION EXTRACTED as a curated MEMBER set ringed
 * by the Map's OWN ghost satellites:
 *   - SEED       — an ORIGIN member (a card that was in the raw selection); kept verbatim, never
 *                  decomposed (a selected package stays ONE package card).
 *   - PERSISTENT — a member the reader PROMOTED from a ghost (added to the working set).
 *   - GHOST      — NOT a tier but the Map's ghost projection (`ghostDepWires`): every code coupling
 *                  that LEAVES the member set charts its off-overlay end as a detached symbol
 *                  satellite (folded to its owning unit, same-folder crowds grouped by
 *                  `groupGhostEmission`), wired per coupling kind. The "+" on a satellite promotes
 *                  its home file/folder; the ring recomputes from the member set every build.
 * Members may be FILE (module) cards or GROUP (package/dir) leaf cards — a group member is a single
 * card, not a frame of its files. Import + per-kind dep wires connect member boxes (file-level edges
 * lifted to the member frontier). File members nest in their ancestor package frames (single-child
 * chains collapse) and can expand IN PLACE into their declarations. Pure; no React, no ELK.
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
import { ghostDepWires, withoutHidden, type GhostData, type GhostEmission } from "./ghostDeps";
import { groupGhostEmission } from "./groupGhosts";
import { walkFileCode, type FileCodeWalk, type MinimalExpansion } from "./minimalExpansion";

const MODULE_KIND = "module";
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export type MinimalTier = "seed" | "persistent";

export interface MinimalSubgraphNode {
  id: string;
  kind: "group" | "file" | "ghost";
  parentId: string | null;
  /** Member LEAF cards (a file, or a group member) carry their tier; frames and ghosts leave it null. */
  tier: MinimalTier | null;
  /** Joined path segments when this frame is a collapsed package chain. */
  collapsedLabel?: string;
  data: ModuleCardData | ModulePackageData | GhostData;
}

export interface MinimalSubgraphEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  /** "import"/"dep" wires both connect two drawn boxes; the paint colours each by kind. */
  kind: "import" | "dep";
  /** import edges only: true when source and target sit in different package frames (gold-coloured). */
  crossPackage?: boolean;
  /** dep edges only: the underlying coupling kind (calls / instantiates / …) the paint colours by. */
  depKind?: string;
  /** The far endpoint is a GHOST satellite — the layout bands it outside the member core. */
  ghost?: boolean;
}

export interface MinimalSubgraphSpec {
  nodes: MinimalSubgraphNode[];
  edges: MinimalSubgraphEdge[];
  /** One entry per EXPANDED member file: its nested code subtree, for the per-file frame layout. */
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
 * Build the curated subgraph: the `memberIds` working set (verbatim, any kind), ringed by its ghost
 * satellites. `originIds` (the raw selection) decides seed vs persistent tiers; `hiddenIds` (the
 * Tests toggle) drops hidden satellites exactly like the Map's ghost level.
 */
export function buildMinimalSubgraph(
  index: GraphIndex,
  graph: ModuleGraph,
  memberIds: ReadonlySet<string>,
  originIds: ReadonlySet<string>,
  code: CodeContext = NO_CODE,
  hiddenIds: ReadonlySet<string> = EMPTY_IDS,
): MinimalSubgraphSpec {
  const groupLeaf = new Set([...memberIds].filter((id) => !isModule(index, id)));
  const fileVisible = new Set([...memberIds].filter((id) => isModule(index, id)));
  const { keptNodeIds, fileCountByGroup } = closeOverAncestors(index, fileVisible);
  const collapse = collapseChains(index, keptNodeIds);
  const walks = walkVisibleFiles(index, graph, fileVisible, code);
  const context: NodeContext = { memberIds, originIds, collapse, fileCountByGroup, walks };
  const emission = projectGhosts(index, memberIds, walks, code, hiddenIds);
  // A folder group-ghost can carry the id of a member's own (never-rendered) ancestor frame — the
  // ghost card wins the id so the spec stays one-node-per-id (frames are flattened away anyway).
  const ghostIds = new Set(emission.ghosts.keys());
  return {
    nodes: [
      ...buildContainmentNodes(index, graph, keptNodeIds, new Set([...groupLeaf, ...ghostIds]), context),
      ...buildLeafGroupNodes(index, [...groupLeaf], context),
      ...ghostNodes(emission),
    ],
    edges: [...importEdges(index, graph, memberIds), ...depEdges(index, memberIds, code), ...ghostEdges(emission)],
    expansions: [...walks.values()].map((walk) => walk.expansion).filter((exp): exp is MinimalExpansion => exp !== null),
  };
}

/**
 * The ghost ring, by the Map's OWN projection: every blockDeps coupling (and resolved step call from
 * an expanded member's walk) whose far end lifts to NO member charts that end as a symbol satellite,
 * exactly like `moduleTree`'s ghost level. `visibleIds` here is the member set — `nearestVisible`
 * lifts any symbol inside a member (file OR package) onto its box — and every member box counts as a
 * code anchor for the same reason `depEdges` treats every file as code: with only member boxes drawn,
 * member↔outside coupling IS this surface's off-screen story. Hidden (test) ghosts drop BEFORE
 * grouping so group counts stay honest, then same-folder crowds fold into one folder group-ghost
 * (the Highways treatment, `groupGhosts`) — the exact order of the Map's `ghostLevel`.
 */
function projectGhosts(index: GraphIndex, memberIds: ReadonlySet<string>, walks: Map<string, FileCodeWalk>, code: CodeContext, hiddenIds: ReadonlySet<string>): GhostEmission {
  const calls = [...walks.values()].flatMap((walk) => [...walk.calls]);
  const expandedBlocks = new Set([...walks.values()].flatMap((walk) => [...walk.expandedBlocks]));
  const raw = ghostDepWires(code.blockDeps, calls, memberIds, index, (id) => memberIds.has(id), expandedBlocks);
  return groupGhostEmission(withoutHidden(raw, hiddenIds), index);
}

/** Ghost satellites as spec nodes: kind "ghost", the REAL artifact id, the Map's own GhostData. */
function ghostNodes(emission: GhostEmission): MinimalSubgraphNode[] {
  return [...emission.ghosts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, data]) => ({ id, kind: "ghost" as const, parentId: null, tier: null, data }));
}

/** Ghost wires: per-coupling-kind dep edges flagged `ghost` — the Map's `gdep:` shape. */
function ghostEdges(emission: GhostEmission): MinimalSubgraphEdge[] {
  return emission.wires
    .map((wire) => ({
      id: `gdep:${wire.kind}:${wire.source}->${wire.target}`,
      source: wire.source,
      target: wire.target,
      weight: wire.weight,
      kind: "dep" as const,
      depKind: wire.kind,
      ghost: true,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
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

/** Walk every member FILE's code once (with the shared `expanded` set): the file card reads its
 * container facts from here, an expanded file carries its drawn subtree, and the ghost projection
 * reads the walks' step calls + expanded blocks. */
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

/** Ancestor-close the member files (root..file inclusive) and tally member files per ancestor frame. */
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

/** File cards + their ancestor containment FRAMES. An id in `claimed` is skipped here — a group
 * that is itself a leaf member card is emitted as its own card (never a frame of files), and a
 * frame whose id a folder group-ghost took is represented by that satellite instead. */
function buildContainmentNodes(index: GraphIndex, graph: ModuleGraph, keptNodeIds: Set<string>, claimed: ReadonlySet<string>, context: NodeContext): MinimalSubgraphNode[] {
  const nodes: MinimalSubgraphNode[] = [];
  for (const id of keptNodeIds) {
    const node = index.nodesById.get(id);
    if (!node || claimed.has(id) || context.collapse.absorbed.has(id)) {
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

/** Every tiered card is a MEMBER now (the ghost ring is the separate satellite projection); origin
 * only splits seed from persistent. A demoted origin simply leaves the drawn set — it returns as a
 * satellite iff a remaining member still couples to its code, the Map-consistent read. */
function tierOf(id: string, context: NodeContext): MinimalTier {
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

/** A selected GROUP as ONE leaf package card (flat, tiered) — never decomposed into files. */
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

/** Import wires between two member boxes: file-level edges lifted so each endpoint rises to its
 * nearest member ancestor-or-self (folding a group member's files onto its card). Folded to one per
 * ordered box pair, self-loops dropped. `crossPackage` colours a boundary-crossing wire gold. */
function importEdges(index: GraphIndex, graph: ModuleGraph, memberIds: ReadonlySet<string>): MinimalSubgraphEdge[] {
  const boxOf = (id: string) => nearestInSet(index, id, memberIds);
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

/** Per-kind dependency wires between member files — the SAME lift the Map draws (calls /
 * instantiates / extends / implements / references), so the overlay reads like the Map at the same
 * level. Every member box counts as a "code" endpoint here: with only member boxes drawn, box↔box
 * coupling IS this level's dep story. An off-overlay endpoint lifts to nothing and drops here (the
 * ghost projection charts it instead); an intra-box coupling folds to a self-loop and drops (both
 * inside `liftEdges`). */
function depEdges(index: GraphIndex, memberIds: ReadonlySet<string>, code: CodeContext): MinimalSubgraphEdge[] {
  return depWireEdges(code.blockDeps, memberIds, index, (id) => memberIds.has(id), new Set()).map((edge) => ({
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
