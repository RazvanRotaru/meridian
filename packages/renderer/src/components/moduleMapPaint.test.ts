/**
 * The Map's paint rules: hiding closes over a hidden frame's drawn subtree (an expanded test file
 * takes its nested unit cards with it — the Tests toggle's contract), and a selection that is no
 * longer drawn paints as no-selection instead of dimming the whole level.
 */

import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { emphasize, filterVisible, type HideOptions } from "./moduleMapPaint";

/** Baseline options with nothing hidden; tests override the one filter they exercise. */
const SHOW_ALL: HideOptions = {
  hiddenCategories: new Set(),
  showTests: true,
  testIds: new Set(),
  showPrivate: true,
  privateIds: new Set(),
};

function fileNode(id: string, extra?: Partial<Node>): Node {
  return { id, type: "file", position: { x: 0, y: 0 }, data: { category: "app", isExpanded: false }, ...extra } as Node;
}

function unitNode(id: string, parentId: string): Node {
  return { id, type: "unit", position: { x: 0, y: 0 }, parentId, data: { unitKind: "class" } } as Node;
}

function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target, data: {} } as Edge;
}

describe("filterVisible — subtree closure", () => {
  it("hides an expanded test file's frame AND its nested unit cards when tests are hidden", () => {
    const frame = fileNode("ts:t.test.ts", { data: { category: "app", isExpanded: true } });
    const nodes = [frame, unitNode("ts:t.test.ts#Helper", "ts:t.test.ts"), fileNode("ts:prod.ts")];
    const edges = [edge("ts:t.test.ts", "ts:prod.ts"), edge("ts:t.test.ts#Helper", "ts:prod.ts")];
    const testIds = new Set(["ts:t.test.ts", "ts:t.test.ts#Helper"]);
    const shown = filterVisible(nodes, edges, { ...SHOW_ALL, showTests: false, testIds });
    expect(shown.nodes.map((n) => n.id)).toEqual(["ts:prod.ts"]);
    expect(shown.edges).toEqual([]);
  });

  it("hides an expanded file's unit cards with it when its category is toggled off", () => {
    const frame = fileNode("ts:cfg.ts", { data: { category: "config", isExpanded: true } });
    const nodes = [frame, unitNode("ts:cfg.ts#Settings", "ts:cfg.ts"), fileNode("ts:prod.ts")];
    const shown = filterVisible(nodes, [], { ...SHOW_ALL, hiddenCategories: new Set(["config"]) });
    expect(shown.nodes.map((n) => n.id)).toEqual(["ts:prod.ts"]);
  });

  it("hides private blocks (and their wires) in place when the Private toggle is off", () => {
    const frame = fileNode("ts:svc.ts", { data: { category: "app", isExpanded: true } });
    const priv: Node = { id: "ts:svc.ts#S.helper", type: "block", position: { x: 0, y: 0 }, parentId: "ts:svc.ts", data: { blockKind: "method" } } as Node;
    const pub: Node = { id: "ts:svc.ts#S.run", type: "block", position: { x: 0, y: 0 }, parentId: "ts:svc.ts", data: { blockKind: "method" } } as Node;
    const nodes = [frame, priv, pub];
    const edges = [edge("ts:svc.ts#S.run", "ts:svc.ts#S.helper")];
    const shown = filterVisible(nodes, edges, { ...SHOW_ALL, showPrivate: false, privateIds: new Set(["ts:svc.ts#S.helper"]) });
    // The private block vanishes IN PLACE — the frame and its sibling keep their positions.
    expect(shown.nodes.map((n) => n.id)).toEqual(["ts:svc.ts", "ts:svc.ts#S.run"]);
    expect(shown.edges).toEqual([]);
  });
});

describe("emphasize — beacon read (a selected call step's definition)", () => {
  it("withholds the step's dep wire, rings the definition, and flips a ghost's border", () => {
    const frame = fileNode("ts:svc.ts", { data: { category: "app", isExpanded: true } });
    const step: Node = { id: "step:ts:svc.ts#S.run:0", type: "step", position: { x: 0, y: 0 }, parentId: "ts:svc.ts", data: { stepKind: "call" } } as Node;
    const ghost: Node = { id: "ts:pay.ts#Gateway.charge", type: "ghost", position: { x: 0, y: 0 }, data: { label: "Gateway.charge" } } as Node;
    const dep: Edge = { id: "gdep:step->ghost", source: step.id, target: ghost.id, data: { category: "dep", ghost: true } } as Edge;
    const other: Edge = { id: "lvl:a->b", source: "ts:svc.ts", target: ghost.id, data: {} } as Edge;
    const { edges, nodes, beacons } = emphasize([frame, step, ghost], [dep, other], new Set([step.id]), 1, "reach");
    expect(beacons).toEqual(new Set([ghost.id]));
    // Dep wires are now the primary always-visible layer, so the beacon wire is withheld VISUALLY
    // (opacity 0) rather than removed: the definition reads through the ring, not a dangling wire.
    expect(edges.find((e) => e.id === dep.id)?.style?.opacity).toBe(0);
    expect(edges.find((e) => e.id === other.id)?.style?.opacity).not.toBe(0);
    const ringed = nodes.find((n) => n.id === ghost.id);
    expect(ringed?.style?.boxShadow).toContain("#6BE38A");
    expect((ringed?.data as { beacon?: boolean }).beacon).toBe(true);
  });

  it("keeps every wire and reports no beacons for a non-step selection", () => {
    const a = fileNode("ts:a.ts");
    const b = fileNode("ts:b.ts");
    const wire = edge("ts:a.ts", "ts:b.ts");
    const { beacons, edges } = emphasize([a, b], [wire], new Set(["ts:a.ts"]), 1, "reach");
    expect(beacons.size).toBe(0);
    expect(edges[0].style?.opacity).not.toBe(0);
  });
});

describe("emphasize — stale selection", () => {
  it("paints as no-selection when the selected id is no longer drawn (frame collapsed)", () => {
    const nodes = [fileNode("ts:a.ts"), fileNode("ts:b.ts")];
    const edges = [edge("ts:a.ts", "ts:b.ts")];
    const { nodes: styled } = emphasize(nodes, edges, new Set(["ts:a.ts#Gone"]), 1, "reach");
    // No node dims: the vanished selection must not fade the whole level.
    expect(styled.every((node) => node.style?.opacity === undefined)).toBe(true);
  });
});
