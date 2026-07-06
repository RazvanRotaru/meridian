/**
 * The concentric-ring layout: determinism, the parent-before-child emission React Flow needs, the
 * centred single/entry frame, non-overlapping frames on a two-ring fixture, and the empty case.
 * Specs are built by hand so the geometry is pinned without a real artifact.
 */

import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import type { ModuleCardData, ModuleMapSpec } from "../derive/moduleMap";
import { layoutModuleMap } from "./moduleRingLayout";

function frame(id: string, ring: number, fileCount: number): ModuleMapSpec["frames"][number] {
  return { id, ring, data: { label: id, fileCount, ring } };
}

function file(id: string, frameId: string, depth: number): ModuleMapSpec["files"][number] {
  const data: ModuleCardData = { label: id, fullPath: id, category: "app", depth, inCount: 0, outCount: 0, isEntry: false };
  return { id, frameId, data };
}

function spec(partial: Partial<ModuleMapSpec>): ModuleMapSpec {
  return { files: [], frames: [], edges: [], rootId: "root", maxObservedDepth: 0, ...partial };
}

// One centre frame plus two frames on ring 1 — the smallest fixture with real angular placement.
function twoRingSpec(): ModuleMapSpec {
  return spec({
    frames: [frame("F0", 0, 2), frame("F1", 1, 1), frame("F2", 1, 1)],
    files: [file("a", "F0", 0), file("b", "F0", 0), file("c", "F1", 1), file("d", "F2", 1)],
    maxObservedDepth: 1,
  });
}

function frameNodes(nodes: Node[]): Node[] {
  return nodes.filter((node) => node.type === "frame");
}

function rect(node: Node) {
  const style = node.style as { width: number; height: number };
  return { x: node.position.x, y: node.position.y, w: style.width, h: style.height };
}

function overlaps(a: ReturnType<typeof rect>, b: ReturnType<typeof rect>): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// A frame's centre distance from the origin — its ring's effective radius, used to assert that outer
// rings sit strictly outside inner ones.
function centerDist(node: Node): number {
  const box = rect(node);
  return Math.hypot(box.x + box.w / 2, box.y + box.h / 2);
}

// An over-crowded ring 1 (20 frames) whose circumference floor balloons its radius PAST ring 2's
// nominal radius — the exact case that inverts depth unless outer rings are pushed to clear inner
// ones. One lone frame on ring 2 should still land outside every ring-1 frame.
function overFullInnerSpec(): ModuleMapSpec {
  const inner = Array.from({ length: 20 }, (_, i) => frame(`I${i}`, 1, 1));
  const innerFiles = inner.map((f) => file(`if-${f.id}`, f.id, 1));
  return spec({
    frames: [...inner, frame("O", 2, 1)],
    files: [...innerFiles, file("of", "O", 2)],
    maxObservedDepth: 2,
  });
}

describe("layoutModuleMap", () => {
  it("returns empty arrays for an empty spec", () => {
    expect(layoutModuleMap(spec({}))).toEqual({ nodes: [], edges: [] });
  });

  it("centres a single frame on the origin with its card nested inside", () => {
    const { nodes } = layoutModuleMap(spec({ frames: [frame("only", 0, 1)], files: [file("a", "only", 0)] }));
    const box = rect(nodes.find((node) => node.id === "only") as Node);
    expect(box.x + box.w / 2).toBeCloseTo(0);
    expect(box.y + box.h / 2).toBeCloseTo(0);
    const card = nodes.find((node) => node.id === "a") as Node;
    expect(card).toMatchObject({ type: "file", parentId: "only", extent: "parent" });
  });

  it("emits every frame before the cards that nest in it", () => {
    const { nodes } = layoutModuleMap(twoRingSpec());
    for (const card of nodes.filter((node) => node.type === "file")) {
      const parentIndex = nodes.findIndex((node) => node.id === card.parentId);
      const cardIndex = nodes.findIndex((node) => node.id === card.id);
      expect(parentIndex).toBeGreaterThanOrEqual(0);
      expect(parentIndex).toBeLessThan(cardIndex);
    }
  });

  it("is deterministic — the same spec lays out identically", () => {
    expect(layoutModuleMap(twoRingSpec())).toEqual(layoutModuleMap(twoRingSpec()));
  });

  it("places frames without overlap across two rings", () => {
    const frames = frameNodes(layoutModuleMap(twoRingSpec()).nodes).map(rect);
    for (let i = 0; i < frames.length; i += 1) {
      for (let j = i + 1; j < frames.length; j += 1) {
        expect(overlaps(frames[i], frames[j])).toBe(false);
      }
    }
  });

  it("keeps an outer ring outside an over-crowded inner ring (no depth inversion)", () => {
    const frames = frameNodes(layoutModuleMap(overFullInnerSpec()).nodes);
    const outer = frames.find((node) => node.id === "O") as Node;
    const innerFrames = frames.filter((node) => node.id.startsWith("I"));
    const innerMaxDist = Math.max(...innerFrames.map(centerDist));
    // The lone ring-2 frame must sit farther out than every crowded ring-1 frame...
    expect(centerDist(outer)).toBeGreaterThan(innerMaxDist);
    // ...and must not overlap any of them (the visual symptom of an inversion).
    for (const inner of innerFrames) {
      expect(overlaps(rect(outer), rect(inner))).toBe(false);
    }
  });

  it("does not produce NaN positions for a single dense frame", () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`f${i}`, "big", 0));
    const { nodes } = layoutModuleMap(spec({ frames: [frame("big", 0, 20)], files }));
    for (const node of nodes) {
      expect(Number.isNaN(node.position.x)).toBe(false);
      expect(Number.isNaN(node.position.y)).toBe(false);
    }
  });
});
