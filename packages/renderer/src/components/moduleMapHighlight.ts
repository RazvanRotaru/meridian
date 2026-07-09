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
import { arrowMarker, CALLER_WIRE, IPC_WIRE } from "../theme/edgeColors";
import { IMPORT_CROSS, IMPORT_SIBLING, relColor } from "../theme/mapPalette";

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
const BASE_WIDTH = 1.5;
const EMPHASIS_WIDTH = 2.5;

export type HighlightMode = "reach" | "node";

export interface EmphasizedLevel {
  nodes: Node[];
  edges: Edge[];
  /** Definition nodes a selected call step points at; `applyBeacons` rings them in place. */
  beacons: Set<string>;
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
export function emphasize(nodes: Node[], edges: Edge[], activeIds: ReadonlySet<string>, radius: number, mode: HighlightMode): EmphasizedLevel {
  const typeById = new Map(nodes.map((node) => [node.id, node.type]));
  const active = [...activeIds].filter((id) => typeById.has(id));
  if (active.length === 0) {
    return pruneUnlitDeps({ nodes, edges: edges.map((edge) => styleEdge(edge, "none")), beacons: new Set() });
  }
  if (mode === "node") {
    return pruneUnlitDeps(applyBeacons(emphasizeIncident(nodes, edges, active), active, typeById));
  }
  if (active.every((id) => CODE_TYPES.has(typeById.get(id) ?? ""))) {
    return pruneUnlitDeps(applyBeacons(emphasizeDirected(nodes, edges, active, radius), active, typeById));
  }
  const near = neighbourhood(edges, active, radius);
  const styledEdges = edges.map((edge) => styleEdge(edge, near.has(edge.source) && near.has(edge.target) ? "near" : "none"));
  const styledNodes = nodes.map((node) => (near.has(node.id) ? node : dimNode(node)));
  return pruneUnlitDeps(applyBeacons({ nodes: styledNodes, edges: styledEdges }, active, typeById));
}

/**
 * Dep wires are now the PRIMARY visual layer — always visible (dimmed at rest, lit on selection).
 * Visibility is controlled entirely by the relationship-toggle filter upstream (filterRelKinds).
 * Ghost nodes that lost ALL edges (because every connected edge was toggled off) still drop to
 * avoid orphan stubs cluttering the canvas.
 */
function pruneUnlitDeps(level: EmphasizedLevel): EmphasizedLevel {
  const kept = new Set<string>();
  for (const edge of level.edges) {
    kept.add(edge.source);
    kept.add(edge.target);
  }
  const nodes = level.nodes.filter((node) => node.type !== "ghost" || kept.has(node.id) || level.beacons.has(node.id));
  return { ...level, nodes, edges: level.edges };
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
  const styledNodes = nodes.map((node) => (litNodes.has(node.id) ? node : dimNode(node)));
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
  const near = new Set([...seed, ...down.nodes, ...up.nodes]);
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
  // by brightening + thickening (and dimming everything else); direction is the arrowhead's job. Dash
  // means exactly one thing: the far end is off this level (a ghost).
  const stroke = baseStroke(edge);
  // Dashed = crosses a package boundary; solid = stays within the same package.
  const dash = isCrossFrame(edge) ? { strokeDasharray: "5 4" } : {};
  return { ...edge, animated: false, style: { stroke, strokeWidth: lit ? EMPHASIS_WIDTH : BASE_WIDTH, opacity: lit ? 1 : dimOpacity(edge), ...dash }, markerEnd: arrowMarker(stroke, 14) };
}

// Colour tells the relationship TYPE, at rest AND when selected: IPC magenta, each code-dependency
// kind its own hue (calls / instantiates / extends / implements / references), a boundary-crossing
// import gold, everything else a quiet grey.
function baseStroke(edge: Edge): string {
  if (isIpc(edge)) return IPC_WIRE;
  const rel = relColor(depKindOf(edge));
  if (rel) return rel;
  return isCrossFrame(edge) ? CROSS_FRAME_COLOR : REST_COLOR;
}

const dimOpacity = (edge: Edge): number =>
  isIpc(edge) ? DIM_IPC_OPACITY : isFlow(edge) ? DIM_FLOW_OPACITY : isDep(edge) ? DIM_DEP_OPACITY : DIM_EDGE_OPACITY;
const isCrossFrame = (edge: Edge): boolean => (edge.data as { crossFrame?: boolean } | undefined)?.crossFrame === true;
const isDep = (edge: Edge): boolean => (edge.data as { category?: string } | undefined)?.category === "dep";
const isFlow = (edge: Edge): boolean => (edge.data as { category?: string } | undefined)?.category === "flow";
const isIpc = (edge: Edge): boolean => (edge.data as { category?: string } | undefined)?.category === "ipc";
const depKindOf = (edge: Edge): string | undefined => (edge.data as { depKind?: string } | undefined)?.depKind;
const dimNode = (node: Node): Node => ({ ...node, style: { ...node.style, opacity: DIM_NODE_OPACITY } });
