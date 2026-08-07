import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSourceWindowPreference,
  resetSourceWindowPreference,
  writeSourceWindowPreference,
} from "./sourceWindowPreference";

function stubStorage(initial: string | null = null): { value: string | null } {
  const data = { value: initial };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => data.value,
      setItem: (_key: string, value: string) => { data.value = value; },
    },
  });
  return data;
}

beforeEach(() => {
  stubStorage();
  resetSourceWindowPreference();
});

afterEach(() => vi.unstubAllGlobals());

describe("source window preference", () => {
  it("round-trips user-committed shell-local CSS pixels", () => {
    const storage = stubStorage();
    const rect = { x: 42.5, y: 18, width: 1_043.25, height: 611 };

    expect(writeSourceWindowPreference(rect)).toEqual({ version: 2, rect });
    expect(JSON.parse(storage.value ?? "null")).toEqual({ version: 2, rect });
    expect(readSourceWindowPreference()).toEqual({ version: 2, rect });
  });

  it.each([
    { version: 1, ratio: 0.72 },
    { version: 2, ratio: 0.72, placement: "left", sticky: true },
  ])("migrates incompatible $version storage to responsive defaults", (legacy) => {
    const storage = stubStorage(JSON.stringify(legacy));

    expect(readSourceWindowPreference()).toEqual({ version: 2, rect: null });
    expect(JSON.parse(storage.value ?? "null")).toEqual({ version: 2, rect: null });
  });

  it("defaults and rewrites malformed or invalid rectangles", () => {
    for (const value of [
      "not json",
      JSON.stringify({ version: 2 }),
      JSON.stringify({ version: 2, rect: { x: 1, y: 2, width: -3, height: 4 } }),
      JSON.stringify({ version: 2, rect: { x: Number.NaN, y: 2, width: 3, height: 4 } }),
      JSON.stringify({ version: 9, rect: null }),
    ]) {
      const storage = stubStorage(value);
      expect(readSourceWindowPreference()).toEqual({ version: 2, rect: null });
      expect(JSON.parse(storage.value ?? "null")).toEqual({ version: 2, rect: null });
    }
  });

  it("resets custom geometry and returns the resulting preference", () => {
    const storage = stubStorage();
    writeSourceWindowPreference({ x: 30, y: 20, width: 800, height: 600 });

    expect(resetSourceWindowPreference()).toEqual({ version: 2, rect: null });
    expect(JSON.parse(storage.value ?? "null")).toEqual({ version: 2, rect: null });
  });

  it("retains writes and resets in memory when localStorage is blocked", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
    });
    const rect = { x: 90, y: 70, width: 740, height: 520 };

    expect(writeSourceWindowPreference(rect)).toEqual({ version: 2, rect });
    expect(readSourceWindowPreference()).toEqual({ version: 2, rect });
    expect(resetSourceWindowPreference()).toEqual({ version: 2, rect: null });
    expect(readSourceWindowPreference()).toEqual({ version: 2, rect: null });
  });

  it.each([null, JSON.stringify({
    version: 2,
    rect: { x: 10, y: 10, width: 500, height: 400 },
  })])("keeps memory authoritative when reads work but writes fail", (stored) => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => stored,
        setItem: () => { throw new Error("write blocked"); },
      },
    });
    const rect = { x: 90, y: 70, width: 740, height: 520 };

    expect(writeSourceWindowPreference(rect)).toEqual({ version: 2, rect });
    expect(readSourceWindowPreference()).toEqual({ version: 2, rect });
  });

  it("returns defensive copies instead of exposing the in-memory fallback", () => {
    const first = writeSourceWindowPreference({ x: 1, y: 2, width: 500, height: 400 });
    first.rect!.x = 999;

    expect(readSourceWindowPreference()).toEqual({
      version: 2,
      rect: { x: 1, y: 2, width: 500, height: 400 },
    });
  });
});
