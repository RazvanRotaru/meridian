/**
 * Restrict the whole-system composition to a view ROOTED at one module/package: the units the root
 * contains (its subtree via parentId) plus their coupling neighbours, the latter flagged as faded
 * BOUNDARY units the reader can click to re-root. The neighbour set is 1-hop by default; in BLAST
 * RADIUS mode it is instead every transitive dependent of the root — everything a change inside the
 * root can break. Pure set arithmetic over the already-computed survivor set + coupling wires — no
 * metrics, no React. A null / empty / stale root yields the whole system unchanged, so the canvas
 * is never blanked by a bad root id.
 */

import type { GraphNode } from "@meridian/core";
import { isWithinRoot, type CouplingEdge } from "./composition-graph";

/** The units to draw for a root, and which of them are the 1-hop boundary neighbours (never root's). */
export interface RootedView {
  visible: Set<string>;
  boundary: Set<string>;
}

/**
 * `root === null` (or a root containing no surviving units) → the whole survivor set, no boundary.
 * Otherwise: rootUnits = survivors within the root PLUS the root's own unit (never hidden, even at
 * 0 members / 0 couplings); boundary = survivors outside rootUnits sharing a coupling wire with some
 * rootUnit — or, with `blastRadius`, every survivor that transitively DEPENDS on a rootUnit; visible
 * = rootUnits ∪ boundary. `rootIsUnit` says the root itself owns a scorecard (a module/class does;
 * a package does not — its contained modules are the rootUnits).
 */
export function computeRootedView(
  root: string | null,
  survivors: Set<string>,
  rootIsUnit: boolean,
  couplings: CouplingEdge[],
  nodesById: Map<string, GraphNode>,
  blastRadius = false,
): RootedView {
  if (root === null) {
    return { visible: survivors, boundary: new Set() };
  }
  const rootUnits = unitsWithinRoot(root, survivors, rootIsUnit, nodesById);
  if (rootUnits.size === 0) {
    return { visible: survivors, boundary: new Set() }; // stale/invalid root → whole system.
  }
  const boundary = blastRadius
    ? transitiveDependents(rootUnits, survivors, couplings)
    : oneHopNeighbours(rootUnits, survivors, couplings);
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

/**
 * The blast radius: every survivor that can REACH a root unit over the coupling wires at any depth
 * — the full set a change inside the root can break. An iterative worklist BFS over the reverse
 * (afferent) direction; the `reached` set makes it cycle-safe and terminates it at the fixpoint.
 */
function transitiveDependents(rootUnits: Set<string>, survivors: Set<string>, couplings: CouplingEdge[]): Set<string> {
  const dependantsOf = reverseAdjacency(couplings);
  const reached = new Set(rootUnits);
  const worklist = [...rootUnits];
  const dependents = new Set<string>();
  while (worklist.length > 0) {
    const unit = worklist.pop() as string;
    for (const dependant of dependantsOf.get(unit) ?? []) {
      if (!reached.has(dependant) && survivors.has(dependant)) {
        reached.add(dependant);
        dependents.add(dependant);
        worklist.push(dependant);
      }
    }
  }
  return dependents;
}

function reverseAdjacency(couplings: CouplingEdge[]): Map<string, string[]> {
  const dependantsOf = new Map<string, string[]>();
  for (const edge of couplings) {
    const bucket = dependantsOf.get(edge.target);
    bucket ? bucket.push(edge.source) : dependantsOf.set(edge.target, [edge.source]);
  }
  return dependantsOf;
}
