import { afterEach, describe, expect, it, vi } from "vitest";
import { readSolidMetricsPref, writeSolidMetricsPref } from "./solidMetricsPref";

function fakeWindow(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("solidMetricsPref", () => {
  it("defaults to metrics shown when nothing is stored", () => {
    vi.stubGlobal("window", fakeWindow());
    expect(readSolidMetricsPref()).toBe(true);
  });

  it("reads false only for the explicit \"false\" string", () => {
    vi.stubGlobal("window", fakeWindow({ "meridian.showSolidMetrics": "false" }));
    expect(readSolidMetricsPref()).toBe(false);
  });

  it("round-trips a written value", () => {
    vi.stubGlobal("window", fakeWindow());
    writeSolidMetricsPref(false);
    expect(readSolidMetricsPref()).toBe(false);
    writeSolidMetricsPref(true);
    expect(readSolidMetricsPref()).toBe(true);
  });

  it("defaults to shown when localStorage is unavailable", () => {
    vi.stubGlobal("window", undefined);
    expect(readSolidMetricsPref()).toBe(true);
    expect(() => writeSolidMetricsPref(false)).not.toThrow();
  });
});
