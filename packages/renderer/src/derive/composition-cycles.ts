/**
 * Dependency-cycle detection over the directed unit coupling graph: Tarjan's strongly-connected
 * components, iteratively (an explicit frame stack instead of recursion, so a deep dependency
 * chain in a large graph can never blow the call stack). Pure — no React, no DOM.
 */

import type { CouplingEdge } from "./composition-graph";

/**
 * The units caught in a dependency cycle: every member of a strongly-connected component of size
 * ≥ 2, mapped to the OTHER units of its component (sorted, so the UI/tests can name the loop
 * deterministically). Units outside any cycle are absent. Self-loops need no special case —
 * `couplingEdges` drops same-unit pairs, so the unit graph cannot contain one.
 */
export function cyclePeersByUnit(couplings: CouplingEdge[]): Map<string, string[]> {
  const peers = new Map<string, string[]>();
  for (const component of stronglyConnectedComponents(adjacencyOf(couplings))) {
    if (component.length < 2) {
      continue;
    }
    const members = [...component].sort();
    for (const unitId of component) {
      peers.set(unitId, members.filter((other) => other !== unitId));
    }
  }
  return peers;
}

function adjacencyOf(couplings: CouplingEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const coupling of couplings) {
    if (!adjacency.has(coupling.source)) {
      adjacency.set(coupling.source, []);
    }
    if (!adjacency.has(coupling.target)) {
      adjacency.set(coupling.target, []);
    }
    adjacency.get(coupling.source)?.push(coupling.target);
  }
  return adjacency;
}

interface TarjanState {
  nextIndex: number;
  index: Map<string, number>;
  lowlink: Map<string, number>;
  stack: string[];
  onStack: Set<string>;
  components: string[][];
}

function stronglyConnectedComponents(adjacency: Map<string, string[]>): string[][] {
  const state: TarjanState = {
    nextIndex: 0,
    index: new Map(),
    lowlink: new Map(),
    stack: [],
    onStack: new Set(),
    components: [],
  };
  for (const vertex of adjacency.keys()) {
    if (!state.index.has(vertex)) {
      collectFrom(vertex, adjacency, state);
    }
  }
  return state.components;
}

/** Tarjan's visit, iteratively: each frame remembers how many children it has explored, so
 * revisiting the top frame resumes exactly where its "recursive call" would have returned. */
function collectFrom(start: string, adjacency: Map<string, string[]>, state: TarjanState): void {
  const frames = [{ vertex: start, nextChild: 0 }];
  openVertex(start, state);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    const children = adjacency.get(frame.vertex) ?? [];
    if (frame.nextChild < children.length) {
      const child = children[frame.nextChild];
      frame.nextChild += 1;
      if (!state.index.has(child)) {
        openVertex(child, state);
        frames.push({ vertex: child, nextChild: 0 });
      } else if (state.onStack.has(child)) {
        lowerLowlink(frame.vertex, state.index.get(child) ?? 0, state);
      }
      continue;
    }
    frames.pop();
    closeVertex(frame.vertex, frames[frames.length - 1]?.vertex, state);
  }
}

function openVertex(vertex: string, state: TarjanState): void {
  state.index.set(vertex, state.nextIndex);
  state.lowlink.set(vertex, state.nextIndex);
  state.nextIndex += 1;
  state.stack.push(vertex);
  state.onStack.add(vertex);
}

/** All children explored: emit the component if this vertex is its root, then propagate the
 * lowlink to the parent frame (what the recursive form does right after the call returns). */
function closeVertex(vertex: string, parent: string | undefined, state: TarjanState): void {
  const lowlink = state.lowlink.get(vertex) ?? 0;
  if (lowlink === state.index.get(vertex)) {
    state.components.push(popComponent(vertex, state));
  }
  if (parent !== undefined) {
    lowerLowlink(parent, lowlink, state);
  }
}

function lowerLowlink(vertex: string, candidate: number, state: TarjanState): void {
  state.lowlink.set(vertex, Math.min(state.lowlink.get(vertex) ?? candidate, candidate));
}

function popComponent(rootVertex: string, state: TarjanState): string[] {
  const component: string[] = [];
  let popped: string | undefined;
  do {
    popped = state.stack.pop();
    if (popped === undefined) {
      break;
    }
    state.onStack.delete(popped);
    component.push(popped);
  } while (popped !== rootVertex);
  return component;
}
