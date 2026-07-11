import { describe, expect, it } from "vitest";
import {
  bandGhostsOutside,
  MAX_GHOST_ROWS_PER_COLUMN,
  placeGhostHierarchy,
  type GhostHierarchyGroup,
  type GhostItem,
  type Rect,
} from "./ghostBandPlacement";

const BOX = { x: 100, y: 100, width: 300, height: 180 };

function ghosts(side: "left" | "right", count: number): GhostItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${side}:${index.toString().padStart(2, "0")}`,
    side,
    anchorCx: 250,
    anchorCy: 120 + index * 5,
    width: 180,
    height: 42,
  }));
}

describe("bandGhostsOutside", () => {
  it("keeps small lanes in one ordered, non-overlapping column outside the core", () => {
    const items = ghosts("right", 3);
    const positions = bandGhostsOutside(BOX, items);
    const placed = items.map((item) => ({ ...positions.get(item.id)!, ...item }));

    expect(new Set(placed.map((item) => item.x)).size).toBe(1);
    expect(placed.every((item) => item.x >= BOX.x + BOX.width)).toBe(true);
    expect(placed[1].y).toBeGreaterThanOrEqual(placed[0].y + placed[0].height);
    expect(placed[2].y).toBeGreaterThanOrEqual(placed[1].y + placed[1].height);
  });

  it("shows every high-degree ghost in bounded-height columns that grow outward", () => {
    const count = MAX_GHOST_ROWS_PER_COLUMN * 3 + 1;
    const items = ghosts("left", count);
    const positions = bandGhostsOutside(BOX, items);

    expect(positions.size).toBe(count);
    const columns = new Map<number, number[]>();
    for (const item of items) {
      const position = positions.get(item.id)!;
      const rows = columns.get(position.x) ?? [];
      rows.push(position.y);
      columns.set(position.x, rows);
      expect(position.x + item.width).toBeLessThan(BOX.x);
    }
    expect(columns.size).toBe(4);
    expect([...columns.values()].every((rows) => rows.length <= MAX_GHOST_ROWS_PER_COLUMN)).toBe(true);
    const xs = [...columns.keys()].sort((a, b) => b - a);
    expect(xs[1]).toBeLessThan(xs[0]);
    expect(xs[2]).toBeLessThan(xs[1]);
    expect(xs[3]).toBeLessThan(xs[2]);
  });

  it("reserves the outer column for expandable parent anchors on both sides", () => {
    for (const side of ["left", "right"] as const) {
      const regular = ghosts(side, 7);
      const parents = ghosts(side, 2).map((item, index) => ({
        ...item,
        id: `${side}:parent:${index}`,
        anchorCy: 80 + index,
        outerColumn: true,
      }));
      const positions = bandGhostsOutside(BOX, [...parents, ...regular]);
      const regularX = new Set(regular.map((item) => positions.get(item.id)!.x));
      const parentX = new Set(parents.map((item) => positions.get(item.id)!.x));

      expect(regularX.size).toBe(1);
      expect(parentX.size).toBe(1);
      if (side === "right") {
        expect(Math.min(...parentX)).toBeGreaterThan(Math.max(...regularX));
      } else {
        expect(Math.max(...parentX)).toBeLessThan(Math.min(...regularX));
      }
    }
  });

  it("uses the minimum number of columns when ordinary ghosts share spare outer capacity", () => {
    for (const side of ["left", "right"] as const) {
      const regular = ghosts(side, 9);
      const parent = { ...ghosts(side, 1)[0], id: `${side}:parent`, outerColumn: true };
      const positions = bandGhostsOutside(BOX, [parent, ...regular]);
      const xs = [...new Set([parent, ...regular].map((item) => positions.get(item.id)!.x))];
      const parentX = positions.get(parent.id)!.x;

      expect(xs).toHaveLength(2);
      expect(parentX).toBe(side === "right" ? Math.max(...xs) : Math.min(...xs));
    }
  });

  it("is deterministic regardless of input order", () => {
    const items = [...ghosts("left", 11), ...ghosts("right", 11)].map((item, index) => ({
      ...item,
      ...(index % 7 === 0 ? { outerColumn: true } : {}),
    }));
    const forward = bandGhostsOutside(BOX, [...items]);
    const reverse = bandGhostsOutside(BOX, [...items].reverse());
    expect([...reverse]).toEqual([...forward]);
  });
});

describe("placeGhostHierarchy", () => {
  const rightParent: Rect = { x: 500, y: 120, width: 190, height: 54 };
  const leftParent: Rect = { x: -190, y: 300, width: 190, height: 54 };
  const members = (prefix: string) => Array.from({ length: 10 }, (_, index) => ({
    id: `${prefix}:${index.toString().padStart(2, "0")}`,
    width: 170 + (index % 2) * 10,
    height: 42,
  }));

  const groups = (): GhostHierarchyGroup[] => [
    { parentId: "group:right", side: "right", parent: rightParent, members: members("right") },
    { parentId: "group:left", side: "left", parent: leftParent, members: members("left") },
  ];

  it("fans every member farther outward on the parent's mirrored side without overlaps", () => {
    // Block each first-choice member column so collision handling must move the family outward.
    const occupied: Rect[] = [
      rightParent,
      leftParent,
      { x: rightParent.x + rightParent.width + 38, y: -100, width: 180, height: 600 },
      { x: leftParent.x - 38 - 180, y: 100, width: 180, height: 600 },
    ];
    const placement = placeGhostHierarchy(groups(), occupied);
    const memberById = new Map(groups().flatMap((group) => group.members).map((member) => [member.id, member]));
    const rects = [...placement].map(([id, position]) => ({ ...position, ...memberById.get(id)! }));

    expect(placement.size).toBe(20);
    expect(rects.filter((rect) => rect.id.startsWith("right:")).every((rect) => rect.x > rightParent.x + rightParent.width)).toBe(true);
    expect(rects.filter((rect) => rect.id.startsWith("left:")).every((rect) => rect.x + rect.width < leftParent.x)).toBe(true);
    for (let i = 0; i < rects.length; i += 1) {
      expect(occupied.every((rect) => !overlaps(rects[i], rect))).toBe(true);
      for (let j = i + 1; j < rects.length; j += 1) {
        expect(overlaps(rects[i], rects[j])).toBe(false);
      }
    }
  });

  it("is deterministic regardless of group and member input order", () => {
    const forward = placeGhostHierarchy(groups());
    const reversed = groups()
      .reverse()
      .map((group) => ({ ...group, members: [...group.members].reverse() }));
    expect([...placeGhostHierarchy(reversed)]).toEqual([...forward]);
  });
});

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
