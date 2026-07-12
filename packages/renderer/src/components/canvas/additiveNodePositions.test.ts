import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import {
  additiveNodePositionKey,
  applyAdditiveNodePositions,
  captureAdditiveNodePositions,
  type AdditiveNodePositionLedger,
} from "./additiveNodePositions";

function node(
  id: string,
  x: number,
  y: number,
  options: { depth?: number; parentId?: string; type?: string; width?: number; height?: number } = {},
): Node {
  return {
    id,
    type: options.type ?? "file",
    position: { x, y },
    ...(options.parentId ? { parentId: options.parentId } : {}),
    ...(options.width === undefined && options.height === undefined
      ? {}
      : { style: { width: options.width ?? 100, height: options.height ?? 40 } }),
    data: options.depth === undefined ? {} : { semanticDepth: options.depth },
  };
}

function edge(id: string, source: string, target: string, depth?: number): Edge {
  return {
    id,
    source,
    target,
    data: depth === undefined ? {} : { semanticDepth: depth },
  };
}

function settle(
  candidates: readonly Node[],
  previous: AdditiveNodePositionLedger = new Map(),
  edges: readonly Edge[] = [],
) {
  const ledger = captureAdditiveNodePositions(candidates, previous, edges);
  return { ledger, nodes: applyAdditiveNodePositions(candidates, ledger) };
}

function byDepthAndId(nodes: readonly Node[], depth: number | undefined, id: string): Node {
  return nodes.find((candidate) =>
    candidate.id === id && (candidate.data as { semanticDepth?: number }).semanticDepth === depth,
  )!;
}

describe("additive node positions", () => {
  it("keeps an already-rendered root at its exact absolute position after candidate relayout", () => {
    const first = settle([node("root", 10, 20)]);
    const second = settle([node("root", 410, 320)], first.ledger);

    expect(second.nodes[0].position).toEqual({ x: 10, y: 20 });
    expect(second.ledger.get(additiveNodePositionKey(second.nodes[0]))).toEqual({ x: 10, y: 20 });
  });

  it("keeps the same semantic id in place when a root ghost becomes a nested real node", () => {
    const first = settle([node("service.send", 500, 90, { type: "ghost" })]);
    const second = settle([
      node("service-frame", 40, 800, { type: "module" }),
      node("service.send", 30, 20, { parentId: "service-frame", type: "method" }),
    ], first.ledger);
    const frame = byDepthAndId(second.nodes, undefined, "service-frame");
    const method = byDepthAndId(second.nodes, undefined, "service.send");

    expect(method.type).toBe("method");
    expect(frame.position).toEqual({ x: 470, y: 70 });
    expect(method.position).toEqual({ x: 30, y: 20 });
    expect(second.ledger.get(additiveNodePositionKey(method))).toEqual({ x: 500, y: 90 });
  });

  it("converts locked absolutes back to parent-relative positions and translates a new child with its locked parent", () => {
    const first = settle([
      node("frame", 100, 50, { type: "module" }),
      node("old-child", 20, 10, { parentId: "frame", type: "method" }),
    ]);
    const second = settle([
      node("frame", 400, 300, { type: "module" }),
      node("old-child", 30, 20, { parentId: "frame", type: "method" }),
      node("new-child", 70, 50, { parentId: "frame", type: "method" }),
    ], first.ledger);
    const frame = byDepthAndId(second.nodes, undefined, "frame");
    const oldChild = byDepthAndId(second.nodes, undefined, "old-child");
    const newChild = byDepthAndId(second.nodes, undefined, "new-child");

    expect(frame.position).toEqual({ x: 100, y: 50 });
    expect(oldChild.position).toEqual({ x: 20, y: 10 });
    expect(newChild.position).toEqual({ x: 70, y: 50 });
    expect(second.ledger.get(additiveNodePositionKey(newChild))).toEqual({ x: 170, y: 100 });
  });

  it("keeps duplicate ids at different semantic depths independent", () => {
    const first = settle([
      node("shared", 10, 20, { depth: 0 }),
      node("shared", 100, 200, { depth: 1 }),
    ]);
    const second = settle([
      node("shared", 30, 40, { depth: 0 }),
      node("shared", 300, 400, { depth: 1 }),
    ], first.ledger);

    expect(byDepthAndId(second.nodes, 0, "shared").position).toEqual({ x: 10, y: 20 });
    expect(byDepthAndId(second.nodes, 1, "shared").position).toEqual({ x: 100, y: 200 });
    expect(first.ledger.size).toBe(2);
  });

  it("adds new nodes at candidate geometry, translating edge-neighbours, and retains absent entries", () => {
    const first = settle([node("anchor", 10, 30)]);
    const expanded = settle([
      node("anchor", 300, 330),
      node("neighbour", 430, 370, { type: "ghost" }),
      node("disconnected", 900, 700, { type: "ghost" }),
    ], first.ledger, [edge("anchor-neighbour", "anchor", "neighbour")]);

    expect(byDepthAndId(expanded.nodes, undefined, "anchor").position).toEqual({ x: 10, y: 30 });
    expect(byDepthAndId(expanded.nodes, undefined, "neighbour").position).toEqual({ x: 140, y: 70 });
    expect(byDepthAndId(expanded.nodes, undefined, "disconnected").position).toEqual({ x: 900, y: 700 });

    const hidden = settle([node("anchor", 700, 800)], expanded.ledger);
    expect(hidden.ledger.size).toBe(3);
    const restored = settle([
      node("anchor", 700, 800),
      node("neighbour", 1_000, 1_100, { type: "method" }),
    ], hidden.ledger);
    expect(byDepthAndId(restored.nodes, undefined, "neighbour").position).toEqual({ x: 140, y: 70 });
  });

  it("moves only a new neighbour when different retained deltas would place it on an existing card", () => {
    const size = { width: 100, height: 40 };
    const first = settle([
      node("anchor", 0, 0, size),
      node("retained", 200, 0, size),
    ]);
    const expanded = settle([
      node("anchor", 1_000, 0, size),
      node("retained", 200, 0, size),
      node("frontier", 1_200, 0, { ...size, type: "ghost" }),
    ], first.ledger, [edge("anchor-frontier", "anchor", "frontier")]);

    const anchor = byDepthAndId(expanded.nodes, undefined, "anchor");
    const retained = byDepthAndId(expanded.nodes, undefined, "retained");
    const frontier = byDepthAndId(expanded.nodes, undefined, "frontier");
    expect(anchor.position).toEqual({ x: 0, y: 0 });
    expect(retained.position).toEqual({ x: 200, y: 0 });
    expect(frontier.position.x).toBe(200);
    expect(frontier.position.y).not.toBe(0);
    expect(Math.abs(frontier.position.y)).toBeGreaterThanOrEqual(58);
  });
});
