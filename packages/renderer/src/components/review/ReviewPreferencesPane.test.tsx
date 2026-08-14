import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { STATIC_LOGIC_VIEW_MODES } from "../../derive/flowViewModel";
import type { ReviewFlowSplitView } from "../../state/reviewPreferences";
import { ReviewPreferencesPane } from "./ReviewPreferencesPane";

const MODES = STATIC_LOGIC_VIEW_MODES.map(({ mode }) => mode);

function render(
  flowView: ReviewFlowSplitView,
  openFlowSplitOnSelect = true,
  excludeTestChanges = true,
  hideNodesNotInDiff = false,
  hideAddedSourceCommentDiffs = false,
  excludeFormatOnlyChanges = true,
  progressiveContext: ComponentProps<typeof ReviewPreferencesPane>["progressiveContext"] = null,
) {
  return renderToStaticMarkup(
    <ReviewPreferencesPane
      excludeTestChanges={excludeTestChanges}
      excludeFormatOnlyChanges={excludeFormatOnlyChanges}
      hideNodesNotInDiff={hideNodesNotInDiff}
      flowView={flowView}
      openFlowSplitOnSelect={openFlowSplitOnSelect}
      hideAddedSourceCommentDiffs={hideAddedSourceCommentDiffs}
      progressiveContext={progressiveContext}
      onExcludeTestChangesChange={() => undefined}
      onExcludeFormatOnlyChangesChange={() => undefined}
      onHideNodesNotInDiffChange={() => undefined}
      onFlowViewChange={() => undefined}
      onOpenFlowSplitOnSelectChange={() => undefined}
      onHideAddedSourceCommentDiffsChange={() => undefined}
      onProgressiveDepthChange={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe("ReviewPreferencesPane", () => {
  it("renders an accessible native radio group and browser-scoped guidance", () => {
    const markup = render("timeline");

    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-labelledby="review-preferences-heading"');
    expect(markup).toContain('<h2 id="review-preferences-heading"');
    expect(markup).toContain("Review preferences");
    expect(markup).toContain("Review content");
    expect(markup).toContain("Exclude test changes");
    expect(markup).toContain("Remove test files, affected nodes, flows, and comments");
    expect(markup).toContain("Exclude formatting-only changes");
    expect(markup).toContain("Remove proven formatting-only edits from affected nodes, files, and flows");
    expect(markup).toContain("Uncertain or mixed changes stay in the review");
    expect(markup).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")(?=[^>]*aria-describedby="review-format-only-description")[^>]*>/);
    expect(markup).toContain("Graph display");
    expect(markup).toContain("Hide nodes not in diff");
    expect(markup).toContain("Keep changed code and the file or package containers needed to place it");
    expect(markup).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*aria-describedby="review-diff-only-description")[^>]*>/);
    expect(markup).toContain("Logic flow behavior");
    expect(markup).toContain("Open split view when selecting a logic flow");
    expect(markup).toContain("stays highlighted in the review graph");
    expect(markup.match(/type="checkbox"/g)).toHaveLength(5);
    expect(markup.match(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/g)).toHaveLength(3);
    expect(markup).toContain("Source diff display");
    expect(markup).toContain("Hide source comments in diffs");
    expect(markup).toContain("Hide changes that only alter source comments from code diffs and the review graph");
    expect(markup).toContain("Changes that also alter executable code stay highlighted");
    expect(markup).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*aria-describedby="review-added-source-comments-description")[^>]*>/);
    expect(markup).toContain("Modifier navigation");
    expect(markup).toContain("Hold Command on macOS or Control on Windows while hovering a source-backed node to preview code");
    expect(markup).toContain("Hold it while clicking a semantic edge to inspect evidence");
    expect(markup).not.toContain('name="review-code-preview-trigger"');
    expect(markup).not.toContain("On click");
    expect(markup).toContain("Split view presentation");
    expect(markup.match(/type="radio"/g)).toHaveLength(MODES.length);
    expect(markup.match(/name="review-flow-split-view"/g)).toHaveLength(MODES.length);
    expect(MODES.every((mode) => markup.includes(`value="${mode}"`))).toBe(true);
    expect(markup).toContain("Sequence");
    expect(markup).toContain("Recommended");
    expect(markup).toContain("Execution graph");
    expect(markup).toContain("Metro");
    expect(markup).toContain("Blocks");
    expect(markup).toContain("Formatting-only filtering, flow, and source diff preferences are saved in this browser");
    expect(markup).toContain("Graph display and test visibility apply to the current PR review");
    expect(markup).toContain('aria-label="Close review preferences"');
  });

  it("keeps every presentation configurable while automatic split opening and test exclusion are off", () => {
    const markup = render("blocks", false, false, false, false, false);

    expect(markup).not.toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/);
    expect(markup.match(/type="radio"/g)).toHaveLength(MODES.length);
    expect(markup).toMatch(/<input(?=[^>]*value="blocks")(?=[^>]*checked="")[^>]*>/);
  });

  it("presents modifier-hover preview guidance without a configurable input", () => {
    const markup = render("timeline");

    expect(markup).toContain("Hold Command on macOS or Control on Windows");
    expect(markup).not.toContain('name="review-code-preview-trigger"');
    expect(markup).toMatch(/<input(?=[^>]*name="review-flow-split-view")(?=[^>]*value="timeline")(?=[^>]*checked="")[^>]*>/);
  });

  it("can hide source-comment diff treatment independently", () => {
    const markup = render("timeline", true, true, false, true);

    expect(markup).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")(?=[^>]*aria-describedby="review-added-source-comments-description")[^>]*>/);
  });

  it("checks the diff-only graph control independently from the other review preferences", () => {
    const markup = render("timeline", false, false, true, false, false);

    expect(markup.match(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/g)).toHaveLength(1);
    expect(markup).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")(?=[^>]*aria-describedby="review-diff-only-description")[^>]*>/);
  });

  it("can include formatting-only changes without changing source-comment diff treatment", () => {
    const markup = render("timeline", true, true, false, true, false);

    expect(markup).not.toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")(?=[^>]*aria-describedby="review-format-only-description")[^>]*>/);
    expect(markup).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")(?=[^>]*aria-describedby="review-added-source-comments-description")[^>]*>/);
  });

  it("shows adjustable progressive context without changing legacy graph preferences", () => {
    const markup = render("timeline", true, true, false, false, true, {
      requestedDepth: 2,
      loadedDepth: 2,
      loadedFiles: 37,
      totalFiles: 912,
      status: "ready",
      error: null,
    });

    expect(markup).toContain("Loaded context depth");
    expect(markup).toContain('id="review-context-depth"');
    expect(markup).toMatch(/<option value="2" selected="">2 edges<\/option>/);
    expect(markup).toContain("37 of 912 files resident per revision");
    expect(markup).toContain("resolved imports (including literal dynamic imports) and exact IPC joins");
    expect(markup).toContain("Depth 2 is prepared after the canvas becomes actionable; deeper levels load only when chosen");
  });

  it("presents rename-safe resident counts with their per-revision denominator", () => {
    const markup = render("timeline", true, true, false, false, true, {
      requestedDepth: 1,
      loadedDepth: 1,
      loadedFiles: 1,
      totalFiles: 1,
      status: "ready",
      error: null,
    });

    expect(markup).toContain("1 of 1 files resident per revision");
    expect(markup).not.toContain("2 of 1");
  });

  it.each(MODES)("marks only %s as selected", (mode) => {
    const markup = render(mode);

    expect(markup).toMatch(new RegExp(`<input(?=[^>]*value="${mode}")(?=[^>]*checked="")[^>]*>`));
    for (const other of MODES.filter((candidate) => candidate !== mode)) {
      expect(markup).not.toMatch(new RegExp(`<input(?=[^>]*value="${other}")(?=[^>]*checked="")[^>]*>`));
    }
  });
});
