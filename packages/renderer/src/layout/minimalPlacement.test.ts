/**
 * The minimal-graph overlay's FLAT placement: captured files keep their exact map position, uncaptured
 * files land flow-aware against ALL their placed import-neighbours (left of the leftmost file they
 * import, else right of the rightmost file that imports them), and stubs hang off their source. No ELK,
 * no frames — just absolute rects that never move a placed card.
 */

import { describe, expect, it } from "vitest";
import { placeMinimalNodes, FILE_WIDTH, FILE_HEIGHT, STUB_WIDTH, STUB_HEIGHT, GAP_X, STUB_GAP, type PlacementInput } from "./minimalPlacement";

const base = (x: number, y: number) => ({ x, y, width: FILE_WIDTH, height: FILE_HEIGHT });

describe("placeMinimalNodes", () => {
  it("keeps every captured file at its exact map position and size", () => {
    const input: PlacementInput = {
      fileIds: ["a", "b"],
      stubs: [],
      importEdges: [{ source: "a", target: "b" }],
      basePositions: { a: { x: 10, y: 20, width: 200, height: 50 }, b: { x: 400, y: 80, width: 180, height: 60 } },
    };
    const placed = placeMinimalNodes(input);
    expect(placed.a).toEqual({ x: 10, y: 20, width: 200, height: 50 });
    expect(placed.b).toEqual({ x: 400, y: 80, width: 180, height: 60 });
  });

  it("places an uncaptured importee to the RIGHT of its placed importer", () => {
    // a → b (a imports b). a is captured, b is not: b sits right of a.
    const input: PlacementInput = {
      fileIds: ["a", "b"],
      stubs: [],
      importEdges: [{ source: "a", target: "b" }],
      basePositions: { a: base(0, 0) },
    };
    const placed = placeMinimalNodes(input);
    expect(placed.b.x).toBe(FILE_WIDTH + GAP_X);
    expect(placed.b.y).toBe(0);
  });

  it("places an uncaptured importer to the LEFT of its placed importee", () => {
    // a → b (a imports b). b is captured, a is not: a sits left of b.
    const input: PlacementInput = {
      fileIds: ["a", "b"],
      stubs: [],
      importEdges: [{ source: "a", target: "b" }],
      basePositions: { b: base(500, 0) },
    };
    const placed = placeMinimalNodes(input);
    expect(placed.a.x).toBe(500 - FILE_WIDTH - GAP_X);
    expect(placed.a.y).toBe(0);
  });

  it("stacks two uncaptured neighbours of one anchor into non-overlapping vertical slots", () => {
    // a imports b and c; both uncaptured. Both go right of a, at distinct y slots.
    const input: PlacementInput = {
      fileIds: ["a", "b", "c"],
      stubs: [],
      importEdges: [{ source: "a", target: "b" }, { source: "a", target: "c" }],
      basePositions: { a: base(0, 0) },
    };
    const placed = placeMinimalNodes(input);
    expect(placed.b.x).toBe(FILE_WIDTH + GAP_X);
    expect(placed.c.x).toBe(FILE_WIDTH + GAP_X);
    expect(placed.b.y).not.toBe(placed.c.y);
    // Neither overlaps the other vertically.
    expect(Math.abs(placed.b.y - placed.c.y)).toBeGreaterThanOrEqual(FILE_HEIGHT);
  });

  it("places an importer LEFT of the leftmost of its several placed importees", () => {
    // app imports BOTH rec and cat; rec is captured left, cat captured to its right. app is a caller
    // of both, so in left-to-right flow it must sit LEFT of rec (its leftmost import), not between them.
    const input: PlacementInput = {
      fileIds: ["app", "rec", "cat"],
      stubs: [],
      importEdges: [{ source: "app", target: "rec" }, { source: "app", target: "cat" }],
      basePositions: { rec: base(300, 0), cat: base(700, 0) },
    };
    const placed = placeMinimalNodes(input);
    expect(placed.app.x).toBe(300 - FILE_WIDTH - GAP_X);
    expect(placed.app.x).toBeLessThan(placed.rec.x);
    expect(placed.app.x).toBeLessThan(placed.cat.x);
    expect(placed.app.y).toBe(0);
  });

  it("places a callee RIGHT of the rightmost of its several placed importers", () => {
    // both p and q import util; p captured left, q captured to its right. util is their callee, so it
    // sits RIGHT of q (the rightmost importer), past its right edge.
    const input: PlacementInput = {
      fileIds: ["p", "q", "util"],
      stubs: [],
      importEdges: [{ source: "p", target: "util" }, { source: "q", target: "util" }],
      basePositions: { p: base(0, 0), q: base(400, 0) },
    };
    const placed = placeMinimalNodes(input);
    expect(placed.util.x).toBe(400 + FILE_WIDTH + GAP_X);
    expect(placed.util.x).toBeGreaterThan(placed.q.x);
    expect(placed.util.y).toBe(0);
  });

  it("places a file connected only through another placed uncaptured file (transitive growth)", () => {
    // a (captured) → b → c. b lands right of a, then c lands right of b.
    const input: PlacementInput = {
      fileIds: ["a", "b", "c"],
      stubs: [],
      importEdges: [{ source: "a", target: "b" }, { source: "b", target: "c" }],
      basePositions: { a: base(0, 0) },
    };
    const placed = placeMinimalNodes(input);
    expect(placed.b.x).toBe(FILE_WIDTH + GAP_X);
    expect(placed.c.x).toBe(placed.b.x + FILE_WIDTH + GAP_X);
  });

  it("puts a fully disconnected file in a spare column right of the bounding box", () => {
    const input: PlacementInput = {
      fileIds: ["a", "lonely"],
      stubs: [],
      importEdges: [],
      basePositions: { a: base(0, 0) },
    };
    const placed = placeMinimalNodes(input);
    expect(placed.lonely.x).toBe(FILE_WIDTH + GAP_X);
  });

  it("hangs the single stub to the right of its source, vertically centred", () => {
    const input: PlacementInput = {
      fileIds: ["a"],
      stubs: [{ id: "s", sourceId: "a" }],
      importEdges: [],
      basePositions: { a: { x: 0, y: 0, width: 200, height: 60 } },
    };
    const placed = placeMinimalNodes(input);
    expect(placed["s"]).toEqual({ x: 200 + STUB_GAP, y: 60 / 2 - STUB_HEIGHT / 2, width: STUB_WIDTH, height: STUB_HEIGHT });
  });

  it("skips a stub whose source was never placed", () => {
    const input: PlacementInput = {
      fileIds: [],
      stubs: [{ id: "s", sourceId: "missing" }],
      importEdges: [],
      basePositions: {},
    };
    expect(placeMinimalNodes(input).s).toBeUndefined();
  });
});
