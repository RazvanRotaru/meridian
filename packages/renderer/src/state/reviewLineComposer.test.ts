import { describe, expect, it } from "vitest";
import {
  discardReviewLineComposer,
  keepEditingReviewLineComposer,
  matchesReviewLineComposerTarget,
  openReviewLineComposer,
  requestReviewLineComposerDismiss,
  setReviewLineComposerBody,
  type ReviewLineComposerState,
  type ReviewLineComposerTarget,
} from "./reviewLineComposer";

const TARGET: ReviewLineComposerTarget = {
  reviewKey: "repo|pr-42",
  lineRevision: "head-a",
  path: "src/live.ts",
  line: 19,
};

describe("reviewLineComposer", () => {
  it("opens an empty composer and changes its controlled body", () => {
    const opened = openReviewLineComposer(null, TARGET);

    expect(opened).toEqual({
      ...TARGET,
      body: "",
      confirmDiscard: false,
      error: null,
    });
    expect(setReviewLineComposerBody(opened, "Keep this draft")).toEqual({
      ...opened,
      body: "Keep this draft",
    });
  });

  it("requires confirmation before dismissing a dirty draft, then keeps or discards it", () => {
    const dirty = setReviewLineComposerBody(openReviewLineComposer(null, TARGET), "Do not lose me");
    const requested = requestReviewLineComposerDismiss(dirty);

    expect(requested).toEqual({
      composer: { ...dirty, confirmDiscard: true },
      allowed: false,
    });
    expect(keepEditingReviewLineComposer(requested.composer!)).toEqual(dirty);
    expect(discardReviewLineComposer()).toBeNull();
  });

  it("dismisses an empty or whitespace-only composer immediately", () => {
    expect(requestReviewLineComposerDismiss(openReviewLineComposer(null, TARGET))).toEqual({
      composer: null,
      allowed: true,
    });
    expect(requestReviewLineComposerDismiss(
      setReviewLineComposerBody(openReviewLineComposer(null, TARGET), "  \n"),
    )).toEqual({ composer: null, allowed: true });
    expect(requestReviewLineComposerDismiss(null)).toEqual({ composer: null, allowed: true });
  });

  it("switches a clean composer directly to a different target", () => {
    const current = openReviewLineComposer(null, TARGET);
    const next = { ...TARGET, path: "src/next.ts", line: 7 };

    expect(openReviewLineComposer(current, next)).toEqual({
      ...next,
      body: "",
      confirmDiscard: false,
      error: null,
    });
  });

  it("guards a target switch without retargeting or losing a dirty draft", () => {
    const dirty = setReviewLineComposerBody(openReviewLineComposer(null, TARGET), "Sticky text");
    const next = { ...TARGET, path: "src/next.ts", line: 7 };

    expect(openReviewLineComposer(dirty, next)).toEqual({
      ...dirty,
      confirmDiscard: true,
    });
  });

  it("reopening the current target resumes an outstanding confirmation", () => {
    const confirming: ReviewLineComposerState = {
      ...TARGET,
      body: "Still here",
      confirmDiscard: true,
      error: null,
    };

    expect(openReviewLineComposer(confirming, TARGET)).toEqual({
      ...confirming,
      confirmDiscard: false,
    });
  });

  it("matches the review, revision, path, and line exactly", () => {
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET })).toBe(true);
    expect(matchesReviewLineComposerTarget(null, TARGET)).toBe(false);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, reviewKey: "repo|pr-43" })).toBe(false);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, lineRevision: "head-b" })).toBe(false);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, lineRevision: null })).toBe(false);
    expect(matchesReviewLineComposerTarget({ ...TARGET, lineRevision: null }, { ...TARGET, lineRevision: null })).toBe(true);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, path: "src/other.ts" })).toBe(false);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, line: 20 })).toBe(false);
  });
});
