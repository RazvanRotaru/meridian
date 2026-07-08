/**
 * The minimal-graph overlay's FLAT placement: captured files keep their exact map position, uncaptured
 * files land beside a connected placed file (right when it imports them, left when they import it), and
 * stubs hang off their source. No ELK, no frames — just absolute rects that never move a placed card.
 */

import { describe, expect, it } from "vitest";
import { placeMinimalNodes, FILE_WIDTH, FILE_HEIGHT, STUB_WIDTH, STUB_HEIGHT, GAP_X, type PlacementInput } from "./minimalPlacement";

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

  it("hangs an out-stub to the right and an in-stub to the left of its source, vertically centred", () => {
    const input: PlacementInput = {
      fileIds: ["a"],
      stubs: [
        { id: "s-out", sourceId: "a", direction: "out" },
        { id: "s-in", sourceId: "a", direction: "in" },
      ],
      importEdges: [],
      basePositions: { a: { x: 0, y: 0, width: 200, height: 60 } },
    };
    const placed = placeMinimalNodes(input);
    expect(placed["s-out"]).toEqual({ x: 200 + GAP_X / 2, y: 60 / 2 - STUB_HEIGHT / 2, width: STUB_WIDTH, height: STUB_HEIGHT });
    expect(placed["s-in"]).toEqual({ x: 0 - STUB_WIDTH - GAP_X / 2, y: 60 / 2 - STUB_HEIGHT / 2, width: STUB_WIDTH, height: STUB_HEIGHT });
  });

  it("skips a stub whose source was never placed", () => {
    const input: PlacementInput = {
      fileIds: [],
      stubs: [{ id: "s", sourceId: "missing", direction: "out" }],
      importEdges: [],
      basePositions: {},
    };
    expect(placeMinimalNodes(input).s).toBeUndefined();
  });
});
