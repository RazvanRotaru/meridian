/**
 * Selection-emphasis paint pass shared by the Map and Service tabs. It runs after layout and
 * filtering, so it only changes opacity, stroke colour, animation, and beacons — never positions.
 *
 * The reader can choose between the original reach mode (radius-driven N-hop context) and node mode
 * (only the selected node's own caller/callee wires). The toggle exists because full subgraph reach
 * is useful for exploration, but noisy when the user only wants to inspect one node's immediate
 * inbound and outbound relationships.
 */

import { type Edge, type Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import { arrowMarker, CALLER_WIRE } from "../theme/edgeColors";
import { IMPORT_CROSS, IMPORT_SIBLING } from "../theme/mapPalette";
import { groupLitGhosts } from "../derive/groupGhosts";
import { repositionLitGhosts } from "./ghostReposition";
import { withBoundaryDash } from "../layout/edgeBoundary";
import { relationKindOf } from "../graph/relationEdge";
import { relationColor, withRelationLineStyle } from "../theme/relationTheme";
import { isInteractiveSemanticEdge } from "./canvas/presentationEdges";

// Wire colour = relationship TYPE (see baseStroke), the same whether or not it is selected.
const CROSS_FRAME_COLOR = IMPORT_CROSS;
const REST_COLOR = IMPORT_SIBLING;
// The one green left: the beacon RING around a selected call step's definition (a node halo, not a
// wire colour) — see applyBeacons/beaconNode.
const SELECT_ACCENT = CALLER_WIRE;
// Import wires are the backdrop: kept legible at rest (0.4) so a level's coupling shows before the
// reader points at anything — a lit wire (opacity 1) still clearly wins.
const DIM_EDGE_OPACITY = 0.4;
const DIM_DEP_OPACITY = 0.4;
const DIM_FLOW_OPACITY = 0.55;
// IPC stays clearly readable even unselected — crossing the process boundary is a signal worth seeing.
const DIM_IPC_OPACITY = 0.55;
const DIM_NODE_OPACITY = 0.28;
// Wire WIDTH encodes the relationship's WEIGHT (aggregated call sites), log-clamped so a hot path
// pre-attentively pops at any zoom while a 1-call wire stays hairline — the same read the call
// surface's BlueprintEdge gives. Emphasis adds a constant thickening on top, never replaces it.
const BASE_WIDTH = 1.1;
const MAX_BASE_WIDTH = 4;
const WIDTH_PER_LOG_WEIGHT = 0.55;
const EMPHASIS_EXTRA = 1;

export type HighlightMode = "reach" | "node";
/** A surface-only mode used by PR logic-flow review. It is deliberately not persisted as the Map's
 * user preference: it highlights the induced set of flow nodes until one node is inspected. */
export type SurfaceEmphasisMode = HighlightMode | "subgraph";

export interface EmphasizedLevel {
  nodes: Node[];
  edges: Edge[];
  /** Definition nodes a selected call step points at; `applyBeacons` rings them in place. */
  beacons: Set<string>;
}

export interface GhostPresentationOptions {
  index: GraphIndex;
  groupByParent: boolean;
  expandedGroupIds: ReadonlySet<string>;
}

const CODE_TYPES: ReadonlySet<string> = new Set(["unit", "block", "step", "ghost"]);

/**
 * Anti-clutter emphasis: EVERY wire is dim by default, so a level reads as its cards until the
 * reader points at one. Plain click selects one node; ctrl/cmd+click accumulates several.
 *
 * `mode === "reach"` preserves the original behaviour: FILE/PACKAGE selections light their import
 * neighbourhood within `radius` undirected hops, while an all-CODE selection uses a DIRECTED read
 * over dependency/flow wires — what this code REACHES within `radius` hops lights violet and marches
 * forward; what CALLS it lights green and marches toward it. The radius dial is the callers/callees
 * depth for code selections.
 *
 * `mode === "node"` deliberately ignores `radius`: it lights only the selection seed's incident
 * wires across all categories. Outbound/callee edges are violet; inbound/caller edges are green;
 * both-in-seed edges count as outbound.
 */
export function emphasize(
  nodes: Node[],
  edges: Edge[],
  activeIds: ReadonlySet<string>,
  radius: number,
  mode: SurfaceEmphasisMode,
  ghostPresentation?: GhostPresentationOptions,
  paintSeedIds: ReadonlySet<string> = activeIds,
  focusSeedIds: ReadonlySet<string> | null = null,
): EmphasizedLevel {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  // Selection identity and paint traversal deliberately differ for ghosts. The store retains the
  // literal exact/group ghost id for extraction and selection chrome, while a clicked ghost reuses
  // the provenance seed that exposed it. Endpoint inference below is only the disconnected-data
  // fallback; normal interaction therefore preserves the complete frontier and its placement.
  const active = emphasisSeeds(paintSeedIds, nodes, edges, ghostPresentation);
  // Protection must keep the reader's literal selection, not the expanded seed list. Protecting
  // every child would prevent those children from folding back into their selected parent anchor.
  const activeSet = new Set(activeIds);
  if (active.length === 0) {
    return focusRetainedSelection(
      pruneUnlitDeps({ nodes, edges: edges.map((edge) => styleEdge(edge, "none")), beacons: new Set() }, activeSet, paintSeedIds, ghostPresentation),
      focusSeedIds,
      radius,
      mode,
    );
  }
  if (mode === "subgraph") {
    // Whole-flow mode intentionally carries ids that may be materialized only as incident ghosts;
    // preserve that complete semantic seed set instead of filtering it to the current node array.
    return focusRetainedSelection(
      pruneUnlitDeps(emphasizeInducedSubgraph(nodes, edges, new Set(paintSeedIds)), activeSet, paintSeedIds, ghostPresentation),
      focusSeedIds,
      radius,
      mode,
    );
  }
  if (mode === "node") {
    return focusRetainedSelection(
      pruneUnlitDeps(applyBeacons(emphasizeIncident(nodes, edges, active), active, typeById), activeSet, paintSeedIds, ghostPresentation),
      focusSeedIds,
      radius,
      mode,
    );
  }
  if (active.every((id) => CODE_TYPES.has(typeById.get(id) ?? ""))) {
    return focusRetainedSelection(
      pruneUnlitDeps(applyBeacons(emphasizeDirected(nodes, edges, active, radius), active, typeById), activeSet, paintSeedIds, ghostPresentation),
      focusSeedIds,
      radius,
      mode,
    );
  }
  // A selected container means all code currently drawn inside it. Seed reach from those descendants
  // just like node/directed mode does; otherwise an expanded file's outside-view wires (correctly
  // anchored at its visible unit/block) disappear when the reader selects the file frame itself.
  const seed = withDrawnDescendants(active, nodes);
  const near = neighbourhood(edges, [...seed], radius);
  const styledEdges = edges.map((edge) => styleEdge(edge, near.has(edge.source) && near.has(edge.target) ? "near" : "none"));
  const styledNodes = nodes.map((node) => (near.has(node.id) ? node : dimNode(node)));
  return focusRetainedSelection(
    pruneUnlitDeps(applyBeacons({ nodes: styledNodes, edges: styledEdges }, active, typeById), activeSet, paintSeedIds, ghostPresentation),
    focusSeedIds,
    radius,
    mode,
  );
}

/**
 * Resolve the ids that drive paint emphasis without changing literal selection identity.
 *
 * Ordinary real/synthetic nodes seed themselves. An exact ghost seeds every non-ghost endpoint of
 * its canonical ghost wire; a collapsed paint-time parent first reconstructs its represented exact
 * children, then resolves those children the same way. Falling back to the ghost itself keeps a
 * malformed or temporarily disconnected satellite selectable instead of silently clearing paint.
 */
export function emphasisSeeds(
  activeIds: ReadonlySet<string>,
  nodes: readonly Node[],
  edges: readonly Edge[],
  ghostPresentation?: GhostPresentationOptions,
): string[] {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const seeds = new Set<string>();
  let peersByGhost: ReadonlyMap<string, readonly string[]> | null = null;
  for (const id of selectionSeeds(activeIds, nodes, ghostPresentation)) {
    const type = typeById.get(id);
    if (type === undefined) continue;
    if (type !== "ghost") {
      seeds.add(id);
      continue;
    }
    // Resolve EACH ghost independently. Folding every selected ghost's endpoints into one common
    // ancestor turns a Ctrl-selection across two classes into their shared file/package and reveals
    // an unrelated, much broader frontier. A single ghost can still have several lifted wires into
    // one owner; its own LCA recovers that owner without merging separate provenance families.
    peersByGhost ??= nonGhostPeerIndex(nodes, edges);
    const ghostPeers = peersByGhost.get(id) ?? [];
    const common = deepestCommonDrawnAncestor(ghostPeers, nodes);
    if (common !== null) seeds.add(common);
    else if (ghostPeers.length > 0) ghostPeers.forEach((peerId) => seeds.add(peerId));
    else seeds.add(id);
  }
  return [...seeds];
}

function nonGhostPeerIndex(
  nodes: readonly Node[],
  edges: readonly Edge[],
): Map<string, string[]> {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const peers = new Map<string, Set<string>>();
  for (const edge of edges) {
    if ((edge.data as { presentationOnly?: unknown } | undefined)?.presentationOnly === true) continue;
    const sourceType = typeById.get(edge.source);
    const targetType = typeById.get(edge.target);
    if (sourceType === "ghost" && targetType !== undefined && targetType !== "ghost") {
      const values = peers.get(edge.source) ?? new Set<string>();
      values.add(edge.target);
      peers.set(edge.source, values);
    }
    if (targetType === "ghost" && sourceType !== undefined && sourceType !== "ghost") {
      const values = peers.get(edge.target) ?? new Set<string>();
      values.add(edge.source);
      peers.set(edge.target, values);
    }
  }
  return new Map([...peers].map(([id, values]) => [id, [...values]]));
}

function deepestCommonDrawnAncestor(ids: readonly string[], nodes: readonly Node[]): string | null {
  if (ids.length === 0) return null;
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  const paths = ids.map((id) => drawnAncestorPath(id, parentById));
  if (paths.some((path) => path.length === 0)) return null;
  let common: string | null = null;
  const sharedLength = Math.min(...paths.map((path) => path.length));
  for (let index = 0; index < sharedLength; index += 1) {
    const candidate = paths[0][index];
    if (!paths.every((path) => path[index] === candidate)) break;
    common = candidate;
  }
  return common;
}

function drawnAncestorPath(id: string, parentById: ReadonlyMap<string, string | undefined>): string[] {
  if (!parentById.has(id)) return [];
  const reverse: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined && parentById.has(current) && !seen.has(current)) {
    reverse.push(current);
    seen.add(current);
    current = parentById.get(current);
  }
  return reverse.reverse();
}

/** Expand selected paint-time ghost parents to their canonical immediate children. All other ids
 * pass through unchanged and order is stable, so ordinary selections are bit-for-bit equivalent. */
export function selectionSeeds(
  activeIds: ReadonlySet<string>,
  nodes: readonly Node[],
  ghostPresentation?: GhostPresentationOptions,
): string[] {
  const seeds = new Set(activeIds);
  if (!ghostPresentation?.groupByParent) {
    return [...seeds];
  }
  const coreIds = new Set(nodes.filter((node) => node.type !== "ghost").map((node) => node.id));
  for (const node of nodes) {
    if (node.type === "ghost") {
      const parentId = ghostPresentation.index.parentOf.get(node.id);
      // A real core parent is already a canonical emphasis seed; only paint-time ghost parents
      // need reconstruction from their represented children.
      if (typeof parentId === "string" && !coreIds.has(parentId) && activeIds.has(parentId)) {
        seeds.add(node.id);
      }
    }
  }
  return [...seeds];
}

/**
 * Drawn↔drawn dep wires are the PRIMARY visual layer — always visible (dimmed at rest, lit on
 * selection), controlled by the relationship-toggle filter upstream. But OFF-LEVEL ghost wires (and
 * their ghost cards) are shown ONLY when LIT by the selection — otherwise the map would carry every
 * off-level dependency at once (a big level has hundreds). So a ghost appears only beside the node the
 * reader points at. Once lit, every related ghost survives; optional parent grouping is the
 * presentation control for a crowded sibling set.
 */
function pruneUnlitDeps(
  level: EmphasizedLevel,
  activeIds: ReadonlySet<string>,
  paintSeedIds: ReadonlySet<string>,
  ghostPresentation?: GhostPresentationOptions,
): EmphasizedLevel {
  // Keep a ghost wire when it is LIT, or when it beacons a selected step's definition (withheld at
  // opacity 0 so the definition rings through it) — else off-level ghosts drop until pointed at.
  const eligibleEdges = level.edges.filter((edge) =>
    !isGhostEdge(edge)
    || isLit(edge)
    || isGhostInspectionPath(edge)
    || level.beacons.has(edge.target)
    || level.beacons.has(edge.source));
  const kept = new Set<string>();
  for (const edge of eligibleEdges) {
    kept.add(edge.source);
    kept.add(edge.target);
  }
  const exactNodes = level.nodes.filter(
    (node) =>
      node.type !== "ghost"
      || kept.has(node.id)
      || isGhostInspectionPath(node)
      || level.beacons.has(node.id)
      || activeIds.has(node.id),
  );
  // A disclosed exact child is already independently addressable inside its expanded parent. Do
  // not remove it from that parent's grouping bucket merely because it is selected: doing so can
  // drop a four-child family below the grouping threshold, deleting the parent and three peers on
  // the next paint. Collapsed families still protect literal exact selections from being folded.
  const protectedGhostIds = new Set([...activeIds, ...level.beacons].filter((id) => {
    if (ghostPresentation === undefined) return true;
    const parentId = ghostPresentation.index.parentOf.get(id);
    return parentId == null || !ghostPresentation.expandedGroupIds.has(parentId);
  }));
  const provenanceByExactGhost = ghostPaintProvenance(exactNodes, eligibleEdges, paintSeedIds);
  const presented = ghostPresentation === undefined
    ? { nodes: exactNodes, edges: eligibleEdges }
    : groupLitGhosts(exactNodes, eligibleEdges, ghostPresentation.index, {
        enabled: ghostPresentation.groupByParent,
        expandedGroupIds: ghostPresentation.expandedGroupIds,
        protectedGhostIds,
      });
  const provenanceNodes = withGhostPaintProvenance(presented.nodes, provenanceByExactGhost);
  // Every surviving related ghost is placed SELECTION-RELATIVE beside the lit subgraph. Parent
  // grouping is presentation-only and runs just before this step, so its count matches the view.
  return { ...level, nodes: repositionLitGhosts(provenanceNodes, presented.edges), edges: presented.edges };
}

/** Assign each visible ghost only the paint owners that exposed THAT ghost. A global seed list on
 * every satellite makes two independently Ctrl-selected families collapse into one broad owner on
 * the next repaint. Group parents union the provenance of the exact children they represent. */
function ghostPaintProvenance(
  nodes: readonly Node[],
  edges: readonly Edge[],
  paintSeedIds: ReadonlySet<string>,
): Map<string, string[]> {
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  const peersByGhost = nonGhostPeerIndex(nodes, edges);
  const provenance = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.type !== "ghost") continue;
    const peers = peersByGhost.get(node.id) ?? [];
    if (peers.length === 0) continue;
    const relevant = [...paintSeedIds].filter((seedId) =>
      peers.some((peerId) => isDrawnAncestorOf(seedId, peerId, parentById)),
    );
    if (relevant.length > 0) {
      provenance.set(node.id, relevant);
      continue;
    }
    // Restored URLs and old sessions have no click-captured provenance. Infer a fallback per ghost,
    // never across the entire multi-selection, so unrelated owners remain independent.
    const common = deepestCommonDrawnAncestor(peers, nodes);
    provenance.set(node.id, common === null ? peers : [common]);
  }
  return provenance;
}

function isDrawnAncestorOf(
  ancestorId: string,
  id: string,
  parentById: ReadonlyMap<string, string | undefined>,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = parentById.get(current);
  }
  return false;
}

function withGhostPaintProvenance(
  nodes: readonly Node[],
  provenanceByExactGhost: ReadonlyMap<string, readonly string[]>,
): Node[] {
  let changed: Node[] | null = null;
  nodes.forEach((node, index) => {
    if (node.type !== "ghost") return;
    const data = node.data as { groupedGhostIds?: unknown };
    const representedIds = Array.isArray(data.groupedGhostIds)
      ? data.groupedGhostIds.filter((id): id is string => typeof id === "string")
      : [node.id];
    const seeds = new Set<string>();
    for (const id of representedIds) provenanceByExactGhost.get(id)?.forEach((seedId) => seeds.add(seedId));
    if (seeds.size === 0) return;
    changed ??= [...nodes];
    changed[index] = { ...node, data: { ...node.data, ghostPaintSeedIds: [...seeds] } };
  });
  return changed ?? [...nodes];
}

/** Repaint a retained ghost frontier from the literal selection without running disclosure again.
 * Provenance decides which satellites survive and where they sit; this second, paint-only pass
 * gives the clicked ghost the same incident-neighbour read as an ordinary node. */
function focusRetainedSelection(
  level: EmphasizedLevel,
  focusSeedIds: ReadonlySet<string> | null,
  radius: number,
  mode: SurfaceEmphasisMode,
): EmphasizedLevel {
  if (focusSeedIds === null || focusSeedIds.size === 0) return level;
  // The first pass has already written dim/bright opacity and may have beaconed the selected
  // ghost through its provenance step. Remove only that paint before applying literal adjacency;
  // geometry, grouping metadata and every retained node/edge stay intact.
  const nodes = level.nodes.map((node) => clearNodeEmphasis(node, level.beacons.has(node.id)));
  const semanticEdges = level.edges.filter(isInteractiveSemanticEdge);
  const active = visibleFocusSeeds(focusSeedIds, nodes, semanticEdges);
  if (active.length === 0) return level;
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  let focused: { nodes: Node[]; edges: Edge[] };
  if (mode === "reach" && active.every((id) => CODE_TYPES.has(typeById.get(id) ?? ""))) {
    focused = emphasizeDirected(nodes, semanticEdges, active, radius);
  } else if (mode === "reach") {
    const seed = withDrawnDescendants(active, nodes);
    const near = neighbourhood(semanticEdges, [...seed], radius);
    const visibleNear = withDrawnAncestors(near, nodes);
    focused = {
      nodes: nodes.map((node) => (visibleNear.has(node.id) ? node : dimNode(node))),
      edges: semanticEdges.map((edge) => styleEdge(
        edge,
        near.has(edge.source) && near.has(edge.target) ? "near" : "none",
      )),
    };
  } else {
    focused = emphasizeIncident(nodes, semanticEdges, active);
  }
  const beaconed = applyBeacons(focused, active, typeById);
  const focusedById = new Map(beaconed.edges.map((edge) => [edge.id, edge]));
  return {
    nodes: beaconed.nodes,
    edges: level.edges.map((edge) => focusedById.get(edge.id) ?? edge),
    beacons: beaconed.beacons,
  };
}

/** Resolve exact/grouped literal ids onto the ghost cards that survived presentation. Expanded
 * exact children keep their own card but share semantic evidence through the persistent parent, so
 * matching aggregate metadata adds that parent as a focus alias without traversing hierarchy spokes. */
function visibleFocusSeeds(
  focusSeedIds: ReadonlySet<string>,
  nodes: readonly Node[],
  edges: readonly Edge[],
): string[] {
  const visible = new Set<string>();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const groupedIds = (node.data as { groupedGhostIds?: unknown }).groupedGhostIds;
    if (
      focusSeedIds.has(node.id)
      || (node.type === "ghost"
        && Array.isArray(groupedIds)
        && groupedIds.some((id) => typeof id === "string" && focusSeedIds.has(id)))
    ) {
      visible.add(node.id);
    }
  }
  for (const edge of edges) {
    const groupedIds = (edge.data as { groupedGhostIds?: unknown }).groupedGhostIds;
    if (
      !Array.isArray(groupedIds)
      || !groupedIds.some((id) => typeof id === "string" && focusSeedIds.has(id))
    ) continue;
    if (nodeById.get(edge.source)?.type === "ghost") visible.add(edge.source);
    if (nodeById.get(edge.target)?.type === "ghost") visible.add(edge.target);
  }
  return [...visible];
}

function clearNodeEmphasis(node: Node, wasBeacon: boolean): Node {
  const beacon = wasBeacon || (node.data as { beacon?: unknown }).beacon === true;
  const paintedOpacity = node.style?.opacity !== undefined;
  if (!beacon && !paintedOpacity) return node;
  const style = { ...node.style };
  delete style.opacity;
  let data = node.data;
  if (beacon) {
    delete style.borderRadius;
    delete style.boxShadow;
    data = { ...node.data };
    delete (data as { beacon?: unknown }).beacon;
  }
  return { ...node, data, style };
}

const isGhostEdge = (edge: Edge): boolean => (edge.data as { ghost?: boolean } | undefined)?.ghost === true;
const isLit = (edge: Edge): boolean => (edge.style as { opacity?: number } | undefined)?.opacity === 1;
const isGhostInspectionPath = (value: Node | Edge): boolean =>
  (value.data as { ghostInspectionPath?: unknown } | undefined)?.ghostInspectionPath === true;

/** Whole-flow emphasis is an induced-subgraph read: every resolved flow node and its rendered
 * containment ancestors remain opaque, and only relationships joining two flow nodes light up.
 * Incident edges leaving the flow stay dim, so the ghost-pruning pass below withholds that broader
 * neighbourhood until the reader explicitly selects one flow node. */
function emphasizeInducedSubgraph(nodes: Node[], edges: Edge[], active: ReadonlySet<string>): EmphasizedLevel {
  const kept = withDrawnAncestors(active, nodes);
  return {
    nodes: nodes.map((node) => (kept.has(node.id) ? node : dimNode(node))),
    edges: edges.map((edge) => styleEdge(edge, active.has(edge.source) && active.has(edge.target) ? "downstream" : "none")),
    beacons: new Set(),
  };
}

function withDrawnAncestors(active: ReadonlySet<string>, nodes: readonly Node[]): Set<string> {
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  const kept = new Set<string>();
  for (const id of active) {
    if (!parentById.has(id)) {
      continue;
    }
    let current: string | undefined = id;
    while (current !== undefined) {
      if (kept.has(current)) {
        break;
      }
      kept.add(current);
      current = parentById.get(current);
    }
  }
  return kept;
}

function emphasizeIncident(nodes: Node[], edges: Edge[], activeIds: readonly string[]): { nodes: Node[]; edges: Edge[] } {
  const seed = withDrawnDescendants(activeIds, nodes);
  const litNodes = new Set(seed);
  const styledEdges = edges.map((edge) => {
    const emphasis = seed.has(edge.source) ? "downstream" : seed.has(edge.target) ? "upstream" : "none";
    if (emphasis !== "none") {
      litNodes.add(edge.source);
      litNodes.add(edge.target);
    }
    return styleEdge(edge, emphasis);
  });
  // A nested step is the semantic endpoint, but its visible block/unit/file frames must stay opaque
  // too; otherwise parent opacity attenuates the highlighted child subtree in React Flow.
  const visibleLitNodes = withDrawnAncestors(litNodes, nodes);
  const styledNodes = nodes.map((node) => (visibleLitNodes.has(node.id) ? node : dimNode(node)));
  return { nodes: styledNodes, edges: styledEdges };
}

/** A selected call STEP beacons its definition instead of drawing a long straight wire across view. */
function applyBeacons(level: { nodes: Node[]; edges: Edge[] }, active: readonly string[], typeById: ReadonlyMap<string, string | undefined>): EmphasizedLevel {
  const selectedSteps = new Set(active.filter((id) => typeById.get(id) === "step"));
  if (selectedSteps.size === 0) {
    return { ...level, beacons: new Set() };
  }
  const beacons = new Set<string>();
  const edges = level.edges.map((edge) => {
    if (isDep(edge) && selectedSteps.has(edge.source)) {
      beacons.add(edge.target);
      return { ...edge, animated: false, style: { ...edge.style, opacity: 0 } };
    }
    return edge;
  });
  const nodes = beacons.size === 0 ? level.nodes : level.nodes.map((node) => (beacons.has(node.id) ? beaconNode(node) : node));
  return { nodes, edges, beacons };
}

function beaconNode(node: Node): Node {
  const data = node.type === "ghost" ? { ...node.data, beacon: true } : node.data;
  return { ...node, data, style: { ...node.style, opacity: 1, borderRadius: 8, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` } };
}

function emphasizeDirected(nodes: Node[], edges: Edge[], activeIds: readonly string[], radius: number): { nodes: Node[]; edges: Edge[] } {
  const seed = withDrawnDescendants(activeIds, nodes);
  const codeEdges = edges.filter((edge) => isDep(edge) || isFlow(edge));
  const down = directedReach(codeEdges, seed, radius, "forward");
  const up = directedReach(codeEdges, seed, radius, "reverse");
  const near = withDrawnAncestors(new Set([...seed, ...down.nodes, ...up.nodes]), nodes);
  const styledEdges = edges.map((edge) => (down.edges.has(edge.id) ? styleEdge(edge, "downstream") : up.edges.has(edge.id) ? styleEdge(edge, "upstream") : styleEdge(edge, "none")));
  const styledNodes = nodes.map((node) => (near.has(node.id) ? node : dimNode(node)));
  return { nodes: styledNodes, edges: styledEdges };
}

/** Selecting an expanded frame means "this code": every drawn descendant seeds the read. */
function withDrawnDescendants(activeIds: readonly string[], nodes: Node[]): Set<string> {
  const seed = new Set<string>(activeIds);
  for (const node of nodes) {
    if (node.parentId && seed.has(node.parentId)) {
      seed.add(node.id);
    }
  }
  return seed;
}

function directedReach(edges: Edge[], seed: ReadonlySet<string>, radius: number, direction: "forward" | "reverse"): { nodes: Set<string>; edges: Set<string> } {
  const reachedNodes = new Set<string>(seed);
  const reachedEdges = new Set<string>();
  let frontier = new Set<string>(seed);
  for (let hop = 0; hop < Math.max(1, radius) && frontier.size > 0; hop += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      const from = direction === "forward" ? edge.source : edge.target;
      const to = direction === "forward" ? edge.target : edge.source;
      if (frontier.has(from)) {
        reachedEdges.add(edge.id);
        if (!reachedNodes.has(to)) {
          reachedNodes.add(to);
          next.add(to);
        }
      }
    }
    frontier = next;
  }
  return { nodes: reachedNodes, edges: reachedEdges };
}

function neighbourhood(edges: Edge[], activeIds: readonly string[], radius: number): Set<string> {
  const reached = new Set<string>(activeIds);
  let frontier = [...activeIds];
  for (let hop = 0; hop < Math.max(1, radius) && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const edge of edges) {
      pushNeighbour(edge.source, edge.target, frontier, reached, next);
      pushNeighbour(edge.target, edge.source, frontier, reached, next);
    }
    frontier = next;
  }
  return reached;
}

function pushNeighbour(from: string, to: string, frontier: string[], reached: Set<string>, next: string[]): void {
  if (frontier.includes(from) && !reached.has(to)) {
    reached.add(to);
    next.push(to);
  }
}

type EdgeEmphasis = "near" | "downstream" | "upstream" | "none";

function styleEdge(edge: Edge, emphasis: EdgeEmphasis): Edge {
  const lit = emphasis !== "none";
  // A wire ALWAYS keeps its relationship colour — selection never recolours it. Being selected reads
  // by brightening + thickening (and dimming everything else); direction is the arrowhead's job.
  // Dash is independent of `crossFrame`: it means the wire leaves this view or its npm package.
  const stroke = baseStroke(edge);
  const width = weightWidth(edge);
  const style = withRelationLineStyle(
    withBoundaryDash(
      { stroke, strokeWidth: lit ? width + EMPHASIS_EXTRA : width, opacity: lit ? 1 : dimOpacity(edge) },
      edge.data,
    ),
    edge.data,
  );
  return { ...edge, animated: false, style, markerEnd: arrowMarker(stroke, 14) };
}

/** Log-clamped weight→width: w=1 → 1.1px, w=4 → 2.2px, w=16 → 3.3px, w≥64 → 4px cap. */
function weightWidth(edge: Edge): number {
  const weight = (edge.data as { weight?: number } | undefined)?.weight ?? 1;
  return Math.min(MAX_BASE_WIDTH, BASE_WIDTH + WIDTH_PER_LOG_WEIGHT * Math.log2(Math.max(1, weight)));
}

// Colour tells the relationship TYPE, at rest AND when selected: IPC magenta, each code-dependency
// kind its own hue (calls / instantiates / extends / implements / references), an import touching a
// visible group card gold, everything else a quiet grey. Package/view boundary is encoded by dash.
function baseStroke(edge: Edge): string {
  const kind = relationKindOf(edge.data);
  // Imports retain their established geometry cue: gold at a visible group/frame boundary, muted
  // gold between peer files. The catalog owns their identity; crossFrame refines that one theme.
  if (kind === "imports") return isCrossFrame(edge) ? CROSS_FRAME_COLOR : REST_COLOR;
  const rel = relationColor(kind);
  if (rel) return rel;
  return isCrossFrame(edge) ? CROSS_FRAME_COLOR : REST_COLOR;
}

// A COMMONS wire (into a demoted dock hub) is invisible at rest — its story is the dependent's
// chip; the wire only draws when the selection lights it (commonsDemotion.ts).
const dimOpacity = (edge: Edge): number =>
  isCommons(edge) ? 0 : isIpc(edge) ? DIM_IPC_OPACITY : isFlow(edge) ? DIM_FLOW_OPACITY : isDep(edge) ? DIM_DEP_OPACITY : DIM_EDGE_OPACITY;
const isCommons = (edge: Edge): boolean => (edge.data as { commons?: boolean } | undefined)?.commons === true;
const isCrossFrame = (edge: Edge): boolean => (edge.data as { crossFrame?: boolean } | undefined)?.crossFrame === true;
const isDep = (edge: Edge): boolean => (edge.data as { category?: string } | undefined)?.category === "dep";
const isFlow = (edge: Edge): boolean => (edge.data as { category?: string } | undefined)?.category === "flow";
const isIpc = (edge: Edge): boolean => (edge.data as { category?: string } | undefined)?.category === "ipc";
const dimNode = (node: Node): Node => ({ ...node, style: { ...node.style, opacity: DIM_NODE_OPACITY } });
