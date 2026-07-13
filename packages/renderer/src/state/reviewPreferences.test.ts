import { afterEach, describe, expect, it, vi } from "vitest";
import { STATIC_LOGIC_VIEW_MODES } from "../derive/flowViewModel";
import {
  DEFAULT_REVIEW_PREFERENCES,
  readReviewPreferences,
  writeReviewPreferences,
  type ReviewCodePreviewTrigger,
  type ReviewPreferences,
  type ReviewFlowSplitView,
} from "./reviewPreferences";

const REVIEW_FLOW_MODES: ReviewFlowSplitView[] = STATIC_LOGIC_VIEW_MODES.map(({ mode }) => mode);
const CODE_PREVIEW_TRIGGERS: ReviewCodePreviewTrigger[] = ["hover", "click"];

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
  it("defaults to Timeline, split opening enabled, and hover previews when no preference is stored", () => {
    stubStorage();

    expect(readReviewPreferences()).toEqual({
      version: 3,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: true,
      codePreviewTrigger: "hover",
    });
    expect(DEFAULT_REVIEW_PREFERENCES.flowSplitView).toBe("timeline");
    expect(DEFAULT_REVIEW_PREFERENCES.openFlowSplitOnSelect).toBe(true);
    expect(DEFAULT_REVIEW_PREFERENCES.codePreviewTrigger).toBe("hover");
  });

  it.each(REVIEW_FLOW_MODES.flatMap((mode) =>
    [true, false].flatMap((openFlowSplitOnSelect) =>
      CODE_PREVIEW_TRIGGERS.map((codePreviewTrigger) => ({
        flowSplitView: mode,
        openFlowSplitOnSelect,
        codePreviewTrigger,
      })),
    ),
  ))("round-trips $flowSplitView with split opening=$openFlowSplitOnSelect and previews=$codePreviewTrigger", (choice) => {
    const data = stubStorage();
    const preferences: ReviewPreferences = { version: 3, ...choice };

    writeReviewPreferences(preferences);

    expect(readReviewPreferences()).toEqual(preferences);
    expect(JSON.parse(data["meridian.prReviewPreferences"])).toEqual(preferences);
  });

  it.each(REVIEW_FLOW_MODES)("migrates the v1 %s choice with split opening enabled", (flowSplitView) => {
    stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({ version: 1, flowSplitView }),
    });

    expect(readReviewPreferences()).toEqual({
      version: 3,
      flowSplitView,
      openFlowSplitOnSelect: true,
      codePreviewTrigger: "hover",
    });
  });

  it.each(REVIEW_FLOW_MODES.flatMap((flowSplitView) => [
    { flowSplitView, openFlowSplitOnSelect: true },
    { flowSplitView, openFlowSplitOnSelect: false },
  ]))("migrates the v2 $flowSplitView choice with split opening=$openFlowSplitOnSelect", (choice) => {
    stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({ version: 2, ...choice }),
    });

    expect(readReviewPreferences()).toEqual({
      version: 3,
      ...choice,
      codePreviewTrigger: "hover",
    });
  });

  it("defaults malformed v3 fields independently", () => {
    const data = stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({
        version: 3,
        flowSplitView: "blocks",
        openFlowSplitOnSelect: "no",
        codePreviewTrigger: "press",
      }),
    });
    expect(readReviewPreferences()).toEqual({
      version: 3,
      flowSplitView: "blocks",
      openFlowSplitOnSelect: true,
      codePreviewTrigger: "hover",
    });

    data["meridian.prReviewPreferences"] = JSON.stringify({
      version: 3,
      flowSplitView: "bogus",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
    });
    expect(readReviewPreferences()).toEqual({
      version: 3,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
    });
  });

  it("rejects malformed, unknown-version, and unsupported v1 records", () => {
    const data = stubStorage({ "meridian.prReviewPreferences": "not json" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);

    data["meridian.prReviewPreferences"] = JSON.stringify({ version: 4, flowSplitView: "graph" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);

    data["meridian.prReviewPreferences"] = JSON.stringify({ version: 1, flowSplitView: "bogus" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);

    data["meridian.prReviewPreferences"] = JSON.stringify({
      version: 3,
      flowSplitView: "request",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
    });
    expect(readReviewPreferences()).toEqual({
      version: 3,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
    });
  });

  it("falls back safely when localStorage is absent or throws", () => {
    vi.stubGlobal("window", undefined);
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
    expect(() => writeReviewPreferences({
      version: 3,
      flowSplitView: "graph",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
    })).not.toThrow();

    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
    });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
    expect(() => writeReviewPreferences({
      version: 3,
      flowSplitView: "graph",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
    })).not.toThrow();
  });
});
