/**
 * Restrict the whole-system composition to a view ROOTED at one module/package: the units the root
 * contains (its subtree via parentId) plus their 1-hop coupling neighbours, the latter flagged as
 * faded BOUNDARY units the reader can click to re-root. Pure set arithmetic over the already-computed
 * survivor set + coupling wires — no metrics, no React. A null / empty / stale root yields the whole
 * system unchanged, so the canvas is never blanked by a bad root id.
 */

import type { GraphNode } from "@meridian/core";
import { isWithinRoot, type CouplingEdge } from "@meridian/design-metrics";

/** The units to draw for a root, and which of them are the 1-hop boundary neighbours (never root's). */
export interface RootedView {
  visible: Set<string>;
  boundary: Set<string>;
}

/**
 * `root === null` (or a root containing no surviving units) → the whole survivor set, no boundary.
 * Otherwise: rootUnits = survivors within the root PLUS the root's own unit (never hidden, even at
 * 0 members / 0 couplings); boundary = survivors outside rootUnits sharing a coupling wire with some
 * rootUnit; visible = rootUnits ∪ boundary. `rootIsUnit` says the root itself owns a scorecard (a
 * module/class does; a package does not — its contained modules are the rootUnits).
 */
export function computeRootedView(
  root: string | null,
  survivors: Set<string>,
  rootIsUnit: boolean,
  couplings: CouplingEdge[],
  nodesById: Map<string, GraphNode>,
): RootedView {
  if (root === null) {
    return { visible: survivors, boundary: new Set() };
  }
  const rootUnits = unitsWithinRoot(root, survivors, rootIsUnit, nodesById);
  if (rootUnits.size === 0) {
    return { visible: survivors, boundary: new Set() }; // stale/invalid root → whole system.
  }
  const boundary = oneHopNeighbours(rootUnits, survivors, couplings);
  return { visible: new Set([...rootUnits, ...boundary]), boundary };
}

function unitsWithinRoot(
  root: string,
  survivors: Set<string>,
  rootIsUnit: boolean,
  nodesById: Map<string, GraphNode>,
): Set<string> {
  const within = new Set<string>();
  for (const id of survivors) {
    if (isWithinRoot(id, root, nodesById)) {
      within.add(id);
    }
  }
  if (rootIsUnit) {
    within.add(root); // the root scorecard is always shown, even with 0 members / 0 couplings.
  }
  return within;
}

function oneHopNeighbours(rootUnits: Set<string>, survivors: Set<string>, couplings: CouplingEdge[]): Set<string> {
  const neighbours = new Set<string>();
  for (const edge of couplings) {
    const other = neighbourAcross(edge, rootUnits);
    if (other !== null && survivors.has(other)) {
      neighbours.add(other);
    }
  }
  return neighbours;
}

/** The endpoint on the far side of a wire with EXACTLY one end in the root; null when both/neither are. */
function neighbourAcross(edge: CouplingEdge, rootUnits: Set<string>): string | null {
  const sourceIn = rootUnits.has(edge.source);
  const targetIn = rootUnits.has(edge.target);
  if (sourceIn === targetIn) {
    return null;
  }
  return sourceIn ? edge.target : edge.source;
}
