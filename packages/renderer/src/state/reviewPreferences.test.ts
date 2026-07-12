import { afterEach, describe, expect, it, vi } from "vitest";
import { LOGIC_VIEW_MODES } from "../derive/flowViewModel";
import {
  DEFAULT_REVIEW_PREFERENCES,
  readReviewPreferences,
  writeReviewPreferences,
  type ReviewPreferences,
} from "./reviewPreferences";

function stubStorage(initial: Record<string, string> = {}): Record<string, string> {
  const data = { ...initial };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => (key in data ? data[key] : null),
      setItem: (key: string, value: string) => {
        data[key] = value;
      },
    },
  });
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reviewPreferences", () => {
  it("defaults the logic-flow split to Timeline when no preference is stored", () => {
    stubStorage();

    expect(readReviewPreferences()).toEqual({ version: 1, flowSplitView: "timeline" });
    expect(DEFAULT_REVIEW_PREFERENCES.flowSplitView).toBe("timeline");
  });

  it.each(LOGIC_VIEW_MODES.map(({ mode }) => mode))("round-trips the %s split view", (flowSplitView) => {
    const data = stubStorage();
    const preferences: ReviewPreferences = { version: 1, flowSplitView };

    writeReviewPreferences(preferences);

    expect(readReviewPreferences()).toEqual(preferences);
    expect(JSON.parse(data["meridian.prReviewPreferences"])).toEqual(preferences);
  });

  it("rejects malformed, unknown-version, and unsupported split-view records", () => {
    const data = stubStorage({ "meridian.prReviewPreferences": "not json" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);

    data["meridian.prReviewPreferences"] = JSON.stringify({ version: 2, flowSplitView: "graph" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);

    data["meridian.prReviewPreferences"] = JSON.stringify({ version: 1, flowSplitView: "bogus" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
  });

  it("falls back safely when localStorage is absent or throws", () => {
    vi.stubGlobal("window", undefined);
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
    expect(() => writeReviewPreferences({ version: 1, flowSplitView: "graph" })).not.toThrow();

    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
    });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
    expect(() => writeReviewPreferences({ version: 1, flowSplitView: "graph" })).not.toThrow();
  });
});
