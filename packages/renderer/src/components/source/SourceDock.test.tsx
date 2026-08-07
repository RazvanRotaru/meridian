import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SOURCE_DOCK_RESIZE_HIT_WIDTH, SourceDock } from "./SourceDock";

describe("SourceDock", () => {
  it("renders a shell-level modal sheet with one truthful responsive separator contract", () => {
    const markup = renderToStaticMarkup(
      <SourceDock ariaLabel="Source code" onClose={() => {}}>
        {({ expanded, initialFocusRef }) => (
          <button
            ref={(node) => { initialFocusRef.current = node; }}
            data-expanded={expanded ? "true" : "false"}
          >
            Search source
          </button>
        )}
      </SourceDock>,
    );

    expect(markup).toContain('data-source-code-dock-layer="true"');
    expect(markup).toContain('pointer-events:auto');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Source code"');
    expect(markup).toContain('data-source-code-dock-host="true"');
    expect(markup).toContain('width:60%');
    expect(markup).toContain('aria-label="Resize source dock"');
    expect(markup).toContain('aria-valuemin="40"');
    expect(markup).toContain('aria-valuemax="90"');
    expect(markup).toContain('aria-valuenow="60"');
    expect(markup).toContain('aria-valuetext="Source dock 60% of workspace width"');
    expect(markup).toContain('data-source-code-resize-handle="true"');
    expect(markup).toContain(`inset:0 auto 0 -${SOURCE_DOCK_RESIZE_HIT_WIDTH / 2}px`);
    expect(markup).toContain(`width:${SOURCE_DOCK_RESIZE_HIT_WIDTH}px`);
    expect(markup).toContain('background:transparent');
    expect(markup).toContain('width:2px');
    expect(markup).toContain('data-expanded="false"');
  });
});
