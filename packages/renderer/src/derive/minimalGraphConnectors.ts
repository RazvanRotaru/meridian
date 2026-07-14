/**
 * Same-abstraction connector discovery for Extract selection. The source Map has already projected
 * declaration relationships onto the cards the reader sees, so the shortest weakly-connected card
 * path is the honest bridge to retain in the extracted graph. Weak connectivity is intentional: two
 * selected collaborators can be joined by their shared caller (or dependency) even though neither
 * can reach the other by following arrow direction alone.
 */

import type { Edge, Node } from "@xyflow/react";

interface ConnectorArc {
  target: string;
  /** Number of distinct drawn relationship strands supporting this card-to-card connection. */
  strands: number;
  /** Aggregate artifact weight, used only after hop and strand count. */
  weight: number;
}

interface ConnectorPath {
  ids: string[];
  strands: number;
  weight: number;
}

/** Interior cards on deterministic shortest weak paths between every selected pair. Equal-hop
 * alternatives prefer the connection backed by more relationship kinds, then greater total weight;
 * this keeps a calls+references service bridge ahead of a coincidental single-kind reference sink. */
export function minimalGraphConnectorIds(
  nodes: readonly Node[],
  edges: readonly Edge[],
  selectedIds: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = [...selectedIds]
    .filter((id) => isConnectorCandidate(byId.get(id)))
    .sort();
  if (selected.length < 2 || selected.length !== selectedIds.size) {
    return new Set();
  }

  const abstraction = abstractionKey(byId.get(selected[0])!);
  if (!selected.every((id) => abstractionKey(byId.get(id)!) === abstraction)) {
    return new Set();
  }
  const candidates = new Set(
    nodes
      .filter((node) => isConnectorCandidate(node) && abstractionKey(node) === abstraction)
      .map((node) => node.id),
  );
  const adjacency = weakAdjacency(edges, candidates);
  const connectors = new Set<string>();

  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      const path = shortestPath(selected[left], selected[right], adjacency);
      path?.ids.slice(1, -1).forEach((id) => connectors.add(id));
    }
  }
  return connectors;
}

function isConnectorCandidate(node: Node | undefined): node is Node {
  return node !== undefined && node.type !== "ghost";
}

/** Type + containment parent + semantic-zoom population define the card abstraction on screen. */
function abstractionKey(node: Node): string {
  const depth = (node.data as { semanticDepth?: unknown }).semanticDepth;
  const normalizedDepth = typeof depth === "number" && Number.isFinite(depth) ? depth : "none";
  return `${node.type ?? "unknown"}\u0000${node.parentId ?? "root"}\u0000${normalizedDepth}`;
}

function weakAdjacency(edges: readonly Edge[], candidates: ReadonlySet<string>): Map<string, ConnectorArc[]> {
  const pairs = new Map<string, { left: string; right: string; strands: number; weight: number }>();
  for (const edge of edges) {
    if (edge.source === edge.target || !candidates.has(edge.source) || !candidates.has(edge.target)) {
      continue;
    }
    const data = edge.data as {
      edgeRole?: unknown;
      ghost?: unknown;
      ghostHierarchy?: unknown;
      outsideView?: unknown;
      presentationOnly?: unknown;
    } | undefined;
    if (
      data?.ghost === true
      || data?.outsideView === true
      || data?.presentationOnly === true
      || data?.ghostHierarchy === true
      || data?.edgeRole === "ghost-hierarchy"
    ) {
      continue;
    }
    const [left, right] = edge.source.localeCompare(edge.target) <= 0
      ? [edge.source, edge.target]
      : [edge.target, edge.source];
    const key = `${left}\u0000${right}`;
    const evidence = edgeEvidence(edge);
    const current = pairs.get(key);
    if (current === undefined) {
      pairs.set(key, { left, right, ...evidence });
    } else {
      current.strands += evidence.strands;
      current.weight += evidence.weight;
    }
  }
  const values = new Map<string, ConnectorArc[]>();
  for (const pair of pairs.values()) {
    values.set(pair.left, [...(values.get(pair.left) ?? []), {
      target: pair.right,
      strands: pair.strands,
      weight: pair.weight,
    }]);
    values.set(pair.right, [...(values.get(pair.right) ?? []), {
      target: pair.left,
      strands: pair.strands,
      weight: pair.weight,
    }]);
  }
  for (const arcs of values.values()) {
    arcs.sort((a, b) => a.target.localeCompare(b.target));
  }
  return values;
}

function edgeEvidence(edge: Edge): { strands: number; weight: number } {
  const data = edge.data as { members?: unknown; weight?: unknown } | undefined;
  const members = Array.isArray(data?.members) ? data.members : null;
  if (members !== null && members.length > 0) {
    return {
      strands: members.length,
      weight: members.reduce((sum, member) => sum + numericWeight(
        (member as { data?: { weight?: unknown } } | undefined)?.data?.weight,
      ), 0),
    };
  }
  return { strands: 1, weight: numericWeight(data?.weight) };
}

function numericWeight(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

function shortestPath(
  source: string,
  target: string,
  adjacency: ReadonlyMap<string, readonly ConnectorArc[]>,
): ConnectorPath | null {
  const queue = [source];
  const best = new Map<string, ConnectorPath>([[source, { ids: [source], strands: 0, weight: 0 }]]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const currentPath = best.get(current)!;
    for (const arc of adjacency.get(current) ?? []) {
      const candidate: ConnectorPath = {
        ids: [...currentPath.ids, arc.target],
        strands: currentPath.strands + arc.strands,
        weight: currentPath.weight + arc.weight,
      };
      const existing = best.get(arc.target);
      if (existing !== undefined && !betterPath(candidate, existing)) continue;
      best.set(arc.target, candidate);
      queue.push(arc.target);
    }
  }
  return best.get(target) ?? null;
}

function betterPath(candidate: ConnectorPath, existing: ConnectorPath): boolean {
  if (candidate.ids.length !== existing.ids.length) {
    return candidate.ids.length < existing.ids.length;
  }
  if (candidate.strands !== existing.strands) {
    return candidate.strands > existing.strands;
  }
  if (candidate.weight !== existing.weight) {
    return candidate.weight > existing.weight;
  }
  return candidate.ids.join("\u0000").localeCompare(existing.ids.join("\u0000")) < 0;
}
