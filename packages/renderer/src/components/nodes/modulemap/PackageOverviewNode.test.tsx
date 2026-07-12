import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  RollupExpandControl,
  RollupExpandableBody,
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

  it("makes the rolled directory body itself an expansion surface", () => {
    const expand = vi.fn();
    const element = RollupExpandableBody({
      expandable: true,
      onExpand: expand,
      children: "directory",
    });
    const stopPropagation = vi.fn();

    expect(element.props.style).toMatchObject({ cursor: "pointer" });
    element.props.onClick?.({ stopPropagation } as never);

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(expand).toHaveBeenCalledOnce();
  });

  it("leaves ordinary package bodies inert", () => {
    const element = RollupExpandableBody({
      expandable: false,
      onExpand: vi.fn(),
      children: "directory",
    });

    expect(element.props.style).not.toMatchObject({ cursor: "pointer" });
    expect(element.props.onClick).toBeUndefined();
  });

  it("consumes the explicit control click before expanding", () => {
    const stopPropagation = vi.fn();
    const expand = vi.fn();

    activateRollupExpansion({ stopPropagation }, expand);

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(expand).toHaveBeenCalledOnce();
  });
});
