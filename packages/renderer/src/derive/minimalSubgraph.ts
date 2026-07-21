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
import type { BlockData, ModuleCardData, UnitCardData } from "./moduleLevel";
import type { ModulePackageData } from "./packageOverview";
import type { ModuleGroupData } from "./moduleTree";
import { BLOCK_KINDS, UNIT_CARD_KINDS, constructionTarget, type BlockDeps } from "./blockDeps";
import type { StepData } from "./flowSteps";
import { depWireEdges, stepCallEdges } from "./codeWalk";
import { ghostDepWires, withoutHidden, type GhostData, type GhostEmission } from "./ghostDeps";
import { buildIpcEdges } from "./moduleIpc";
import { crossesPackageBoundary, underlyingEdgesCrossPackage } from "./packageBoundary";
import {
  walkCodeRoot,
  walkFileCode,
  walkFlowStepRoot,
  visibleFlowChainEdges,
  type FileCodeWalk,
  type MinimalExpansion,
} from "./minimalExpansion";

const MODULE_KIND = "module";
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export type MinimalTier = "seed" | "persistent";

export interface MinimalSubgraphNode {
  id: string;
  kind: "group" | "file" | "unit" | "block" | "step" | "ghost";
  parentId: string | null;
  /** Member LEAF cards (a file, or a group member) carry their tier; frames and ghosts leave it null. */
  tier: MinimalTier | null;
  /** Joined path segments when this frame is a collapsed package chain. */
  collapsedLabel?: string;
  data: ModuleCardData | ModulePackageData | ModuleGroupData | UnitCardData | BlockData | StepData | GhostData;
}

export interface MinimalSubgraphEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  /** Every wire connects two drawn boxes; the paint colours each by its canonical Map kind. */
  kind: "import" | "dep" | "flow";
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
  /** Exact selected synthetic members and the artifact callable whose flow emitted each one. */
  syntheticMemberOwners?: ReadonlyMap<string, string>;
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
  /** Project every dependency over the full visible code frontier. Used as the extracted graph's
   * settled presentation substrate so expanded declarations connect directly in either highway mode. */
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
  // The ordinary Map collapses each sends→channel→handles pair into one sender→handler IPC edge.
  // Carry that same semantic edge into the extracted overlay as a local dependency substrate: when
  // both endpoints are members it becomes a direct wire, and when only one is present the other is
  // retained as a ghost. Keeping this local avoids double-emitting IPC in the ordinary Map, which
  // already adds its own `ipcTreeEdges` layer.
  const effectiveCode = withMinimalIpcEdges(index, code);
  const fileVisible = new Set([...memberIds].filter((id) => isModule(index, id)));
  const { keptNodeIds, fileCountByGroup } = closeOverAncestors(index, fileVisible);
  const collapse = collapseChains(index, keptNodeIds);
  const allWalks = walkVisibleMembers(index, graph, memberIds, effectiveCode);
  const walks = withoutEmbeddedMemberWalks(allWalks);
  // An exact member absorbed into another selected expansion is still code, even though it no
  // longer owns a second top-level walk. Keep it out of the group-card fallback.
  const codeLeaf = new Set([...allWalks.keys()].filter((id) => !fileVisible.has(id)));
  const groupLeaf = new Set([...memberIds].filter((id) => !fileVisible.has(id) && !codeLeaf.has(id)));
  const context: NodeContext = {
    memberIds,
    originIds,
    collapse,
    fileCountByGroup,
    walks,
    expandableGroupIds: effectiveCode.expandableGroupIds ?? EMPTY_IDS,
  };
  const emission = projectGhosts(index, memberIds, walks, effectiveCode, hiddenIds);
  const inspection = inspectionDepEdges(index, memberIds, walks, effectiveCode);
  const visibility = minimalVisibility(memberIds, walks);
  // Cross-expansion step calls are needed only when the extraction itself names an exact
  // declaration/step root. Ordinary file members retain their grouped file-level relationships.
  const exactRootCalls = uniqueStepCalls(
    [...allWalks.entries()]
      .filter(([id]) => !fileVisible.has(id))
      .flatMap(([, walk]) => [...walk.calls]),
  );
  const exactStepCallEdges = stepCallEdges(
    { calls: exactRootCalls },
    visibility.visibleIds,
    index,
  ).map(toMinimalDepEdge);
  const supersededCalls = new Set(
    exactRootCalls.map((call) => `${call.blockId}\u0000${call.target}`),
  );
  // Direct mode is the settled presentation substrate: it already projects every visible raw
  // dependency, so do not scan the full dependency set again merely to exclude every one of them.
  // Exact synthetic step calls are separate from that artifact substrate and remain additive.
  const projectedDependencies = effectiveCode.directDependencies === true
    ? inspection.edges
    : [
        ...depEdges(index, memberIds, effectiveCode, inspection.incidentEdgeIds, supersededCalls),
        ...inspection.edges,
      ];
  const dependencies = mergeProjectedDepEdges([
    ...projectedDependencies,
    // Per-expansion call edges cannot see a target owned by another selected root. Re-project exact
    // roots over the complete extracted frontier so step→definition relationships survive.
    ...exactStepCallEdges,
  ]);
  const flowEdges = visibleFlowChainEdges(
    visibility.visibleIds,
    index,
    effectiveCode.expanded,
    effectiveCode.flows,
  )
    .map(toMinimalFlowEdge);
  // A folder group-ghost can carry the id of a member's own (never-rendered) ancestor frame — the
  // ghost card wins the id so the spec stays one-node-per-id (frames are flattened away anyway).
  const ghostIds = new Set(emission.ghosts.keys());
  return {
    nodes: [
      ...buildContainmentNodes(index, graph, keptNodeIds, new Set([...groupLeaf, ...ghostIds]), context),
      ...buildLeafGroupNodes(index, [...groupLeaf], context),
      ...buildCodeLeafNodes(walks, fileVisible, context),
      ...ghostNodes(emission),
    ],
    edges: [
      ...importEdges(index, graph, memberIds),
      ...dependencies,
      ...flowEdges,
      ...ghostEdges(emission),
    ],
    expansions: [...walks.values()].map((walk) => walk.expansion).filter((exp): exp is MinimalExpansion => exp !== null),
    syntheticMemberOwners: new Map(
      [...allWalks.entries()].flatMap(([id, walk]) => {
        const owner = walk.expansion?.artifactOwnerId;
        return id.startsWith("step:") && owner !== undefined ? [[id, owner] as const] : [];
      }),
    ),
  };
}

/** Add the Map's collapsed RPC/IPC semantics only to this extracted-graph derivation. */
function withMinimalIpcEdges(index: GraphIndex, code: CodeContext): CodeContext {
  const existing = new Set(
    code.blockDeps.edges
      .filter((edge) => edge.kind === "ipc")
      .map((edge) => `${edge.source}\u0000${edge.target}`),
  );
  const ipcEdges = buildIpcEdges(index.edges)
    .filter((edge) => !existing.has(`${edge.source}\u0000${edge.target}`));
  if (ipcEdges.length === 0) {
    return code;
  }
  return {
    ...code,
    blockDeps: { edges: [...code.blockDeps.edges, ...ipcEdges] },
  };
}

function uniqueStepCalls(calls: FileCodeWalk["calls"]): FileCodeWalk["calls"] {
  const unique = new Map<string, FileCodeWalk["calls"][number]>();
  for (const call of calls) {
    unique.set(`${call.stepId}\u0000${call.blockId}\u0000${call.target}`, call);
  }
  return [...unique.values()];
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
): { edges: MinimalSubgraphEdge[]; incidentEdgeIds: ReadonlySet<string> } {
  const direct = code.directDependencies === true;
  if (!direct && (!code.inspectionIds || code.inspectionIds.size === 0)) {
    return { edges: [], incidentEdgeIds: new Set() };
  }
  const visibility = minimalVisibility(memberIds, walks);
  let incident = code.blockDeps.edges;
  if (!direct) {
    // Include visible ancestor frames without putting them on the dependency projection frontier.
    // One closure pass avoids an inspectionIds × visibleIds containment scan for large flows.
    const visibleContainmentIds = new Set<string>();
    for (const visibleId of visibility.visibleIds) {
      const seen = new Set<string>();
      let current: string | null | undefined = visibleId;
      while (current && !seen.has(current)) {
        seen.add(current);
        visibleContainmentIds.add(current);
        current = index.parentOf.get(current) ?? null;
      }
    }
    const active = new Set(
      [...(code.inspectionIds ?? [])].filter((id) => visibleContainmentIds.has(id)),
    );
    if (active.size === 0) {
      return { edges: [], incidentEdgeIds: new Set() };
    }
    // A selected visible container owns the raw endpoints below it (file functions, class methods,
    // nested flow blocks). Memoize one parent walk per endpoint because a busy callable commonly
    // appears on many raw edges; projection still chooses the exact currently-visible declaration.
    const endpointInspection = new Map<string, boolean>();
    const isInspectedEndpoint = (endpointId: string): boolean => {
      const cached = endpointInspection.get(endpointId);
      if (cached !== undefined) {
        return cached;
      }
      const seen = new Set<string>();
      let current: string | null | undefined = endpointId;
      while (current && !seen.has(current)) {
        if (active.has(current)) {
          endpointInspection.set(endpointId, true);
          return true;
        }
        seen.add(current);
        current = index.parentOf.get(current) ?? null;
      }
      endpointInspection.set(endpointId, false);
      return false;
    };
    incident = incident.filter((edge) => isInspectedEndpoint(edge.source) || isInspectedEndpoint(edge.target));
  }
  // Direct mode covers the complete substrate and its caller bypasses ordinary member folding.
  // Avoid retaining a second all-edge id set for large reviews.
  const incidentEdgeIds = direct ? EMPTY_IDS : new Set(incident.map((edge) => edge.id));
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

/** Walk every exact member once with the shared disclosure state. Files retain their normal flat /
 * expanded contract; declarations and visible `step:` pseudo-nodes always contribute an exact root
 * expansion so nested extraction cannot coerce them into package cards or drop them entirely. */
function walkVisibleMembers(index: GraphIndex, graph: ModuleGraph, memberIds: ReadonlySet<string>, code: CodeContext): Map<string, FileCodeWalk> {
  const walks = new Map<string, FileCodeWalk>();
  for (const id of memberIds) {
    const node = index.nodesById.get(id);
    if (node?.kind === MODULE_KIND) {
      walks.set(id, walkFileCode(id, index, graph, code.expanded, code.blockDeps, code.flows));
      continue;
    }
    const exact = node !== undefined && (UNIT_CARD_KINDS.has(node.kind) || BLOCK_KINDS.has(node.kind))
      ? walkCodeRoot(id, index, graph, code.expanded, code.blockDeps, code.flows)
      : node === undefined
        ? walkFlowStepRoot(id, index, graph, code.expanded, code.blockDeps, code.flows)
        : null;
    if (exact !== null) {
      walks.set(id, exact);
    }
  }
  return walks;
}

/** Give every rendered id exactly one expansion owner. When a selected ancestor's disclosed walk
 * already contains another selected root (file→callable, unit→method, outer step→nested step), the
 * ancestor owns that descendant and the redundant top-level walk is discarded. */
function withoutEmbeddedMemberWalks(allWalks: ReadonlyMap<string, FileCodeWalk>): Map<string, FileCodeWalk> {
  const roots = new Set(allWalks.keys());
  const embedded = new Set<string>();
  for (const [rootId, walk] of allWalks) {
    for (const node of walk.expansion?.nodes ?? []) {
      if (node.id !== rootId && roots.has(node.id)) {
        embedded.add(node.id);
      }
    }
  }
  return new Map([...allWalks].filter(([id]) => !embedded.has(id)));
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

/** Exact declaration/step members are represented by their canonical Map vocabulary. Their one-
 * root expansions own final sizing and rendering; this tiered node is the top-level placement card. */
function buildCodeLeafNodes(
  walks: ReadonlyMap<string, FileCodeWalk>,
  fileVisible: ReadonlySet<string>,
  context: NodeContext,
): MinimalSubgraphNode[] {
  return [...walks.entries()]
    .filter(([id]) => !fileVisible.has(id))
    .flatMap(([id, walk]) => {
      const root = walk.expansion?.nodes.find((node) => node.id === id);
      if (root === undefined || (root.kind !== "unit" && root.kind !== "block" && root.kind !== "step")) {
        return [];
      }
      return [{
        id,
        kind: root.kind,
        parentId: null,
        tier: tierOf(id, context),
        data: root.data,
      } satisfies MinimalSubgraphNode];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
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
  supersededCalls: ReadonlySet<string> = EMPTY_IDS,
): MinimalSubgraphEdge[] {
  const blockDeps = excludedEdgeIds.size === 0
    ? code.blockDeps
    : { edges: code.blockDeps.edges.filter((edge) => !excludedEdgeIds.has(edge.id)) };
  // Filter before lifting: once f→g folds to selected files m1→m2, the lifted source no longer tells
  // depWireEdges that f is expanded and already represented as a step→g call.
  const withoutExpandedCallers = supersededCalls.size === 0
    ? blockDeps
    : {
        edges: blockDeps.edges.filter((edge) =>
          edge.kind !== "calls"
          || !supersededCalls.has(`${edge.source}\u0000${constructionTarget(edge.target, index)}`),
        ),
      };
  return depWireEdges(withoutExpandedCallers, memberIds, index, (id) => memberIds.has(id), EMPTY_IDS).map(toMinimalDepEdge);
}

function toMinimalDepEdge(
  edge: ReturnType<typeof depWireEdges>[number] | ReturnType<typeof stepCallEdges>[number],
): MinimalSubgraphEdge {
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
    underlyingEdgeIds: "underlyingEdgeIds" in edge ? [...(edge.underlyingEdgeIds ?? [])] : [],
  };
}

function toMinimalFlowEdge(
  edge: ReturnType<typeof visibleFlowChainEdges>[number],
): MinimalSubgraphEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    kind: "flow",
    crossFrame: edge.crossFrame,
    crossPackage: edge.crossPackage,
    outsideView: edge.outsideView,
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
