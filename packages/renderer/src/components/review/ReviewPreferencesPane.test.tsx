import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STATIC_LOGIC_VIEW_MODES } from "../../derive/flowViewModel";
import type { ReviewFlowSplitView } from "../../state/reviewPreferences";
import { ReviewPreferencesPane } from "./ReviewPreferencesPane";

const MODES = STATIC_LOGIC_VIEW_MODES.map(({ mode }) => mode);

function render(flowView: ReviewFlowSplitView, openFlowSplitOnSelect = true) {
  return renderToStaticMarkup(
    <ReviewPreferencesPane
      flowView={flowView}
      openFlowSplitOnSelect={openFlowSplitOnSelect}
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
    expect(markup).toContain("Logic flow behavior");
    expect(markup).toContain("Open split view when selecting a logic flow");
    expect(markup).toContain("stays highlighted in the review graph");
    expect(markup.match(/type="checkbox"/g)).toHaveLength(1);
    expect(markup).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/);
    expect(markup).toContain("Split view presentation");
    expect(markup.match(/type="radio"/g)).toHaveLength(MODES.length);
    expect(markup.match(/name="review-flow-split-view"/g)).toHaveLength(MODES.length);
    expect(MODES.every((mode) => markup.includes(`value="${mode}"`))).toBe(true);
    expect(markup).toContain("Timeline");
    expect(markup).toContain("Recommended");
    expect(markup).toContain("Execution graph");
    expect(markup).toContain("Metro");
    expect(markup).toContain("Blocks");
    expect(markup).toContain("Saved in this browser");
    expect(markup).toContain("apply only to PR review");
    expect(markup).toContain('aria-label="Close review preferences"');
  });

  it("keeps every presentation configurable while automatic split opening is off", () => {
    const markup = render("blocks", false);

    expect(markup).not.toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/);
    expect(markup.match(/type="radio"/g)).toHaveLength(MODES.length);
    expect(markup).toMatch(/<input(?=[^>]*value="blocks")(?=[^>]*checked="")[^>]*>/);
  });

  it.each(MODES)("marks only %s as selected", (mode) => {
    const markup = render(mode);

    expect(markup).toMatch(new RegExp(`<input(?=[^>]*value="${mode}")(?=[^>]*checked="")[^>]*>`));
    for (const other of MODES.filter((candidate) => candidate !== mode)) {
      expect(markup).not.toMatch(new RegExp(`<input(?=[^>]*value="${other}")(?=[^>]*checked="")[^>]*>`));
    }
  });
});
