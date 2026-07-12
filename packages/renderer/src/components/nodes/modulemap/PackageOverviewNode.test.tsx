import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  RollupExpandControl,
  activateRollupExpansion,
} from "./PackageOverviewNode";

describe("review rollup expansion", () => {
  it("renders a dedicated accessible button instead of making the card body the control", () => {
    const markup = renderToStaticMarkup(
      <RollupExpandControl count={3} onExpand={() => undefined} />,
    );

    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('class="nodrag nopan"');
    expect(markup).toContain('aria-label="Expand 3 changed file(s)"');
    expect(markup).toContain("3 files ▸");
  });

  it("consumes only the explicit control click before expanding", () => {
    const stopPropagation = vi.fn();
    const expand = vi.fn();

    activateRollupExpansion({ stopPropagation }, expand);

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(expand).toHaveBeenCalledOnce();
  });
});
