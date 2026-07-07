/**
 * The Map's paint rules: hiding closes over a hidden frame's drawn subtree (an expanded test file
 * takes its nested unit cards with it — the Tests toggle's contract), and a selection that is no
 * longer drawn paints as no-selection instead of dimming the whole level.
 */

import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { emphasize, filterVisible } from "./moduleMapPaint";

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
    const shown = filterVisible(nodes, edges, { hiddenCategories: new Set(), showTests: false, testIds });
    expect(shown.nodes.map((n) => n.id)).toEqual(["ts:prod.ts"]);
    expect(shown.edges).toEqual([]);
  });

  it("hides an expanded file's unit cards with it when its category is toggled off", () => {
    const frame = fileNode("ts:cfg.ts", { data: { category: "config", isExpanded: true } });
    const nodes = [frame, unitNode("ts:cfg.ts#Settings", "ts:cfg.ts"), fileNode("ts:prod.ts")];
    const shown = filterVisible(nodes, [], { hiddenCategories: new Set(["config"]), showTests: true, testIds: new Set() });
    expect(shown.nodes.map((n) => n.id)).toEqual(["ts:prod.ts"]);
  });
});

describe("emphasize — stale selection", () => {
  it("paints as no-selection when the selected id is no longer drawn (frame collapsed)", () => {
    const nodes = [fileNode("ts:a.ts"), fileNode("ts:b.ts")];
    const edges = [edge("ts:a.ts", "ts:b.ts")];
    const { nodes: styled } = emphasize(nodes, edges, "ts:a.ts#Gone", 1);
    // No node dims: the vanished selection must not fade the whole level.
    expect(styled.every((node) => node.style?.opacity === undefined)).toBe(true);
  });
});
