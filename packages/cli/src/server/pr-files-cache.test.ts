import { describe, expect, it } from "vitest";
import { PrFilesCache, type PrFilesCacheEntry } from "./pr-files-cache";

describe("PrFilesCache", () => {
  it("evicts the least-recently-used entry by count and touches entries on get", () => {
    const cache = new PrFilesCache({ maxEntries: 2, maxBytes: 16_384 });
    cache.set("first", entry("src/first.ts"));
    cache.set("second", entry("src/second.ts"));

    expect(cache.get("first")).toEqual(entry("src/first.ts"));
    cache.set("third", entry("src/third.ts"));

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toEqual(entry("src/first.ts"));
    expect(cache.get("third")).toEqual(entry("src/third.ts"));
  });

  it("evicts by resident UTF-8 bytes before the entry limit", () => {
    const cache = new PrFilesCache({ maxEntries: 10, maxBytes: 300 });
    cache.set("first", entry("src/first.ts"));
    cache.set("second", entry("src/second.ts"));

    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("second")).toEqual(entry("src/second.ts"));
  });

  it("skips an oversized entry and removes the previous value for the same key", () => {
    const cache = new PrFilesCache({ maxEntries: 10, maxBytes: 256 });
    cache.set("pull", entry("src/small.ts"));
    expect(cache.get("pull")).toEqual(entry("src/small.ts"));

    cache.set("pull", entry(`src/${"wide/".repeat(100)}file.ts`));

    expect(cache.get("pull")).toBeUndefined();
    expect(cache.delete("pull")).toBe(false);
  });
});

function entry(path: string): PrFilesCacheEntry {
  return {
    updatedAt: "2026-07-17T00:00:00Z",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    paths: [path],
  };
}
