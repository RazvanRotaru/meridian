import type { Edge, Node } from "@xyflow/react";

const FLOW_ACCENT = "#56C271";
const DIM_NODE_OPACITY = 0.35;
const DIM_EDGE_OPACITY = 0.14;
const EMPHASIS_WIDTH = 2.6;

export function emphasizeFlow<N extends Node, E extends Edge>(
  nodes: N[],
  edges: E[],
  emphasis: ReadonlySet<string>,
): { nodes: N[]; edges: E[] } {
  if (emphasis.size === 0) {
    return { nodes, edges };
  }
  const kept = keptNodeIds(nodes, emphasis);
  return {
    nodes: nodes.map((node) => styleNode(node, emphasis, kept)),
    edges: edges.map((edge) => styleEdge(edge, emphasis)),
  };
}

export function renderedIdsForFlowEmphasis(
  nodes: readonly Node[],
  emphasis: ReadonlySet<string>,
  parentOf: ReadonlyMap<string, string | null>,
): string[] {
  const rendered = new Set(nodes.map((node) => node.id));
  const lifted: string[] = [];
  const seen = new Set<string>();
  for (const id of emphasis) {
    const target = nearestRenderedAncestor(id, rendered, parentOf);
    if (target && !seen.has(target)) {
      seen.add(target);
      lifted.push(target);
    }
  }
  return lifted;
}

function keptNodeIds(nodes: readonly Node[], emphasis: ReadonlySet<string>): Set<string> {
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  const kept = new Set<string>();
  for (const id of emphasis) {
    if (!parentById.has(id)) {
      continue;
    }
    for (let current: string | undefined = id; current; current = parentById.get(current)) {
      if (kept.has(current)) {
        break;
      }
      kept.add(current);
    }
  }
  return kept;
}

function nearestRenderedAncestor(
  id: string,
  rendered: ReadonlySet<string>,
  parentOf: ReadonlyMap<string, string | null>,
): string | null {
  const visited = new Set<string>();
  let current: string | null | undefined = id;
  while (current && !visited.has(current)) {
    if (rendered.has(current)) {
      return current;
    }
    visited.add(current);
    current = parentOf.get(current) ?? null;
  }
  return null;
}

function styleNode<N extends Node>(node: N, emphasis: ReadonlySet<string>, kept: ReadonlySet<string>): N {
  if (!kept.has(node.id)) {
    return { ...node, style: { ...node.style, opacity: DIM_NODE_OPACITY } } as N;
  }
  if (!emphasis.has(node.id)) {
    return { ...node, style: { ...node.style, opacity: 1 } } as N;
  }
  return {
    ...node,
    style: {
      ...node.style,
      opacity: 1,
      borderRadius: 10,
      boxShadow: `0 0 0 2px ${FLOW_ACCENT}, 0 0 18px rgba(86,194,113,0.24)`,
    },
  } as N;
}

function styleEdge<E extends Edge>(edge: E, emphasis: ReadonlySet<string>): E {
  const lit = emphasis.has(edge.source) && emphasis.has(edge.target);
  return {
    ...edge,
    style: {
      ...edge.style,
      opacity: lit ? 1 : DIM_EDGE_OPACITY,
      strokeWidth: lit ? EMPHASIS_WIDTH : edge.style?.strokeWidth,
    },
  } as E;
}
