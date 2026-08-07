import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SOURCE_DOCK_RATIO,
  readSourceDockRatio,
  writeSourceDockRatio,
} from "./sourceDockPreference";

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

afterEach(() => vi.unstubAllGlobals());

describe("source dock preference", () => {
  it("round-trips a versioned preferred ratio", () => {
    const storage = stubStorage();
    writeSourceDockRatio(0.72);
    expect(JSON.parse(storage.value ?? "null")).toEqual({ version: 1, ratio: 0.72 });
    expect(readSourceDockRatio()).toBe(0.72);
  });

  it("clamps persisted values to supported product bounds", () => {
    const storage = stubStorage();
    writeSourceDockRatio(4);
    expect(readSourceDockRatio()).toBe(0.9);
    storage.value = JSON.stringify({ version: 1, ratio: -2 });
    expect(readSourceDockRatio()).toBe(0.4);
  });

  it("defaults malformed, unknown, absent, and blocked storage", () => {
    const storage = stubStorage("not json");
    expect(readSourceDockRatio()).toBe(DEFAULT_SOURCE_DOCK_RATIO);
    storage.value = JSON.stringify({ version: 2, ratio: 0.7 });
    expect(readSourceDockRatio()).toBe(DEFAULT_SOURCE_DOCK_RATIO);
    storage.value = null;
    expect(readSourceDockRatio()).toBe(DEFAULT_SOURCE_DOCK_RATIO);

    vi.stubGlobal("window", undefined);
    expect(readSourceDockRatio()).toBe(DEFAULT_SOURCE_DOCK_RATIO);
    expect(() => writeSourceDockRatio(0.7)).not.toThrow();

    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
    });
    expect(readSourceDockRatio()).toBe(DEFAULT_SOURCE_DOCK_RATIO);
    expect(() => writeSourceDockRatio(0.7)).not.toThrow();
  });
});
