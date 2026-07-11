/**
 * The shared module surfaces' semantic-zoom stack. The current focused graph and every successive
 * real parent graph are laid out independently through the active SurfaceSpec's canonical tree
 * pipeline, then overlaid in flow space. Layer 0 is current detail, layer 1 its parent graph, and so
 * on until that surface's root (or the first level whose anchor is unavailable).
 *
 * Each outer layer is translated as one rigid body so its collapsed anchor is centred on the
 * preceding layer. LOD can therefore preview the real parent without moving the viewport, then
 * commit it as navigation by discarding inner layers while leaving all surviving geometry intact.
 */

import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import { collapseChain } from "./moduleLevel";
import { npmPackageIdOf } from "./packageBoundary";
import type { ModuleTree, ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";

const PACKAGE_KIND = "package";
const MODULE_KIND = "module";
const LAYER_EDGE_PREFIX = "semantic:layer:";

export const SEMANTIC_LAYER_CLASS = "semantic-layer";
export const SEMANTIC_PARENT_CLASS = "semantic-parent";
export const SEMANTIC_DETAIL_CLASS = "semantic-detail";
export const SEMANTIC_CONTEXT_CLASS = "semantic-context";
export const SEMANTIC_DETAIL_EDGE_CLASS = "semantic-detail-edge";
export const SEMANTIC_CONTEXT_EDGE_CLASS = "semantic-context-edge";

export type SemanticRole = "detail" | "anchor" | "context";

export interface SemanticOuterLevel {
  /** Raw focus used to derive the real outer graph; null is the active surface's root. */
  focus: string | null;
  /** The real node in that outer graph which replaces the preceding graph at parent LOD. */
  anchorId: string;
}

/** Public transition metadata consumed by the store and shared LOD. Depth starts at 1. The optional
 * context is surface-owned navigation state (for example, a localized Service scope) which the
 * generic stack carries without depending on that surface. */
export interface SemanticAncestorLevel<TContext = never> extends SemanticOuterLevel {
  depth: number;
  label: string;
  /** The chain-collapsed focus rendered by this already-prepared canonical graph. Kept alongside
   * the raw focus so a semantic handoff can become real navigation without deriving or laying the
   * parent level a second time. */
  effectiveFocus: string | null;
  context?: TContext;
}

export interface SemanticOuterTree<TContext = never> {
  level: SemanticAncestorLevel<TContext>;
  tree: ModuleTree;
}

export interface LaidModuleGraph {
  nodes: Node[];
  edges: Edge[];
}

/** One independently laid source graph. Depth 0 has no anchor; every outer layer does. */
export interface ModuleSemanticLayer {
  depth: number;
  focus: string | null;
  anchorId: string | null;
  label: string | null;
  tree: ModuleTree;
  nodeIds: ReadonlySet<string>;
}

export interface ModuleSemanticStack<TContext = never> {
  layers: ModuleSemanticLayer[];
  /** Only successfully prepared transitions, ordered nearest parent to farthest ancestor. */
  ancestors: SemanticAncestorLevel<TContext>[];
}

/** A stable selector for both CSS and edge transforms that reconstruct classes after aggregation. */
export function semanticLayerClass(depth: number): string {
  return `${SEMANTIC_LAYER_CLASS}-${depth}`;
}

/** Resolve the nearest real outer level while respecting chain-collapsed raw/effective focus. */
export function semanticOuterLevel(
  index: GraphIndex,
  rawFocus: string | null,
  effectiveFocus: string | null,
): SemanticOuterLevel | null {
  if (rawFocus === null || effectiveFocus === null) {
    return null;
  }

  const overviewAnchor = overviewAnchorOf(index, rawFocus);
  if (overviewAnchor === rawFocus) {
    return { focus: null, anchorId: rawFocus };
  }

  const seen = new Set<string>([rawFocus]);
  let candidate = index.parentOf.get(rawFocus) ?? null;
  while (candidate !== null && !seen.has(candidate)) {
    seen.add(candidate);
    const candidateNode = index.nodesById.get(candidate);
    if (candidateNode?.kind === PACKAGE_KIND || candidateNode?.kind === MODULE_KIND) {
      const outerEffective = candidateNode.kind === PACKAGE_KIND ? collapseChain(index, candidate) : candidate;
      if (outerEffective !== effectiveFocus) {
        return {
          focus: candidate,
          anchorId: childOnPath(index, outerEffective, effectiveFocus) ?? rawFocus,
        };
      }
    }
    candidate = index.parentOf.get(candidate) ?? null;
  }

  return overviewAnchor === null ? null : { focus: null, anchorId: overviewAnchor };
}

/**
 * Resolve the complete outward path without deriving any trees. `collapseChain` is the same rule
 * used by the Map tree, so each returned raw focus has the effective focus the next iteration needs.
 * Preparation later truncates this optimistic path if a canonical tree does not contain its anchor.
 */
export function semanticAncestorLevels(
  index: GraphIndex,
  rawFocus: string | null,
  effectiveFocus: string | null,
): SemanticAncestorLevel[] {
  const levels: SemanticAncestorLevel[] = [];
  const seen = new Set<string>();
  let raw = rawFocus;
  let effective = effectiveFocus;

  while (raw !== null && effective !== null) {
    const stateKey = `${raw}\u0000${effective}`;
    if (seen.has(stateKey)) {
      break;
    }
    seen.add(stateKey);

    const outer = semanticOuterLevel(index, raw, effective);
    if (outer === null) {
      break;
    }
    levels.push({
      ...outer,
      depth: levels.length + 1,
      label: index.nodesById.get(outer.anchorId)?.displayName ?? outer.anchorId,
      effectiveFocus: outer.focus === null ? null : collapseChain(index, outer.focus),
    });
    if (outer.focus === null) {
      break;
    }
    raw = outer.focus;
    effective = collapseChain(index, outer.focus);
  }

  return levels;
}

/**
 * Prepare independently layable canonical trees for every valid level. Off-level ghosts are kept
 * only in detail, matching the old two-layer behavior. Collision priority is applied across the
 * entire stack:
 *
 *   - a real node in an inner layer wins over a duplicate non-anchor in a new outer layer;
 *   - the new real outer anchor wins its identity over a duplicate inner node/ghost;
 *   - removing a colliding parent removes its descendants, so no RF child becomes orphaned.
 *
 * The stack is truncated at the first unusable ancestor because all farther alignment depends on
 * that missing transition. A depth-0-only result is valid and uses the ordinary single graph path.
 */
export function prepareSemanticModuleStack<TContext = never>(
  detailTree: ModuleTree,
  outerTrees: readonly SemanticOuterTree<TContext>[],
): ModuleSemanticStack<TContext> {
  // Some projections already draw their focused parent as an expanded wrapper (Service frames are
  // the canonical example). The outer graph needs that same id as its collapsed anchor. Unwrap the
  // focused wrapper from detail, keeping and promoting its descendants, so the compositor has one
  // stable anchor identity while the ordinary detail graph remains visible beneath it. This is a
  // generic shape normalization: any future surface with an expanded self-wrapper gets it for free.
  const normalizedDetail =
    outerTrees[0] === undefined
      ? detailTree
      : unwrapExpandedDetailAnchor(detailTree, outerTrees[0].level.anchorId);
  let layers: ModuleSemanticLayer[] = [sourceLayer(0, normalizedDetail.effectiveFocus, null, null, normalizedDetail, true)];
  const ancestors: SemanticAncestorLevel<TContext>[] = [];

  for (const { level, tree } of outerTrees) {
    if (level.depth !== layers.length) {
      break;
    }
    const realOuterNodes = tree.nodes.filter((node) => node.kind !== "ghost");
    if (!realOuterNodes.some((node) => node.id === level.anchorId)) {
      break;
    }

    const innerRealIds = new Set(
      layers.flatMap((layer) => layer.tree.nodes.filter((node) => node.kind !== "ghost").map((node) => node.id)),
    );
    // Existing real graph identities win over a duplicate outer peer. The incoming anchor is the
    // exception: it must remain the canonical card which replaces the preceding graph.
    const blockedOuterIds = new Set(
      realOuterNodes
        .filter((node) => node.id !== level.anchorId && innerRealIds.has(node.id))
        .map((node) => node.id),
    );
    const keptOuterNodes = filterNodeSubtrees(realOuterNodes, blockedOuterIds);
    if (!keptOuterNodes.some((node) => node.id === level.anchorId)) {
      break;
    }
    const keptOuterIds = new Set(keptOuterNodes.map((node) => node.id));

    // Real outer identities beat inner ghosts; the anchor also beats an accidentally pinned real
    // copy of itself. Resolve against every existing level, not only current detail.
    const nextInner = layers.map((layer) => {
      const blockedInnerIds = new Set(
        layer.tree.nodes
          .filter(
            (node) =>
              keptOuterIds.has(node.id) &&
              (node.kind === "ghost" || node.id === level.anchorId),
          )
          .map((node) => node.id),
      );
      return removeLayerSubtrees(layer, blockedInnerIds);
    });
    // Preserve the old contract (detail must survive), and never invalidate an already-established
    // transition anchor. In either case, farther ancestors cannot be composed safely.
    if (
      nextInner[0].tree.nodes.length === 0 ||
      nextInner.slice(1).some((layer) => layer.anchorId !== null && !layer.nodeIds.has(layer.anchorId))
    ) {
      break;
    }

    layers = nextInner;
    const preparedLevel: SemanticAncestorLevel<TContext> = {
      ...level,
      // The canonical derived tree is authoritative. In practice this matches collapseChain above,
      // but carrying the actual value keeps a future surface-specific focus rule handoff-safe.
      effectiveFocus: tree.effectiveFocus,
    };
    layers.push(
      sourceLayer(
        preparedLevel.depth,
        preparedLevel.focus,
        preparedLevel.anchorId,
        preparedLevel.label,
        {
          nodes: keptOuterNodes,
          edges: tree.edges.filter((edge) => edge.ghost !== true),
          effectiveFocus: tree.effectiveFocus,
        },
        false,
      ),
    );
    ancestors.push(preparedLevel);
  }

  return { layers, ancestors };
}

/**
 * Overlay all independently laid levels. Each outer graph is translated onto the previous graph's
 * structural centre, never laid around inner content. The output order is farthest ancestor first
 * and detail last, preserving parent-before-child order within every layer while letting the active
 * inner layer paint over its hidden backing graphs.
 */
export function composeSemanticStackLayouts<TContext = never>(
  layouts: readonly LaidModuleGraph[],
  stack: ModuleSemanticStack<TContext>,
): LaidModuleGraph | null {
  if (layouts.length !== stack.layers.length || layouts.length < 2) {
    return null;
  }

  const composedByDepth: LaidModuleGraph[] = [];
  const claimedIds = new Set<string>();

  for (let depth = 0; depth < layouts.length; depth += 1) {
    const source = stack.layers[depth];
    const layout = layouts[depth];
    const anchorId = source.anchorId;

    // Source preparation handles graph identities. This final guard covers RF-only nodes minted by
    // a future layout feature. Inner identities win non-anchor collisions; an anchor collision would
    // make the replacement ambiguous, so stop rather than emit duplicate React Flow ids.
    if (anchorId !== null && claimedIds.has(anchorId)) {
      return null;
    }
    const blockedIds = new Set(
      layout.nodes
        .filter((node) => node.id !== anchorId && claimedIds.has(node.id))
        .map((node) => node.id),
    );
    let nodes = filterLaidNodeSubtrees(layout.nodes, blockedIds);
    const nodeIds = new Set(nodes.map((node) => node.id));
    let edges = layout.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

    if (depth > 0) {
      const previous = composedByDepth[depth - 1];
      const previousBounds = structuralBounds(previous.nodes);
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const anchor = anchorId === null ? undefined : byId.get(anchorId);
      if (!previousBounds || !anchor) {
        return null;
      }
      const anchorRect = absoluteRectOf(anchor, byId);
      const dx = previousBounds.x + previousBounds.width / 2 - (anchorRect.x + anchorRect.width / 2);
      const dy = previousBounds.y + previousBounds.height / 2 - (anchorRect.y + anchorRect.height / 2);
      nodes = nodes.map((node) =>
        node.parentId
          ? node
          : { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } },
      );
    }

    const decorated = decorateLayer({ nodes, edges }, source);
    decorated.nodes.forEach((node) => claimedIds.add(node.id));
    composedByDepth.push(decorated);
  }

  return {
    nodes: [...composedByDepth].reverse().flatMap((layer) => layer.nodes),
    edges: [...composedByDepth].reverse().flatMap((layer) => layer.edges),
  };
}

/**
 * Permanently consume every mounted layer inside `depth`, leaving the committed parent and all of
 * its already-laid ancestors at their original absolute semantic depths. The original positions,
 * classes and data markers are returned byte-for-byte by reference; this is deliberately a scene
 * slice, not another derive/layout pass.
 *
 * Edges are admitted by both their own depth and retained endpoints. The endpoint guard makes the
 * helper safe for future RF-only cross-layer decorations without ever leaving a dangling wire.
 */
export function retainSemanticStackFromDepth(
  graph: LaidModuleGraph,
  depth: number,
): LaidModuleGraph | null {
  if (!Number.isInteger(depth) || depth < 0) {
    return null;
  }
  const nodes = graph.nodes.filter((node) => semanticDepthOf(node) >= depth);
  if (!nodes.some((node) => semanticDepthOf(node) === depth)) {
    return null;
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => semanticDepthOf(edge) >= depth && nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );
  return { nodes, edges };
}

export function hasSemanticClass(value: string | undefined, className: string): boolean {
  return value?.split(/\s+/).includes(className) === true;
}

export function appendClass(value: string | undefined, className: string): string {
  return hasSemanticClass(value, className) ? (value ?? className) : value ? `${value} ${className}` : className;
}

function semanticDepthOf(entry: Node | Edge): number {
  const depth = (entry.data as { semanticDepth?: unknown } | undefined)?.semanticDepth;
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : -1;
}

function sourceLayer(
  depth: number,
  focus: string | null,
  anchorId: string | null,
  label: string | null,
  tree: ModuleTree,
  keepGhostEdges: boolean,
): ModuleSemanticLayer {
  const nodeIds = new Set(tree.nodes.map((node) => node.id));
  return {
    depth,
    focus,
    anchorId,
    label,
    tree: {
      nodes: tree.nodes,
      edges: keepEdgesWithin(
        keepGhostEdges ? tree.edges : tree.edges.filter((edge) => edge.ghost !== true),
        nodeIds,
        `${LAYER_EDGE_PREFIX}${depth}:`,
      ),
      effectiveFocus: tree.effectiveFocus,
    },
    nodeIds,
  };
}

function removeLayerSubtrees(
  layer: ModuleSemanticLayer,
  blockedIds: ReadonlySet<string>,
): ModuleSemanticLayer {
  if (blockedIds.size === 0) {
    return layer;
  }
  const nodes = filterNodeSubtrees(layer.tree.nodes, blockedIds);
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...layer,
    nodeIds,
    tree: {
      ...layer.tree,
      nodes,
      edges: layer.tree.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    },
  };
}

/** Remove an expanded detail wrapper which the nearest outer graph owns as its collapsed anchor.
 * Direct children become roots and every descendant moves up one visual depth; unrelated top-level
 * extras and ghosts are untouched. A collapsed/leaf collision keeps the established outer-wins
 * policy instead, since there is no inner graph to preserve. */
function unwrapExpandedDetailAnchor(tree: ModuleTree, anchorId: string): ModuleTree {
  const anchor = tree.nodes.find((node) => node.id === anchorId);
  const directChildren = tree.nodes.filter((node) => node.parentId === anchorId);
  if (anchor?.isContainer !== true || anchor.isExpanded !== true || directChildren.length === 0) {
    return tree;
  }
  const parentOf = new Map(tree.nodes.map((node) => [node.id, node.parentId]));
  const nodes = tree.nodes
    .filter((node) => node.id !== anchorId)
    .map((node) => {
      if (!descendsFrom(node.id, anchorId, parentOf)) {
        return node;
      }
      return {
        ...node,
        parentId: node.parentId === anchorId ? null : node.parentId,
        depth: Math.max(0, node.depth - 1),
      };
    });
  return {
    ...tree,
    nodes,
    edges: tree.edges.filter((edge) => edge.source !== anchorId && edge.target !== anchorId),
  };
}

function descendsFrom(
  nodeId: string,
  ancestorId: string,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  const seen = new Set<string>();
  let current = parentOf.get(nodeId) ?? null;
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) {
      return true;
    }
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

function decorateLayer(graph: LaidModuleGraph, layer: ModuleSemanticLayer): LaidModuleGraph {
  const depthClass = semanticLayerClass(layer.depth);
  const nodes = graph.nodes.map((node) => {
    const role: SemanticRole = layer.depth === 0 ? "detail" : node.id === layer.anchorId ? "anchor" : "context";
    let className = appendClass(appendClass(node.className, SEMANTIC_LAYER_CLASS), depthClass);
    className = appendClass(
      className,
      role === "detail" ? SEMANTIC_DETAIL_CLASS : role === "anchor" ? SEMANTIC_PARENT_CLASS : SEMANTIC_CONTEXT_CLASS,
    );
    return {
      ...node,
      className,
      data: {
        ...node.data,
        semanticDepth: layer.depth,
        semanticRole: role,
        semanticAnchorId: layer.anchorId,
      },
    };
  });
  const edgeRole: SemanticRole = layer.depth === 0 ? "detail" : "context";
  const edges = graph.edges.map((edge) => {
    let className = appendClass(appendClass(edge.className, SEMANTIC_LAYER_CLASS), depthClass);
    className = appendClass(
      className,
      layer.depth === 0 ? SEMANTIC_DETAIL_EDGE_CLASS : SEMANTIC_CONTEXT_EDGE_CLASS,
    );
    return {
      ...edge,
      className,
      data: {
        ...edge.data,
        semanticDepth: layer.depth,
        semanticRole: edgeRole,
        semanticAnchorId: layer.anchorId,
      },
    };
  });
  return { nodes, edges };
}

/** Keep DFS source order while removing every blocked node and its descendants. */
function filterNodeSubtrees(nodes: VisibleModuleNode[], blockedIds: ReadonlySet<string>): VisibleModuleNode[] {
  const removed = new Set(blockedIds);
  const kept: VisibleModuleNode[] = [];
  for (const node of nodes) {
    if (removed.has(node.id) || (node.parentId !== null && removed.has(node.parentId))) {
      removed.add(node.id);
    } else {
      kept.push(node);
    }
  }
  return kept;
}

/** The same orphan guard for RF-only nodes minted during layout (for example a commons dock). */
function filterLaidNodeSubtrees(nodes: Node[], blockedIds: ReadonlySet<string>): Node[] {
  const removed = new Set(blockedIds);
  const kept: Node[] = [];
  for (const node of nodes) {
    if (removed.has(node.id) || (node.parentId !== undefined && removed.has(node.parentId))) {
      removed.add(node.id);
    } else {
      kept.push(node);
    }
  }
  return kept;
}

function keepEdgesWithin(
  edges: ModuleTreeEdge[],
  nodeIds: ReadonlySet<string>,
  prefix: string,
): ModuleTreeEdge[] {
  return edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({ ...edge, id: `${prefix}${edge.id}` }));
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Structural bounds mirror shared LOD: ghosts do not pull a semantic parent away from the graph. */
function structuralBounds(nodes: readonly Node[]): Rect | null {
  const structural = nodes.filter((node) => node.type !== "ghost");
  const bounded = structural.length > 0 ? structural : nodes;
  if (bounded.length === 0) {
    return null;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rects = bounded.map((node) => absoluteRectOf(node, byId));
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  return Object.values(bounds).every(Number.isFinite) ? bounds : null;
}

/** A laid node's absolute rectangle; RF child positions are relative to their parent chain. */
function absoluteRectOf(node: Node, byId: ReadonlyMap<string, Node>): Rect {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const seen = new Set<string>([node.id]);
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    seen.add(parentId);
    parentId = parent.parentId;
  }
  const style = (node.style ?? {}) as { width?: number | string; height?: number | string };
  return {
    x,
    y,
    width: numericSize(style.width ?? node.measured?.width ?? node.width),
    height: numericSize(style.height ?? node.measured?.height ?? node.height),
  };
}

function numericSize(value: number | string | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  const parsed = typeof value === "string" ? Number.parseFloat(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function overviewAnchorOf(index: GraphIndex, nodeId: string): string | null {
  const npmPackage = npmPackageIdOf(nodeId, index.nodesById);
  if (npmPackage !== null) {
    return npmPackage;
  }
  return index.ancestorsOf(nodeId).find((node) => node.kind === PACKAGE_KIND)?.id ?? null;
}

function childOnPath(index: GraphIndex, ancestorId: string, descendantId: string): string | null {
  const path = index.ancestorsOf(descendantId).filter((node) => node.kind === PACKAGE_KIND || node.kind === MODULE_KIND);
  const ancestorIndex = path.findIndex((node) => node.id === ancestorId);
  return ancestorIndex >= 0 ? (path[ancestorIndex + 1]?.id ?? null) : null;
}
