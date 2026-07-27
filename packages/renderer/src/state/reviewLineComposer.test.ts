import { describe, expect, it, vi } from "vitest";
import {
  createReviewLineComposerDraft,
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
  side: "RIGHT",
};

describe("reviewLineComposer", () => {
  it("opens an empty composer and changes its controlled body", () => {
    const opened = openReviewLineComposer(null, TARGET);
    const draftChanged = vi.fn();
    const unsubscribe = opened.draft.subscribe(draftChanged);

    expect(opened).toMatchObject({
      ...TARGET,
      confirmDiscard: false,
      error: null,
    });
    expect(opened.draft.getSnapshot()).toBe("");

    // Per-key text is published only through the dedicated draft channel. Keeping the lifecycle
    // object stable is what lets the Blueprint store, URL sync, and source table remain untouched.
    expect(setReviewLineComposerBody(opened, "K")).toBe(opened);
    expect(setReviewLineComposerBody(opened, "Keep this draft")).toBe(opened);
    expect(opened.draft.getSnapshot()).toBe("Keep this draft");
    expect(draftChanged).toHaveBeenCalledTimes(2);

    // An identical controlled value is a complete no-op, and unsubscribe releases the host.
    expect(setReviewLineComposerBody(opened, "Keep this draft")).toBe(opened);
    expect(draftChanged).toHaveBeenCalledTimes(2);
    unsubscribe();
    setReviewLineComposerBody(opened, "No listener");
    expect(draftChanged).toHaveBeenCalledTimes(2);
  });

  it("requires confirmation before dismissing a dirty draft, then keeps or discards it", () => {
    const dirty = setReviewLineComposerBody(openReviewLineComposer(null, TARGET), "Do not lose me");
    const requested = requestReviewLineComposerDismiss(dirty);

    expect(requested).toEqual({
      composer: { ...dirty, confirmDiscard: true },
      allowed: false,
    });
    expect(keepEditingReviewLineComposer(requested.composer!)).toEqual(dirty);
    expect(requested.composer!.draft.getSnapshot()).toBe("Do not lose me");
    expect(discardReviewLineComposer(requested.composer)).toBeNull();
    expect(dirty.draft.getSnapshot()).toBe("");
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
    const switched = openReviewLineComposer(current, next);

    expect(switched).toMatchObject({
      ...next,
      confirmDiscard: false,
      error: null,
    });
    expect(switched.draft).not.toBe(current.draft);
    expect(switched.draft.getSnapshot()).toBe("");
  });

  it("guards a target switch without retargeting or losing a dirty draft", () => {
    const dirty = setReviewLineComposerBody(openReviewLineComposer(null, TARGET), "Sticky text");
    const next = { ...TARGET, path: "src/next.ts", line: 7 };

    const guarded = openReviewLineComposer(dirty, next);
    expect(guarded).toEqual({
      ...dirty,
      confirmDiscard: true,
    });
    expect(guarded.draft).toBe(dirty.draft);
    expect(guarded.draft.getSnapshot()).toBe("Sticky text");
  });

  it("reopening the current target resumes an outstanding confirmation", () => {
    const confirming: ReviewLineComposerState = {
      ...TARGET,
      draft: createReviewLineComposerDraft("Still here"),
      confirmDiscard: true,
      error: null,
    };

    expect(openReviewLineComposer(confirming, TARGET)).toEqual({
      ...confirming,
      confirmDiscard: false,
    });
    expect(confirming.draft.getSnapshot()).toBe("Still here");
  });

  it("matches the review, revision, path, side, and line exactly", () => {
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET })).toBe(true);
    expect(matchesReviewLineComposerTarget(null, TARGET)).toBe(false);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, reviewKey: "repo|pr-43" })).toBe(false);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, lineRevision: "head-b" })).toBe(false);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, lineRevision: null })).toBe(false);
    expect(matchesReviewLineComposerTarget({ ...TARGET, lineRevision: null }, { ...TARGET, lineRevision: null })).toBe(true);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, path: "src/other.ts" })).toBe(false);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, line: 20 })).toBe(false);
    expect(matchesReviewLineComposerTarget(TARGET, { ...TARGET, side: "LEFT" })).toBe(false);
  });
});
