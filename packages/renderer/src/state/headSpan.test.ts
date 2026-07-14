import { describe, expect, it } from "vitest";
import { headKindsWithin, headSpanFor, mapBaseLineToHead } from "./headSpan";
import type { LineEdit } from "./prTypes";

// One exact edit run that turns base lines 5-6 into head lines 5-9 (net +3): everything after it shifts down 3.
const EDITS: LineEdit[] = [{ oldStart: 5, oldLines: 2, newStart: 5, newLines: 5 }];

describe("mapBaseLineToHead", () => {
  it("leaves lines before the hunk untouched", () => {
    expect(mapBaseLineToHead(3, EDITS)).toBe(3);
  });

  it("shifts lines after the hunk by the hunk's net line delta", () => {
    expect(mapBaseLineToHead(10, EDITS)).toBe(13); // +3
  });

  it("maps a line inside the hunk onto the new side, clamped to the new range", () => {
    expect(mapBaseLineToHead(5, EDITS)).toBe(5);
    expect(mapBaseLineToHead(6, EDITS)).toBe(6);
  });

  it("shifts trailing context inside what was one U3 hunk after an exact insertion run", () => {
    const insertion: LineEdit[] = [{ oldStart: 14, oldLines: 0, newStart: 14, newLines: 1 }];
    expect(mapBaseLineToHead(13, insertion)).toBe(13);
    expect(mapBaseLineToHead(14, insertion)).toBe(15);
    expect(mapBaseLineToHead(16, insertion)).toBe(17);
  });

  it("is the identity when there are no edits", () => {
    expect(mapBaseLineToHead(42, [])).toBe(42);
  });
});

describe("headSpanFor", () => {
  it("maps a node's base span to its shifted head span", () => {
    expect(headSpanFor(10, 20, EDITS)).toEqual({ start: 13, end: 23 });
  });

  it("includes every new row in a replacement that expands inside the node", () => {
    expect(headSpanFor(5, 6, EDITS)).toEqual({ start: 5, end: 9 });
  });

  it("includes an insertion immediately before the node's first base row", () => {
    const insertion: LineEdit[] = [{ oldStart: 14, oldLines: 0, newStart: 14, newLines: 1 }];
    expect(headSpanFor(14, 16, insertion)).toEqual({ start: 14, end: 17 });
  });
});

describe("headKindsWithin", () => {
  it("keeps only the change kinds that fall inside the span, as a per-line map", () => {
    const map = headKindsWithin(
      [
        { start: 14, end: 15, kind: "added" },
        { start: 40, end: 40, kind: "modified" },
      ],
      13,
      23,
    );
    expect([...map.entries()]).toEqual([
      [14, "added"],
      [15, "added"],
    ]);
  });
});
