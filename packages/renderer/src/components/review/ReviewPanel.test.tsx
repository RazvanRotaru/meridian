import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { reviewViewedGestureBlockReason } from "../../state/store";
import { ReviewPanelResizableLayout } from "./ReviewPanel";

describe("ReviewPanelResizableLayout", () => {
  it("makes each review section boundary an accessible compact splitter", () => {
    const markup = renderLayout();

    expect(markup.match(/role="separator"/g)).toHaveLength(4);
    expect(markup).toContain('aria-label="Resize pull request context and review workspace"');
    expect(markup).toContain('aria-label="Resize review scope and remaining review sections"');
    expect(markup).toContain('aria-label="Resize affected logic flows and remaining review sections"');
    expect(markup).toContain('aria-label="Resize changed files and submit review"');
    expect(markup.match(/aria-orientation="horizontal"/g)).toHaveLength(4);
    expect(markup.match(/height:6px/g)).toHaveLength(4);
  });

  it("removes separators for absent sections while preserving their mounted content", () => {
    const markup = renderLayout({ scopeVisible: false, flowsVisible: false });

    expect(markup).toContain("scope state");
    expect(markup).toContain("flows state");
    expect(markup).toContain("files state");
    expect(markup).toContain("footer state");
    expect(markup).not.toContain('aria-label="Resize review scope and remaining review sections"');
    expect(markup).not.toContain('aria-label="Resize affected logic flows and remaining review sections"');
    expect(markup).toContain('aria-label="Resize changed files and submit review"');
    expect(markup.match(/role="separator"/g)).toHaveLength(2);
    expect(markup).toMatch(/id="review-scope-pane"[^>]*display:none[^>]*aria-hidden="true"[^>]*inert/);
    expect(markup).toMatch(/id="review-flows-pane"[^>]*display:none[^>]*aria-hidden="true"[^>]*inert/);
  });

  it("blocks an atomic reset while GitHub viewed state is unresolved", () => {
    const ready = {
      prReviewed: 7,
      prReviewStale: false,
      prReviewRefreshing: false,
      reviewViewedFilesSyncEnabled: true,
      reviewViewedFilesLoading: false,
      reviewFileViewedStates: { "src/a.ts": "VIEWED" as const },
      reviewViewedFilesError: null,
    };

    expect(reviewViewedGestureBlockReason({ ...ready, reviewViewedFilesLoading: true })).toContain("loading");
    expect(reviewViewedGestureBlockReason({
      ...ready,
      reviewFileViewedStates: null,
      reviewViewedFilesError: "permission denied",
    })).toContain("Retry");
    expect(reviewViewedGestureBlockReason({
      ...ready,
      reviewViewedFilesError: "refetch failed",
    })).toContain("Retry");
    expect(reviewViewedGestureBlockReason(ready)).toBeNull();
  });
});

function renderLayout(overrides: Partial<{
  scopeVisible: boolean;
  flowsVisible: boolean;
  filesVisible: boolean;
  footerVisible: boolean;
}> = {}): string {
  return renderToStaticMarkup(
    <ReviewPanelResizableLayout
      header={<span>header state</span>}
      scope={<button>scope state</button>}
      flows={<button>flows state</button>}
      files={<button>files state</button>}
      footer={<button>footer state</button>}
      scopeVisible={overrides.scopeVisible ?? true}
      flowsVisible={overrides.flowsVisible ?? true}
      filesVisible={overrides.filesVisible ?? true}
      footerVisible={overrides.footerVisible ?? true}
    />,
  );
}
