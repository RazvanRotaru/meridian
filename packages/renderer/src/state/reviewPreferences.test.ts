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
  it("defaults to Timeline, split opening, hover previews, and visible source-comment diffs", () => {
    stubStorage();

    expect(readReviewPreferences()).toEqual({
      version: 4,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: true,
      codePreviewTrigger: "hover",
      hideAddedSourceCommentDiffs: false,
    });
    expect(DEFAULT_REVIEW_PREFERENCES.flowSplitView).toBe("timeline");
    expect(DEFAULT_REVIEW_PREFERENCES.openFlowSplitOnSelect).toBe(true);
    expect(DEFAULT_REVIEW_PREFERENCES.codePreviewTrigger).toBe("hover");
    expect(DEFAULT_REVIEW_PREFERENCES.hideAddedSourceCommentDiffs).toBe(false);
  });

  it.each(REVIEW_FLOW_MODES.flatMap((mode) =>
    [true, false].flatMap((openFlowSplitOnSelect) =>
      CODE_PREVIEW_TRIGGERS.flatMap((codePreviewTrigger) =>
        [true, false].map((hideAddedSourceCommentDiffs) => ({
          flowSplitView: mode,
          openFlowSplitOnSelect,
          codePreviewTrigger,
          hideAddedSourceCommentDiffs,
        })),
      ),
    ),
  ))("round-trips $flowSplitView with split opening=$openFlowSplitOnSelect, previews=$codePreviewTrigger, and hidden added comment diffs=$hideAddedSourceCommentDiffs", (choice) => {
    const data = stubStorage();
    const preferences: ReviewPreferences = { version: 4, ...choice };

    writeReviewPreferences(preferences);

    expect(readReviewPreferences()).toEqual(preferences);
    expect(JSON.parse(data["meridian.prReviewPreferences"])).toEqual(preferences);
  });

  it.each(REVIEW_FLOW_MODES)("migrates the v1 %s choice with split opening enabled", (flowSplitView) => {
    stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({ version: 1, flowSplitView }),
    });

    expect(readReviewPreferences()).toEqual({
      version: 4,
      flowSplitView,
      openFlowSplitOnSelect: true,
      codePreviewTrigger: "hover",
      hideAddedSourceCommentDiffs: false,
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
      version: 4,
      ...choice,
      codePreviewTrigger: "hover",
      hideAddedSourceCommentDiffs: false,
    });
  });

  it.each(CODE_PREVIEW_TRIGGERS)("migrates the v3 %s preview choice with added source comments visible", (codePreviewTrigger) => {
    stubStorage({
      "meridian.prReviewPreferences": JSON.stringify({
        version: 3,
        flowSplitView: "metro",
        openFlowSplitOnSelect: false,
        codePreviewTrigger,
      }),
    });

    expect(readReviewPreferences()).toEqual({
      version: 4,
      flowSplitView: "metro",
      openFlowSplitOnSelect: false,
      codePreviewTrigger,
      hideAddedSourceCommentDiffs: false,
    });
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
      version: 4,
      flowSplitView: "metro",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
      hideAddedSourceCommentDiffs: false,
    });
  });

  it("defaults malformed v4 fields independently", () => {
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
      version: 4,
      flowSplitView: "blocks",
      openFlowSplitOnSelect: true,
      codePreviewTrigger: "hover",
      hideAddedSourceCommentDiffs: false,
    });

    data["meridian.prReviewPreferences"] = JSON.stringify({
      version: 4,
      flowSplitView: "bogus",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
      hideAddedSourceCommentDiffs: true,
    });
    expect(readReviewPreferences()).toEqual({
      version: 4,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
      hideAddedSourceCommentDiffs: true,
    });
  });

  it("rejects malformed, unknown-version, and unsupported v1 records", () => {
    const data = stubStorage({ "meridian.prReviewPreferences": "not json" });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);

    data["meridian.prReviewPreferences"] = JSON.stringify({ version: 5, flowSplitView: "graph" });
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
      version: 4,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
      hideAddedSourceCommentDiffs: false,
    });
  });

  it("falls back safely when localStorage is absent or throws", () => {
    vi.stubGlobal("window", undefined);
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
    expect(() => writeReviewPreferences({
      version: 4,
      flowSplitView: "graph",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
      hideAddedSourceCommentDiffs: true,
    })).not.toThrow();

    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
    });
    expect(readReviewPreferences()).toEqual(DEFAULT_REVIEW_PREFERENCES);
    expect(() => writeReviewPreferences({
      version: 4,
      flowSplitView: "graph",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
      hideAddedSourceCommentDiffs: true,
    })).not.toThrow();
  });
});
