import { afterEach, describe, expect, it, vi } from "vitest";
import { STATIC_LOGIC_VIEW_MODES } from "../derive/flowViewModel";
import {
  DEFAULT_REVIEW_PREFERENCES,
  readReviewPreferences,
  writeReviewPreferences,
  type ReviewPreferences,
  type ReviewFlowSplitView,
} from "./reviewPreferences";

const REVIEW_FLOW_MODES: ReviewFlowSplitView[] = STATIC_LOGIC_VIEW_MODES.map(({ mode }) => mode);

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
  it("defaults to Timeline with split opening enabled when no preference is stored", () => {
    stubStorage();

    expect(readReviewPreferences()).toEqual({
      version: 2,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: true,
    });
    expect(DEFAULT_REVIEW_PREFERENCES.flowSplitView).toBe("timeline");
    expect(DEFAULT_REVIEW_PREFERENCES.openFlowSplitOnSelect).toBe(true);
  });

  it.each(REVIEW_FLOW_MODES.flatMap((mode) => [
    { flowSplitView: mode, openFlowSplitOnSelect: true },
    { flowSplitView: mode, openFlowSplitOnSelect: false },
  ]))("round-trips $flowSplitView with split opening=$openFlowSplitOnSelect", (choice) => {
    const data = stubStorage();
    const preferences: ReviewPreferences = { version: 2, ...choice };

    writeReviewPreferences(preferences);

    expect(readReviewPreferences()).toEqual(preferences);
    expect(JSON.parse(data["meridian.prReviewPreferences"])).toEqual(preferences);
  });

  it.each(REVIEW_FLOW_MODES)("migrates the v1 %s choice with split opening enabled", (flowSplitView) => {
    stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({ version: 1, flowSplitView }),
    });

    expect(readReviewPreferences()).toEqual({
      version: 2,
      flowSplitView,
      openFlowSplitOnSelect: true,
    });
  });

  it("defaults malformed v2 fields independently", () => {
    const data = stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({
        version: 2,
        flowSplitView: "blocks",
        openFlowSplitOnSelect: "no",
      }),
    });
    expect(readReviewPreferences()).toEqual({
      version: 2,
      flowSplitView: "blocks",
      openFlowSplitOnSelect: true,
    });

    data["meridian.prReviewPreferences"] = JSON.stringify({
      version: 2,
      flowSplitView: "bogus",
      openFlowSplitOnSelect: false,
    });
    expect(readReviewPreferences()).toEqual({
      version: 2,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
    });
  });

  it("rejects malformed, unknown-version, and unsupported v1 records", () => {
    const data = stubStorage({ "meridian.prReviewPreferences": "not json" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);

    data["meridian.prReviewPreferences"] = JSON.stringify({ version: 3, flowSplitView: "graph" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);

    data["meridian.prReviewPreferences"] = JSON.stringify({ version: 1, flowSplitView: "bogus" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);

    data["meridian.prReviewPreferences"] = JSON.stringify({ version: 2, flowSplitView: "request", openFlowSplitOnSelect: false });
    expect(readReviewPreferences()).toEqual({
      version: 2,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
    });
  });

  it("falls back safely when localStorage is absent or throws", () => {
    vi.stubGlobal("window", undefined);
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
    expect(() => writeReviewPreferences({ version: 2, flowSplitView: "graph", openFlowSplitOnSelect: false })).not.toThrow();

    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
    });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
    expect(() => writeReviewPreferences({ version: 2, flowSplitView: "graph", openFlowSplitOnSelect: false })).not.toThrow();
  });
});
