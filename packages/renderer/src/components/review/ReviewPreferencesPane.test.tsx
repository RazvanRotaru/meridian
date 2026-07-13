import { renderToStaticMarkup } from "react-dom/server";
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
) {
  return renderToStaticMarkup(
    <ReviewPreferencesPane
      excludeTestChanges={excludeTestChanges}
      hideNodesNotInDiff={hideNodesNotInDiff}
      flowView={flowView}
      openFlowSplitOnSelect={openFlowSplitOnSelect}
      onExcludeTestChangesChange={() => undefined}
      onHideNodesNotInDiffChange={() => undefined}
      onFlowViewChange={() => undefined}
      onOpenFlowSplitOnSelectChange={() => undefined}
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
    expect(markup).toContain("Graph display");
    expect(markup).toContain("Hide nodes not in diff");
    expect(markup).toContain("Keep changed code and the file or package containers needed to place it");
    expect(markup).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*aria-describedby="review-diff-only-description")[^>]*>/);
    expect(markup).toContain("Logic flow behavior");
    expect(markup).toContain("Open split view when selecting a logic flow");
    expect(markup).toContain("stays highlighted in the review graph");
    expect(markup.match(/type="checkbox"/g)).toHaveLength(3);
    expect(markup.match(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/g)).toHaveLength(2);
    expect(markup).toContain("Split view presentation");
    expect(markup.match(/type="radio"/g)).toHaveLength(MODES.length);
    expect(markup.match(/name="review-flow-split-view"/g)).toHaveLength(MODES.length);
    expect(MODES.every((mode) => markup.includes(`value="${mode}"`))).toBe(true);
    expect(markup).toContain("Timeline");
    expect(markup).toContain("Recommended");
    expect(markup).toContain("Execution graph");
    expect(markup).toContain("Metro");
    expect(markup).toContain("Blocks");
    expect(markup).toContain("Flow preferences are saved in this browser");
    expect(markup).toContain("Graph display and test visibility apply to the current PR review");
    expect(markup).toContain('aria-label="Close review preferences"');
  });

  it("keeps every presentation configurable while automatic split opening and test exclusion are off", () => {
    const markup = render("blocks", false, false);

    expect(markup).not.toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/);
    expect(markup.match(/type="radio"/g)).toHaveLength(MODES.length);
    expect(markup).toMatch(/<input(?=[^>]*value="blocks")(?=[^>]*checked="")[^>]*>/);
  });

  it("checks the diff-only graph control independently from the other review preferences", () => {
    const markup = render("timeline", false, false, true);

    expect(markup.match(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/g)).toHaveLength(1);
    expect(markup).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")(?=[^>]*aria-describedby="review-diff-only-description")[^>]*>/);
  });

  it.each(MODES)("marks only %s as selected", (mode) => {
    const markup = render(mode);

    expect(markup).toMatch(new RegExp(`<input(?=[^>]*value="${mode}")(?=[^>]*checked="")[^>]*>`));
    for (const other of MODES.filter((candidate) => candidate !== mode)) {
      expect(markup).not.toMatch(new RegExp(`<input(?=[^>]*value="${other}")(?=[^>]*checked="")[^>]*>`));
    }
  });
});
