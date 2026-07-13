/**
 * The minimal subgraph the overlay renders — the SELECTION EXTRACTED as a curated MEMBER set ringed
 * by the Map's OWN ghost satellites:
 *   - SEED       — an ORIGIN member (a card that was in the raw selection); kept verbatim, never
 *                  decomposed (a selected package stays ONE package card).
 *   - PERSISTENT — a member the reader PROMOTED from a ghost (added to the working set).
 *   - GHOST      — NOT a tier but the Map's ghost projection (`ghostDepWires`): every code coupling
 *                  that LEAVES the member set charts its off-overlay end as a detached symbol
 *                  satellite at its relation-aware semantic endpoint, wired per coupling kind.
 *                  The "+" on a satellite promotes its home file/folder; the ring recomputes from
 *                  the member set every build.
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
import type { ModuleGroupData } from "./moduleTree";
import type { BlockDeps } from "./blockDeps";
import { depWireEdges } from "./codeWalk";
import { ghostDepWires, withoutHidden, type GhostData, type GhostEmission } from "./ghostDeps";
import { crossesPackageBoundary, underlyingEdgesCrossPackage } from "./packageBoundary";
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
  data: ModuleCardData | ModulePackageData | ModuleGroupData | GhostData;
}

export interface MinimalSubgraphEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  /** "import"/"dep" wires both connect two drawn boxes; the paint colours each by kind. */
  kind: "import" | "dep";
  /** Presentational colour cue: the drawn boxes sit in different directory/package frames. This is
   * deliberately separate from npm-package ownership — a monorepo directory is not a package.json. */
  crossFrame: boolean;
  /** Semantic package boundary, computed from the ORIGINAL artifact endpoints before box lifting. */
  crossPackage: boolean;
  /** One real endpoint is outside this extracted member view and represented by a ghost satellite. */
  outsideView: boolean;
  /** dep edges only: the underlying coupling kind (calls / instantiates / …) the paint colours by. */
  depKind?: string;
  /** The far endpoint is a GHOST satellite — the layout bands it outside the member core. */
  ghost?: boolean;
  /** Concrete artifact edges retained through member-box aggregation for inspection and ownership. */
  underlyingEdgeIds?: string[];
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
  /** Group members whose ordinary Map chevron performs a surface-local disclosure. */
  expandableGroupIds?: ReadonlySet<string>;
  /** Exact visible callables under PR flow-node inspection. Their incident dependencies bypass the
   * ordinary member-file fold so wires remain attached to the selected block. */
  inspectionIds?: ReadonlySet<string>;
  /** Project every dependency over the full visible code frontier. Used by an extracted graph with
   * highways disabled so expanded declarations connect directly while collapsed files still fold. */
  directDependencies?: boolean;
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
  const context: NodeContext = {
    memberIds,
    originIds,
    collapse,
    fileCountByGroup,
    walks,
    expandableGroupIds: code.expandableGroupIds ?? EMPTY_IDS,
  };
  const emission = projectGhosts(index, memberIds, walks, code, hiddenIds);
  const inspection = inspectionDepEdges(index, memberIds, walks, code);
  const dependencies = mergeProjectedDepEdges([
    ...depEdges(index, memberIds, code, inspection.incidentEdgeIds),
    ...inspection.edges,
  ]);
  // A folder group-ghost can carry the id of a member's own (never-rendered) ancestor frame — the
  // ghost card wins the id so the spec stays one-node-per-id (frames are flattened away anyway).
  const ghostIds = new Set(emission.ghosts.keys());
  return {
    nodes: [
      ...buildContainmentNodes(index, graph, keptNodeIds, new Set([...groupLeaf, ...ghostIds]), context),
      ...buildLeafGroupNodes(index, [...groupLeaf], context),
      ...ghostNodes(emission),
    ],
    edges: [
      ...importEdges(index, graph, memberIds),
      ...dependencies,
      ...ghostEdges(emission),
    ],
    expansions: [...walks.values()].map((walk) => walk.expansion).filter((exp): exp is MinimalExpansion => exp !== null),
  };
}

/**
 * The ghost ring, by the Map's OWN projection: every blockDeps coupling (and resolved step call from
 * an expanded member's walk) whose far end lifts to NO member charts that end as a symbol satellite,
 * exactly like `moduleTree`'s ghost level. Collapsed members anchor their own outside couplings; an
 * expanded file contributes its drawn unit/block frontier so selecting a nested declaration reveals
 * that declaration's satellites instead of leaving every wire attached to the file frame. Package
 * members still lift descendant symbols onto their one member card. Hidden (test) ghosts drop before
 * materialization, while every remaining semantic endpoint survives; parent grouping is a separate
 * paint-time policy driven by the current selection.
 */
function projectGhosts(index: GraphIndex, memberIds: ReadonlySet<string>, walks: Map<string, FileCodeWalk>, code: CodeContext, hiddenIds: ReadonlySet<string>): GhostEmission {
  const { calls, expandedBlocks, visibleIds, codeIds } = minimalVisibility(memberIds, walks);
  const raw = ghostDepWires(code.blockDeps, calls, visibleIds, index, (id) => codeIds.has(id), expandedBlocks);
  return withoutHidden(raw, hiddenIds, index);
}

interface MinimalVisibility {
  calls: FileCodeWalk["calls"];
  expandedBlocks: Set<string>;
  visibleIds: Set<string>;
  codeIds: Set<string>;
}

/** The exact frontier shared by ordinary ghost projection and selected-node edge inspection. */
function minimalVisibility(memberIds: ReadonlySet<string>, walks: Map<string, FileCodeWalk>): MinimalVisibility {
  const calls = [...walks.values()].flatMap((walk) => [...walk.calls]);
  const expandedBlocks = new Set([...walks.values()].flatMap((walk) => [...walk.expandedBlocks]));
  const visibleIds = new Set(memberIds);
  const codeIds = new Set(memberIds);
  for (const walk of walks.values()) {
    for (const node of walk.expansion?.nodes ?? []) {
      visibleIds.add(node.id);
      if (node.kind === "unit" || node.kind === "block" || node.kind === "step") {
        codeIds.add(node.id);
      }
    }
  }
  return { calls, expandedBlocks, visibleIds, codeIds };
}

/** Preserve exact edges touching a selected callable, or every visible exact edge in direct mode.
 * Normal minimal-graph dependencies fold through member files; this projection uses the full
 * expanded frontier. Off-view endpoints remain the ghost projection's job. Raw edges already drawn
 * inside a file expansion are withheld here to avoid duplicate React Flow edge ids. */
function inspectionDepEdges(
  index: GraphIndex,
  memberIds: ReadonlySet<string>,
  walks: Map<string, FileCodeWalk>,
  code: CodeContext,
): { edges: MinimalSubgraphEdge[]; incidentEdgeIds: Set<string> } {
  const direct = code.directDependencies === true;
  if (!direct && (!code.inspectionIds || code.inspectionIds.size === 0)) {
    return { edges: [], incidentEdgeIds: new Set() };
  }
  const visibility = minimalVisibility(memberIds, walks);
  const active = new Set([...(code.inspectionIds ?? [])].filter((id) => visibility.visibleIds.has(id)));
  if (!direct && active.size === 0) {
    return { edges: [], incidentEdgeIds: new Set() };
  }
  const incident = direct
    ? code.blockDeps.edges
    : code.blockDeps.edges.filter((edge) => active.has(edge.source) || active.has(edge.target));
  const incidentEdgeIds = new Set(incident.map((edge) => edge.id));
  const representedInsideExpansion = new Set(
    [...walks.values()].flatMap((walk) =>
      (walk.expansion?.edges ?? []).flatMap((edge) => edge.underlyingEdgeIds ?? []),
    ),
  );
  const projected = depWireEdges(
    { edges: incident.filter((edge) => !representedInsideExpansion.has(edge.id)) },
    visibility.visibleIds,
    index,
    (id) => visibility.codeIds.has(id),
    visibility.expandedBlocks,
  );
  return { edges: projected.map(toMinimalDepEdge), incidentEdgeIds };
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
      crossFrame: false,
      // Ghost projection already classified the original edge (including step calls, whose synthetic
      // wire has no underlying artifact id but whose owning block still gives package ownership).
      crossPackage: wire.crossPackage,
      outsideView: true,
      depKind: wire.kind,
      ghost: true,
      underlyingEdgeIds: [...wire.underlyingEdgeIds],
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
  expandableGroupIds: ReadonlySet<string>;
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
      data: {
        label: node.displayName,
        fileCount: subtreeFileCount(index, node.id),
        changedInside: index.changedDescendants.get(node.id) ?? 0,
        ca: 0,
        ce: 0,
        isContainer: context.expandableGroupIds.has(node.id),
        isExpanded: false,
      },
    }));
}

/** Import wires between two member boxes: file-level edges lifted so each endpoint rises to its
 * nearest member ancestor-or-self (folding a group member's files onto its card). Folded to one per
 * ordered box pair, self-loops dropped. `crossFrame` preserves the existing directory-boundary
 * colour cue; `crossPackage` is independently derived from each original file pair. */
function importEdges(index: GraphIndex, graph: ModuleGraph, memberIds: ReadonlySet<string>): MinimalSubgraphEdge[] {
  const boxOf = (id: string) => nearestInSet(index, id, memberIds);
  const aggregates = new Map<string, {
    source: string;
    target: string;
    weight: number;
    crossFrame: boolean;
    crossPackage: boolean;
    underlyingEdgeIds: string[];
  }>();
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
      const graphKey = weightKey(source, target);
      const weight = graph.weight.get(graphKey) ?? 1;
      const underlyingEdgeIds = graph.edgeIds.get(graphKey) ?? [];
      // ModuleGraph endpoints are the original owning FILES, before either side lifts onto a selected
      // group member. Prefer the concrete artifact ids, with the file pair as a defensive fallback.
      const crossPackage = underlyingEdgeIds.length > 0
        ? underlyingEdgesCrossPackage(underlyingEdgeIds, index)
        : crossesPackageBoundary(source, target, index);
      const existing = aggregates.get(`${sourceBox}->${targetBox}`);
      if (existing) {
        existing.weight += weight;
        existing.crossPackage = existing.crossPackage || crossPackage;
        existing.underlyingEdgeIds.push(...underlyingEdgeIds);
      } else {
        aggregates.set(`${sourceBox}->${targetBox}`, {
          source: sourceBox,
          target: targetBox,
          weight,
          crossFrame: nearestPackageFrame(index, sourceBox) !== nearestPackageFrame(index, targetBox),
          crossPackage,
          underlyingEdgeIds: [...underlyingEdgeIds],
        });
      }
    }
  }
  return [...aggregates.values()]
    .sort((a, b) => (a.source === b.source ? a.target.localeCompare(b.target) : a.source.localeCompare(b.source)))
    .map(({ source, target, weight, crossFrame, crossPackage, underlyingEdgeIds }) => ({
      id: `min:${source}->${target}`,
      source,
      target,
      weight,
      kind: "import" as const,
      crossFrame,
      crossPackage,
      outsideView: false,
      underlyingEdgeIds,
    }));
}

/** Per-kind dependency wires between member files — the SAME lift the Map draws (calls /
 * instantiates / extends / implements / references), so the overlay reads like the Map at the same
 * level. Every member box counts as a "code" endpoint here: with only member boxes drawn, box↔box
 * coupling IS this level's dep story. An off-overlay endpoint lifts to nothing and drops here (the
 * ghost projection charts it instead); an intra-box coupling folds to a self-loop and drops (both
 * inside `liftEdges`). */
function depEdges(
  index: GraphIndex,
  memberIds: ReadonlySet<string>,
  code: CodeContext,
  excludedEdgeIds: ReadonlySet<string> = EMPTY_IDS,
): MinimalSubgraphEdge[] {
  const blockDeps = excludedEdgeIds.size === 0
    ? code.blockDeps
    : { edges: code.blockDeps.edges.filter((edge) => !excludedEdgeIds.has(edge.id)) };
  return depWireEdges(blockDeps, memberIds, index, (id) => memberIds.has(id), new Set()).map(toMinimalDepEdge);
}

function toMinimalDepEdge(edge: ReturnType<typeof depWireEdges>[number]): MinimalSubgraphEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    kind: "dep" as const,
    crossFrame: false,
    crossPackage: edge.crossPackage,
    outsideView: false,
    depKind: edge.depKind,
    underlyingEdgeIds: [...(edge.underlyingEdgeIds ?? [])],
  };
}

/** Ordinary member folding and exact inspection partition raw dependency edges, but those disjoint
 * inputs can still lift onto the same rendered endpoint pair. Coalesce that collision so React Flow
 * receives one stable id while retaining the complete weight and concrete-edge provenance. */
function mergeProjectedDepEdges(edges: readonly MinimalSubgraphEdge[]): MinimalSubgraphEdge[] {
  const merged = new Map<string, MinimalSubgraphEdge>();
  for (const edge of edges) {
    const prior = merged.get(edge.id);
    if (!prior) {
      merged.set(edge.id, edge);
      continue;
    }
    merged.set(edge.id, {
      ...prior,
      weight: prior.weight + edge.weight,
      crossFrame: prior.crossFrame || edge.crossFrame,
      crossPackage: prior.crossPackage || edge.crossPackage,
      outsideView: prior.outsideView || edge.outsideView,
      ghost: prior.ghost || edge.ghost || undefined,
      underlyingEdgeIds: [...new Set([...(prior.underlyingEdgeIds ?? []), ...(edge.underlyingEdgeIds ?? [])])],
    });
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The box's nearest package-kind ancestor-or-self. This is the legacy DRAWN-FRAME colour grouping,
 * not npm ownership; semantic package crossing comes from packageBoundary.ts above. */
function nearestPackageFrame(index: GraphIndex, id: string): string | null {
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
