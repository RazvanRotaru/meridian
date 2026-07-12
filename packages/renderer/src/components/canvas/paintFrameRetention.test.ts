import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { additiveNodePositionKey } from "./additiveNodePositions";
import {
  createPaintFrameRetentionState,
  resolvePaintFrameRetention,
  type PaintedScene,
} from "./paintFrameRetention";

function node(id: string, x: number, y: number): Node {
  return { id, position: { x, y }, data: {} };
}

function edge(id: string, source: string, target: string): Edge {
  return { id, source, target };
}

function scene(
  nodes: Node[],
  edges: Edge[] = [],
  beacons: ReadonlySet<string> = new Set(),
  highwaySeeds: ReadonlySet<string> = new Set(),
): PaintedScene {
  return { nodes, edges, beacons, highwaySeeds };
}

function positionOf(value: PaintedScene, id: string): { x: number; y: number } {
  return value.nodes.find((candidate) => candidate.id === id)!.position;
}

describe("paint frame retention", () => {
  it("freezes a transient first hop and admits only the settled additive frame", () => {
    const readyA = scene(
      [node("anchor", 10, 20)],
      [edge("ready-a", "anchor", "anchor")],
      new Set(["anchor"]),
      new Set(["anchor"]),
    );
    const initial = resolvePaintFrameRetention(
      readyA,
      createPaintFrameRetentionState(readyA),
      null,
      false,
    );
    const transient = node("transient", 900, 800);
    const busyB = scene(
      [node("anchor", 400, 300), transient],
      [edge("transient-edge", "anchor", "transient")],
      new Set(["transient"]),
      new Set(["transient"]),
    );

    const frozen = resolvePaintFrameRetention(busyB, initial.state, "path", true);

    expect(frozen.scene).toBe(initial.scene);
    expect(frozen.state).toBe(initial.state);
    expect(frozen.scene.edges).toBe(readyA.edges);
    expect(frozen.scene.beacons).toBe(readyA.beacons);
    expect(frozen.scene.highwaySeeds).toBe(readyA.highwaySeeds);

    const readyC = scene(
      [node("anchor", 400, 300), node("settled-neighbour", 520, 340)],
      [edge("ready-c", "anchor", "settled-neighbour")],
      new Set(["settled-neighbour"]),
      new Set(["anchor", "settled-neighbour"]),
    );
    const admitted = resolvePaintFrameRetention(readyC, frozen.state, "path", false);

    expect(positionOf(admitted.scene, "anchor")).toEqual({ x: 10, y: 20 });
    expect(positionOf(admitted.scene, "settled-neighbour")).toEqual({ x: 130, y: 60 });
    expect(admitted.scene.edges).toBe(readyC.edges);
    expect(admitted.scene.beacons).toBe(readyC.beacons);
    expect(admitted.scene.highwaySeeds).toBe(readyC.highwaySeeds);
    expect(admitted.state.positionSession?.ledger.has(additiveNodePositionKey(transient))).toBe(false);
  });

  it("holds every prior coordinate through a second busy/ready hop", () => {
    const initialScene = scene([node("anchor", 10, 20)]);
    const first = resolvePaintFrameRetention(
      scene(
        [node("anchor", 100, 200), node("first", 180, 240)],
        [edge("anchor-first", "anchor", "first")],
      ),
      createPaintFrameRetentionState(initialScene),
      "path",
      false,
    );
    const firstPositions = new Map(first.scene.nodes.map((entry) => [entry.id, entry.position]));
    const busy = scene(
      [node("anchor", 1_000, 1_000), node("first", 1_080, 1_040), node("provisional", 1_200, 1_100)],
      [edge("provisional-wire", "first", "provisional")],
    );

    const frozen = resolvePaintFrameRetention(busy, first.state, "path", true);
    expect(frozen.scene).toBe(first.scene);
    expect(frozen.state).toBe(first.state);

    const finalCandidate = scene(
      [node("anchor", 500, 500), node("first", 580, 540), node("second", 690, 570)],
      [edge("anchor-first", "anchor", "first"), edge("first-second", "first", "second")],
    );
    const second = resolvePaintFrameRetention(finalCandidate, frozen.state, "path", false);

    expect(positionOf(second.scene, "anchor")).toEqual(firstPositions.get("anchor"));
    expect(positionOf(second.scene, "first")).toEqual(firstPositions.get("first"));
    expect(second.scene.nodes.map((entry) => entry.id)).toEqual(["anchor", "first", "second"]);
    expect(second.state.positionSession?.ledger.has(additiveNodePositionKey(busy.nodes[2]))).toBe(false);
  });

  it("freezes a deferred close, then admits the raw closed scene and clears its session", () => {
    const base = scene([node("anchor", 10, 20)]);
    const open = resolvePaintFrameRetention(
      scene([node("anchor", 300, 400), node("neighbour", 450, 420)]),
      createPaintFrameRetentionState(base),
      "path",
      false,
    );
    const closedCandidate = scene(
      [node("anchor", 700, 800)],
      [edge("closed-edge", "anchor", "anchor")],
      new Set(["closed-beacon"]),
      new Set(["closed-seed"]),
    );

    const busyClose = resolvePaintFrameRetention(closedCandidate, open.state, null, true);
    expect(busyClose.scene).toBe(open.scene);
    expect(busyClose.state).toBe(open.state);

    const closed = resolvePaintFrameRetention(closedCandidate, busyClose.state, null, false);
    expect(closed.scene).toBe(closedCandidate);
    expect(closed.state.lastSettledScene).toBe(closedCandidate);
    expect(closed.state.positionSession).toBeNull();
    expect(positionOf(closed.scene, "anchor")).toEqual({ x: 700, y: 800 });
  });

  it("does not gate unrelated deferred paint when no position session is opening or active", () => {
    const initial = scene([node("before", 0, 0)]);
    const candidate = scene([node("ordinary-busy-frame", 30, 40)]);

    const resolved = resolvePaintFrameRetention(
      candidate,
      createPaintFrameRetentionState(initial),
      null,
      true,
    );

    expect(resolved.scene).toBe(candidate);
    expect(resolved.state.lastSettledScene).toBe(candidate);
    expect(resolved.state.positionSession).toBeNull();
  });

  it("does not seed a remounted session from its initial provisional frame", () => {
    const provisional = scene([
      node("anchor", 800, 900),
      node("provisional-only", 1_000, 1_100),
    ]);
    const initialBusy = resolvePaintFrameRetention(
      provisional,
      createPaintFrameRetentionState(null),
      "path",
      true,
    );

    expect(initialBusy.scene).toBe(provisional);
    expect(initialBusy.state.lastSettledScene).toBeNull();
    expect(initialBusy.state.positionSession).toBeNull();

    const ready = scene([
      node("anchor", 20, 30),
      node("final-only", 140, 60),
    ]);
    const admitted = resolvePaintFrameRetention(ready, initialBusy.state, "path", false);

    expect(admitted.scene.nodes.map((entry) => entry.id)).toEqual(["anchor", "final-only"]);
    expect(positionOf(admitted.scene, "anchor")).toEqual({ x: 20, y: 30 });
    expect(positionOf(admitted.scene, "final-only")).toEqual({ x: 140, y: 60 });
    expect(admitted.state.positionSession?.ledger.has(additiveNodePositionKey(provisional.nodes[1]))).toBe(false);
  });
});
