import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  RollupExpandControl,
  RollupExpandableBody,
  activateRollupExpansion,
  rollupExpansionFileCount,
} from "./PackageOverviewNode";

describe("review directory expansion", () => {
  it("renders a dedicated accessible button instead of making the card body the control", () => {
    const markup = renderToStaticMarkup(
      <RollupExpandControl count={3} onExpand={() => undefined} />,
    );

    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('class="nodrag nopan"');
    expect(markup).toContain('aria-label="Expand all 3 source files"');
    expect(markup).toContain("3 files ▸");
  });

  it("advertises every source file rather than only the changed rollup members", () => {
    expect(rollupExpansionFileCount(6, 5, false)).toBe(6);
    expect(rollupExpansionFileCount(6, 0, false)).toBe(0);
    expect(rollupExpansionFileCount(6, 5, true)).toBe(0);
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
