/**
 * Persistence of review progress: the v1 → v2 migration (flow ticks survive, new fields default
 * empty), the v2 round-trip, and the malformed-record fallback. localStorage is stubbed — the
 * module's guards make every read best-effort.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readReviewProgress, writeReviewProgress, type ReviewProgress } from "./reviewTicksPref";

function stubStorage(initial: Record<string, string> = {}): Record<string, string> {
  const data = { ...initial };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => (key in data ? data[key] : null),
      setItem: (key: string, value: string) => {
        data[key] = value;
      },
      removeItem: (key: string) => {
        delete data[key];
      },
    },
  });
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readReviewProgress", () => {
  it("migrates a v1 record forward, keeping its flow ticks", () => {
    stubStorage({ "meridian.review.scope": JSON.stringify({ version: 1, ticks: { flow: { at: "t", fingerprint: "f" } } }) });
    expect(readReviewProgress("scope")).toEqual({
      version: 2,
      ticks: { flow: { at: "t", fingerprint: "f" } },
      unitTicks: {},
      fileTicks: {},
      comments: [],
    });
  });

  it("round-trips a v2 record whole", () => {
    stubStorage();
    const progress: ReviewProgress = {
      version: 2,
      ticks: { flow: { at: "t", fingerprint: "f" } },
      unitTicks: { unit: { at: "t", fingerprint: "u" } },
      fileTicks: { "a.ts": { at: "t", fingerprint: "h" } },
      comments: [{ id: "1", path: "a.ts", nodeId: null, anchorLabel: null, body: "note", at: "t" }],
    };
    writeReviewProgress("scope", progress);
    expect(readReviewProgress("scope")).toEqual(progress);
  });

  it("falls back to empty on malformed or unknown-version records, and without a window", () => {
    stubStorage({ "meridian.review.scope": "not json" });
    expect(readReviewProgress("scope").ticks).toEqual({});
    stubStorage({ "meridian.review.scope": JSON.stringify({ version: 9, ticks: {} }) });
    expect(readReviewProgress("scope")).toEqual({ version: 2, ticks: {}, unitTicks: {}, fileTicks: {}, comments: [] });
    vi.unstubAllGlobals();
    expect(readReviewProgress("scope").comments).toEqual([]);
  });

  it("drops malformed comment elements so one corrupt draft cannot poison the submission", () => {
    const good = { id: "1", path: "a.ts", nodeId: null, anchorLabel: null, body: "note", at: "t" };
    const bad = { id: "2", path: "a.ts", nodeId: null, anchorLabel: null, body: 123, at: "t" };
    stubStorage({
      "meridian.review.scope": JSON.stringify({ version: 2, ticks: {}, unitTicks: {}, fileTicks: {}, comments: [good, bad, "junk"] }),
    });
    expect(readReviewProgress("scope").comments).toEqual([good]);
  });
});
