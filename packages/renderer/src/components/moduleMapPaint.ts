/**
 * Paint-time transforms for the Module-map surface: HIDE file cards by category / test-status, and
 * EMPHASIZE the wires within N import hops of the active (selected) node. Both are pure over the
 * already laid-out React Flow arrays — positions are NEVER touched, so filtering or highlighting
 * reshuffles nothing. Kept out of the view component so the rules are small, named, and testable.
 * A group card is never category-hidden (only file cards are), so an expanded frame and its nested
 * children's parent chain always survive a repaint — React Flow never loses a referenced parent.
 */

import { type Edge, type Node } from "@xyflow/react";
import { arrowMarker } from "../theme/edgeColors";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { ModuleCategory } from "../derive/moduleCategory";

// A cross-frame import (a group is involved) is the coupling signal (warm gold); a same-level
// file↔file import is expected cohesion (a quiet grey that recedes). Unit-dependency wires are
// violet — a separate story from imports — and light in their own accent so selecting a unit
// highlights the edges to its service dependencies' DEFINITIONS distinctly.
const CROSS_FRAME_COLOR = "#C9A24B";
const INTERNAL_COLOR = "#5B6675";
const DEP_COLOR = "#7C6FBF";
const DEP_ACCENT = "#A78BFA";
const SELECT_ACCENT = "#6BE38A";
const DIM_EDGE_OPACITY = 0.12;
// Dependency wires stay faintly readable even unselected, so expanding a file immediately shows
// where its units' dependencies point.
const DIM_DEP_OPACITY = 0.3;
// Execution-order wires between an expanded block's flow steps: quiet, but always readable — they
// ARE the flow being showcased.
const FLOW_COLOR = "#7B8695";
const DIM_FLOW_OPACITY = 0.55;
const DIM_NODE_OPACITY = 0.28;
const BASE_WIDTH = 1.5;
const EMPHASIS_WIDTH = 2.5;

export interface HideOptions {
  hiddenCategories: ReadonlySet<ModuleCategory>;
  showTests: boolean;
  testIds: ReadonlySet<string>;
  showPrivate: boolean;
  privateIds: ReadonlySet<string>;
}

/**
 * Drop the file cards a filter hides (a category toggled off, or test code with tests hidden) and
 * the wires touching them — WITHOUT moving anything. Group cards are never category-hidden (a
 * directory has no single category), so the level's structure holds. Hiding closes over drawn
 * DESCENDANTS: an expanded file frame that hides takes its nested unit cards with it, so the
 * toggle's contract holds and React Flow never sees a child whose parent frame vanished.
 */
export function filterVisible(nodes: Node[], edges: Edge[], options: HideOptions): { nodes: Node[]; edges: Edge[] } {
  const hidden = hiddenCardIds(nodes, options);
  if (hidden.size === 0) {
    return { nodes, edges };
  }
  const keptNodes = nodes.filter((node) => !hidden.has(node.id));
  const keptEdges = edges.filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target));
  return { nodes: keptNodes, edges: keptEdges };
}

function hiddenCardIds(nodes: Node[], options: HideOptions): Set<string> {
  const hidden = new Set<string>();
  // Nodes arrive parents-before-children (a React Flow requirement), so one pass both applies the
  // filters and closes hiding over each hidden card's drawn subtree via parentId membership.
  for (const node of nodes) {
    if (node.parentId && hidden.has(node.parentId)) {
      hidden.add(node.id);
      continue;
    }
    if ((node.type === "file" || node.type === "unit" || node.type === "block" || node.type === "ghost") && isHidden(node, options)) {
      hidden.add(node.id);
    }
  }
  return hidden;
}

function isHidden(node: Node, options: HideOptions): boolean {
  if (!options.showTests && options.testIds.has(node.id)) {
    return true;
  }
  if (!options.showPrivate && options.privateIds.has(node.id)) {
    return true;
  }
  // Unit cards carry no category of their own; they hide with their file frame (subtree closure).
  return options.hiddenCategories.has((node.data as ModuleCardData).category);
}

/** The node types the DIRECTED read applies to — everything that is code, not containment. */
const CODE_TYPES: ReadonlySet<string> = new Set(["unit", "block", "step", "ghost"]);

/**
 * Anti-clutter emphasis: EVERY wire is dim by default, so a level reads as its cards until the
 * reader points at one. Plain click selects one node; ctrl/cmd+click accumulates several, and the
 * UNION of their reaches lights. FILE/PACKAGE selections light their import neighbourhood within
 * `radius` undirected hops. An all-CODE selection (units, blocks, flow steps, ghosts) switches to
 * a DIRECTED read over the dependency/flow wires — Sourcetrail-style: what this code REACHES within
 * `radius` hops lights violet and marches forward; what CALLS it lights green and marches toward
 * it. The radius dial is thus the callers/callees depth for code selections.
 */
export interface EmphasizedLevel {
  nodes: Node[];
  edges: Edge[];
  /** Definition nodes a SELECTED call step points at — ringed in place, guided to by an edge-of-
   * screen arrow instead of a drawn wire (see `applyBeacons`). */
  beacons: Set<string>;
}

export function emphasize(nodes: Node[], edges: Edge[], activeIds: ReadonlySet<string>, radius: number): EmphasizedLevel {
  // Selections no longer drawn (a frame collapsed, a card filtered away) drop out; none left must
  // read as "nothing selected" — otherwise every node dims with nothing highlighted.
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const active = [...activeIds].filter((id) => typeById.has(id));
  if (active.length === 0) {
    return { nodes, edges: edges.map((edge) => styleEdge(edge, "none")), beacons: new Set() };
  }
  if (active.every((id) => CODE_TYPES.has(typeById.get(id) ?? ""))) {
    return applyBeacons(emphasizeDirected(nodes, edges, active, radius), active, typeById);
  }
  const near = neighbourhood(edges, active, radius);
  const styledEdges = edges.map((edge) => styleEdge(edge, near.has(edge.source) && near.has(edge.target) ? "near" : "none"));
  const styledNodes = nodes.map((node) => (near.has(node.id) ? node : dimNode(node)));
  return applyBeacons({ nodes: styledNodes, edges: styledEdges }, active, typeById);
}

/**
 * The BEACON read for a selected call STEP: the wire to its definition is withheld (a straight
 * edge across the canvas says little), and the definition itself becomes the signal — ringed in
 * the selection colour wherever its nearest drawn representative is (the real block, the enclosing
 * frame it folded into, or its ghost card, whose border flips to the selection colour). The view
 * layers a screen-edge guide arrow on top when the beacon sits outside the viewport.
 */
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
  if (beacons.size === 0) {
    return { ...level, edges, beacons };
  }
  const nodes = level.nodes.map((node) => (beacons.has(node.id) ? beaconNode(node) : node));
  return { nodes, edges, beacons };
}

/** A ringed definition: full presence, selection-colour halo; a ghost also flips its border. */
function beaconNode(node: Node): Node {
  const data = node.type === "ghost" ? { ...node.data, beacon: true } : node.data;
  return {
    ...node,
    data,
    style: { ...node.style, opacity: 1, borderRadius: 8, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` },
  };
}

/** The directed read for a code selection: downstream (callees/dependencies) vs upstream (callers)
 * over the dep + flow wires, each to `radius` hops. Selecting an expanded FRAME means "this code" —
 * the walk seeds with every node drawn inside it, so its steps' wires light as the frame's own.
 * Import wires stay part of the backdrop. */
function emphasizeDirected(nodes: Node[], edges: Edge[], activeIds: readonly string[], radius: number): { nodes: Node[]; edges: Edge[] } {
  const seed = withDrawnDescendants(activeIds, nodes);
  const codeEdges = edges.filter((edge) => isDep(edge) || isFlow(edge));
  const down = directedReach(codeEdges, seed, radius, "forward");
  const up = directedReach(codeEdges, seed, radius, "reverse");
  const near = new Set([...seed, ...down.nodes, ...up.nodes]);
  const styledEdges = edges.map((edge) => {
    if (down.edges.has(edge.id)) {
      return styleEdge(edge, "downstream");
    }
    if (up.edges.has(edge.id)) {
      return styleEdge(edge, "upstream");
    }
    return styleEdge(edge, "none");
  });
  const styledNodes = nodes.map((node) => (near.has(node.id) ? node : dimNode(node)));
  return { nodes: styledNodes, edges: styledEdges };
}

/** The selection plus every node drawn inside it (nodes arrive parents-before-children). */
function withDrawnDescendants(activeIds: readonly string[], nodes: Node[]): Set<string> {
  const seed = new Set<string>(activeIds);
  for (const node of nodes) {
    if (node.parentId && seed.has(node.parentId)) {
      seed.add(node.id);
    }
  }
  return seed;
}

/** BFS over directed edges from the seed set, up to `radius` hops, returning reached nodes + edges. */
function directedReach(
  edges: Edge[],
  seed: ReadonlySet<string>,
  radius: number,
  direction: "forward" | "reverse",
): { nodes: Set<string>; edges: Set<string> } {
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

/** The active nodes plus every node within `radius` undirected import hops of ANY of them —
 * a multi-source BFS, so several selections light the union of their reaches. */
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

/** How a wire is lit: undirected neighbourhood ("near"), the directed reads, or backdrop ("none"). */
type EdgeEmphasis = "near" | "downstream" | "upstream" | "none";

function styleEdge(edge: Edge, emphasis: EdgeEmphasis): Edge {
  const lit = emphasis !== "none";
  const stroke = lit ? litStroke(edge, emphasis) : baseStroke(edge);
  // Directed reads MARCH (React Flow's animated dash) so the wire reads as travel, not just reach.
  const animated = emphasis === "downstream" || emphasis === "upstream";
  // A ghost wire stays dashed at rest — its far end is off-screen context, not a drawn coupling
  // (the animated march already dashes, so it takes over while lit).
  const dash = isGhost(edge) && !animated ? { strokeDasharray: "5 4" } : {};
  return {
    ...edge,
    animated,
    style: { stroke, strokeWidth: lit ? EMPHASIS_WIDTH : BASE_WIDTH, opacity: lit ? 1 : dimOpacity(edge), ...dash },
    markerEnd: arrowMarker(stroke, 14),
  };
}

function litStroke(edge: Edge, emphasis: EdgeEmphasis): string {
  if (emphasis === "downstream") {
    return DEP_ACCENT;
  }
  if (emphasis === "upstream") {
    return SELECT_ACCENT;
  }
  return isDep(edge) ? DEP_ACCENT : SELECT_ACCENT;
}

function baseStroke(edge: Edge): string {
  if (isFlow(edge)) {
    return FLOW_COLOR;
  }
  return isDep(edge) ? DEP_COLOR : isCrossFrame(edge) ? CROSS_FRAME_COLOR : INTERNAL_COLOR;
}

function dimOpacity(edge: Edge): number {
  if (isFlow(edge)) {
    return DIM_FLOW_OPACITY;
  }
  return isDep(edge) ? DIM_DEP_OPACITY : DIM_EDGE_OPACITY;
}

function isCrossFrame(edge: Edge): boolean {
  return (edge.data as { crossFrame?: boolean } | undefined)?.crossFrame === true;
}

function isDep(edge: Edge): boolean {
  return (edge.data as { category?: string } | undefined)?.category === "dep";
}

function isFlow(edge: Edge): boolean {
  return (edge.data as { category?: string } | undefined)?.category === "flow";
}

function isGhost(edge: Edge): boolean {
  return (edge.data as { ghost?: boolean } | undefined)?.ghost === true;
}

function dimNode(node: Node): Node {
  return { ...node, style: { ...node.style, opacity: DIM_NODE_OPACITY } };
}
