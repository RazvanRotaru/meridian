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
  it("defaults to Timeline, split opening, visible source-comment diffs, and excluded formatting-only changes", () => {
    stubStorage();

    expect(readReviewPreferences()).toEqual({
      version: 6,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: true,
      hideAddedSourceCommentDiffs: false,
      excludeFormatOnlyChanges: true,
    });
    expect(DEFAULT_REVIEW_PREFERENCES.version).toBe(6);
    expect(DEFAULT_REVIEW_PREFERENCES.flowSplitView).toBe("timeline");
    expect(DEFAULT_REVIEW_PREFERENCES.openFlowSplitOnSelect).toBe(true);
    expect(DEFAULT_REVIEW_PREFERENCES.hideAddedSourceCommentDiffs).toBe(false);
    expect(DEFAULT_REVIEW_PREFERENCES.excludeFormatOnlyChanges).toBe(true);
  });

  it.each(REVIEW_FLOW_MODES.flatMap((mode) =>
    [true, false].flatMap((openFlowSplitOnSelect) =>
      [true, false].flatMap((hideAddedSourceCommentDiffs) =>
        [true, false].map((excludeFormatOnlyChanges) => ({
          flowSplitView: mode,
          openFlowSplitOnSelect,
          hideAddedSourceCommentDiffs,
          excludeFormatOnlyChanges,
        })),
      ),
    ),
  ))("round-trips $flowSplitView with split opening=$openFlowSplitOnSelect, hidden added comment diffs=$hideAddedSourceCommentDiffs, and excluded formatting=$excludeFormatOnlyChanges", (choice) => {
    const data = stubStorage();
    const preferences: ReviewPreferences = { version: 6, ...choice };

    writeReviewPreferences(preferences);

    expect(readReviewPreferences()).toEqual(preferences);
    expect(JSON.parse(data["meridian.prReviewPreferences"])).toEqual(preferences);
  });

  it.each(REVIEW_FLOW_MODES)("migrates the v1 %s choice with split opening enabled", (flowSplitView) => {
    stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({ version: 1, flowSplitView }),
    });

    expect(readReviewPreferences()).toEqual({
      version: 6,
      flowSplitView,
      openFlowSplitOnSelect: true,
      hideAddedSourceCommentDiffs: false,
      excludeFormatOnlyChanges: true,
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
      version: 6,
      ...choice,
      hideAddedSourceCommentDiffs: false,
      excludeFormatOnlyChanges: true,
    });
  });

  it.each(["hover", "click", "press"])("migrates v3 while ignoring the retired %s preview choice", (codePreviewTrigger) => {
    stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({
        version: 3,
        flowSplitView: "metro",
        openFlowSplitOnSelect: false,
        codePreviewTrigger,
      }),
    });

    const preferences = readReviewPreferences();
    expect(preferences).toEqual({
      version: 6,
      flowSplitView: "metro",
      openFlowSplitOnSelect: false,
      hideAddedSourceCommentDiffs: false,
      excludeFormatOnlyChanges: true,
    });
    expect(preferences).not.toHaveProperty("codePreviewTrigger");
  });

  it("ignores the obsolete comment-hover field in an unshipped v4 record", () => {
    stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({
        version: 4,
        flowSplitView: "metro",
        openFlowSplitOnSelect: false,
        codePreviewTrigger: "click",
        hideDiffOnCommentHover: true,
      }),
    });

    expect(readReviewPreferences()).toEqual({
      version: 6,
      flowSplitView: "metro",
      openFlowSplitOnSelect: false,
      hideAddedSourceCommentDiffs: false,
      excludeFormatOnlyChanges: true,
    });
  });

  it("defaults malformed v4 fields independently while enabling formatting-only exclusion", () => {
    const data = stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({
        version: 4,
        flowSplitView: "blocks",
        openFlowSplitOnSelect: "no",
        codePreviewTrigger: "press",
        hideAddedSourceCommentDiffs: "yes",
      }),
    });
    expect(readReviewPreferences()).toEqual({
      version: 6,
      flowSplitView: "blocks",
      openFlowSplitOnSelect: true,
      hideAddedSourceCommentDiffs: false,
      excludeFormatOnlyChanges: true,
    });

    data["meridian.prReviewPreferences"] = JSON.stringify({
      version: 4,
      flowSplitView: "bogus",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
      hideAddedSourceCommentDiffs: true,
    });
    expect(readReviewPreferences()).toEqual({
      version: 6,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
      hideAddedSourceCommentDiffs: true,
      excludeFormatOnlyChanges: true,
    });
  });

  it("defaults a malformed v5 formatting-only field without erasing valid comment-diff preferences", () => {
    stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({
        version: 5,
        flowSplitView: "graph",
        openFlowSplitOnSelect: false,
        codePreviewTrigger: "click",
        hideAddedSourceCommentDiffs: true,
        excludeFormatOnlyChanges: "yes",
      }),
    });

    const preferences = readReviewPreferences();
    expect(preferences).toEqual({
      version: 6,
      flowSplitView: "graph",
      openFlowSplitOnSelect: false,
      hideAddedSourceCommentDiffs: true,
      excludeFormatOnlyChanges: true,
    });
    expect(preferences).not.toHaveProperty("codePreviewTrigger");
  });

  it("defaults malformed v6 fields independently and drops obsolete trigger data", () => {
    stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({
        version: 6,
        flowSplitView: "graph",
        openFlowSplitOnSelect: "no",
        codePreviewTrigger: "click",
        hideAddedSourceCommentDiffs: true,
        excludeFormatOnlyChanges: "yes",
      }),
    });

    const preferences = readReviewPreferences();
    expect(preferences).toEqual({
      version: 6,
      flowSplitView: "graph",
      openFlowSplitOnSelect: true,
      hideAddedSourceCommentDiffs: true,
      excludeFormatOnlyChanges: true,
    });
    expect(preferences).not.toHaveProperty("codePreviewTrigger");
  });

  it("rejects malformed, unknown-version, and unsupported v1 records", () => {
    const data = stubStorage({ "meridian.prReviewPreferences": "not json" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);

    data["meridian.prReviewPreferences"] = JSON.stringify({ version: 7, flowSplitView: "graph" });
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
      version: 6,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
      hideAddedSourceCommentDiffs: false,
      excludeFormatOnlyChanges: true,
    });
  });

  it("falls back safely when localStorage is absent or throws", () => {
    vi.stubGlobal("window", undefined);
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
    expect(() => writeReviewPreferences({
      version: 6,
      flowSplitView: "graph",
      openFlowSplitOnSelect: false,
      hideAddedSourceCommentDiffs: true,
      excludeFormatOnlyChanges: false,
    })).not.toThrow();

    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
    });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
    expect(() => writeReviewPreferences({
      version: 6,
      flowSplitView: "graph",
      openFlowSplitOnSelect: false,
      hideAddedSourceCommentDiffs: true,
      excludeFormatOnlyChanges: false,
    })).not.toThrow();
  });
});
