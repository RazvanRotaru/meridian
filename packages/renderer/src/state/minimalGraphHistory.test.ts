import { describe, expect, it } from "vitest";
import {
  boundMinimalGraphHistory,
  minimalGraphResidentBytes,
  type MinimalGraphHistoryEntry,
} from "./minimalGraphHistory";

function coordinate(sceneKey: string): MinimalGraphHistoryEntry {
  // The bounding policy depends only on the opaque scene identity and the caller-supplied combined
  // charge. Full coordinate cloning/restoration is covered by the store navigation tests.
  return { sceneKey } as MinimalGraphHistoryEntry;
}

describe("minimal graph navigation memory", () => {
  it("charges Set and Map contents instead of treating them as empty JSON objects", () => {
    const empty = minimalGraphResidentBytes({ ids: new Set(), positions: new Map() });
    const populated = minimalGraphResidentBytes({
      ids: new Set(Array.from({ length: 200 }, (_, index) => `node:${index}:${"x".repeat(32)}`)),
      positions: new Map(Array.from(
        { length: 200 },
        (_, index) => [`node:${index}`, { x: index, y: index * 2 }],
      )),
    });

    expect(populated).toBeGreaterThan(empty + 20_000);
  });

  it("retains the newest semantic window under independent count and byte ceilings", () => {
    const entries = ["a", "b", "c", "d"].map(coordinate);
    const charges = new Map([
      ["a", 30],
      ["b", 30],
      ["c", 30],
      ["d", 30],
    ]);

    expect(boundMinimalGraphHistory(entries, charges, {
      maxEntries: 3,
      maxResidentBytes: 1_000,
    })).toEqual({
      history: entries.slice(1),
      truncatedSceneKeys: ["a"],
      residentBytes: 90,
    });
    expect(boundMinimalGraphHistory(entries, charges, {
      maxEntries: 10,
      maxResidentBytes: 65,
    })).toEqual({
      history: entries.slice(2),
      truncatedSceneKeys: ["a", "b"],
      residentBytes: 60,
    });
  });

  it("rejects an oversized newest coordinate instead of exceeding the byte contract", () => {
    const newest = coordinate("newest");
    expect(boundMinimalGraphHistory(
      [coordinate("older"), newest],
      new Map([["older", 10], ["newest", 101]]),
      { maxEntries: 10, maxResidentBytes: 100 },
    )).toEqual({
      history: [],
      truncatedSceneKeys: ["older", "newest"],
      residentBytes: 0,
    });
  });
});
