/**
 * npm-package ownership for dependency wires.
 *
 * Ownership is a property of the artifact's ORIGINAL endpoints, never of the boxes a view happens
 * to lift them onto. A node belongs to its nearest `npm-package` ancestor. Code from a single-package
 * artifact has no tagged root node, so it shares one implicit artifact-root scope; after artifacts are
 * linked, each untagged root instead belongs to its enclosing `system` node. External/unresolved
 * pseudo-ids are always outside every source package.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";

const NPM_PACKAGE_TAG = "npm-package";
const PACKAGE_KIND = "package";
const SYSTEM_KIND = "system";
const IMPLICIT_ARTIFACT_ROOT = "scope:artifact-root";
const OUTSIDE_PACKAGE = "scope:outside";

/** The nearest package.json-backed ancestor-or-self, or null for implicit-root/package-less code. */
export function npmPackageIdOf(nodeId: string, nodesById: ReadonlyMap<string, GraphNode>): string | null {
  const visited = new Set<string>();
  let current = nodesById.get(nodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === PACKAGE_KIND && (current.tags?.includes(NPM_PACKAGE_TAG) ?? false)) {
      return current.id;
    }
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return null;
}

/** Stable ownership key: nearest npm package, else linked system, else the implicit artifact root. */
export function packageScopeOf(nodeId: string, index: Pick<GraphIndex, "nodesById">): string {
  if (isBoundaryPseudoId(nodeId)) {
    return OUTSIDE_PACKAGE;
  }
  const npmPackage = npmPackageIdOf(nodeId, index.nodesById);
  if (npmPackage !== null) {
    return `npm:${npmPackage}`;
  }
  const system = systemAncestorOf(nodeId, index.nodesById);
  if (system !== null) {
    return `system:${system}`;
  }
  // An id absent from the artifact cannot honestly be assigned to its source root. Valid resolved
  // edges never hit this path, but the lenient viewer also accepts non-resolved boundary targets.
  return index.nodesById.has(nodeId) ? IMPLICIT_ARTIFACT_ROOT : OUTSIDE_PACKAGE;
}

/** Whether two ORIGINAL artifact endpoints leave their owning npm/root package. */
export function crossesPackageBoundary(
  source: string,
  target: string,
  index: Pick<GraphIndex, "nodesById">,
): boolean {
  const sourceScope = packageScopeOf(source, index);
  const targetScope = packageScopeOf(target, index);
  return sourceScope === OUTSIDE_PACKAGE || targetScope === OUTSIDE_PACKAGE || sourceScope !== targetScope;
}

export function graphEdgeCrossesPackage(edge: Pick<GraphEdge, "source" | "target">, index: Pick<GraphIndex, "nodesById">): boolean {
  return crossesPackageBoundary(edge.source, edge.target, index);
}

/** An aggregate is cross-package when ANY concrete artifact edge behind it crosses the boundary. */
export function underlyingEdgesCrossPackage(
  underlyingEdgeIds: readonly string[],
  index: Pick<GraphIndex, "nodesById" | "edgesById">,
): boolean {
  return underlyingEdgeIds.some((id) => {
    const edge = index.edgesById.get(id);
    return edge !== undefined && graphEdgeCrossesPackage(edge, index);
  });
}

function systemAncestorOf(nodeId: string, nodesById: ReadonlyMap<string, GraphNode>): string | null {
  const visited = new Set<string>();
  let current = nodesById.get(nodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === SYSTEM_KIND) {
      return current.id;
    }
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return null;
}

function isBoundaryPseudoId(id: string): boolean {
  return id.startsWith("ext:") || id.startsWith("unresolved:");
}
