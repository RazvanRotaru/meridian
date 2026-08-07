import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLOATING_SOURCE_WINDOW_ID,
  FloatingSourceWindow,
  floatingSourceWindowRailMode,
  type FloatingSourceWindowControls,
} from "./FloatingSourceWindow";
import { SOURCE_WINDOW_RAIL_COLLAPSE_WIDTH } from "./sourceWindowGeometry";

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("FloatingSourceWindow", () => {
  it("renders one sticky modeless window with side rail and accessible resize edges", () => {
    let mainControls: FloatingSourceWindowControls | null = null;
    let railControls: FloatingSourceWindowControls | null = null;
    const markup = renderToStaticMarkup(
      <FloatingSourceWindow
        ariaLabel="Source code"
        railLabel="Related code blocks"
        railCount={3}
        onClose={() => {}}
        main={(controls) => {
          mainControls = controls;
          return <div {...controls.headerDragProps}>Source body</div>;
        }}
        rail={(controls) => {
          railControls = controls;
          return <div>Related rail</div>;
        }}
      />,
    );

    const layer = elementWithDataAttribute(markup, "data-floating-source-window-layer");
    const host = elementWithDataAttribute(markup, "data-floating-source-window-host");
    expect(layer).toContain("pointer-events:none");
    expect(layer).toContain("background:transparent");
    expect(host).toContain(`id="${FLOATING_SOURCE_WINDOW_ID}"`);
    expect(host).toContain('role="dialog"');
    expect(host).toContain('aria-label="Source code"');
    expect(host).not.toContain("aria-modal");
    expect(host).toContain("pointer-events:auto");
    expect(host).toContain("overflow:hidden");
    expect(host).toContain("left:12px");
    expect(host).toContain("top:12px");
    expect(host).toContain("width:1200px");
    expect(host).toContain("height:700px");

    expect(markup).toContain('data-source-window-rail-mode="side"');
    expect(markup).toContain('role="complementary"');
    expect(markup).toContain('aria-label="Related code blocks"');
    expect(markup).toContain('data-source-window-rail-count="3"');
    expect(markup).toContain("Source body");
    expect(markup).toContain("Related rail");

    expect(markup.match(/data-source-window-resize-zone=/g)).toHaveLength(8);
    expect(markup.match(/role="separator"/g)).toHaveLength(4);
    for (const label of [
      "Resize source window from top edge",
      "Resize source window from right edge",
      "Resize source window from bottom edge",
      "Resize source window from left edge",
    ]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).toContain('aria-valuetext="Source window 1200 pixels wide"');
    expect(markup).toContain('aria-valuetext="Source window 700 pixels tall"');

    expect(mainControls).not.toBeNull();
    expect(railControls).toBe(mainControls);
    expect(mainControls!.headerDragProps["data-source-window-drag-handle"]).toBe("true");
    expect(mainControls!.moveHandleProps["aria-label"]).toBe("Move source window");
    expect(mainControls!.moveHandleProps["data-source-window-move-control"]).toBe("true");
    expect(typeof mainControls!.moveHandleProps.onPointerDown).toBe("function");
    expect(typeof mainControls!.moveHandleProps.onKeyDown).toBe("function");
    expect(mainControls!.railCollapsed).toBe(false);
    expect(mainControls!.railOpen).toBe(false);
    expect(typeof mainControls!.resetGeometry).toBe("function");
    expect(typeof mainControls!.toggleRail).toBe("function");
  });

  it("uses a compact overlay only when a narrow window explicitly opens the rail", () => {
    expect(floatingSourceWindowRailMode(SOURCE_WINDOW_RAIL_COLLAPSE_WIDTH, false)).toBe("side");
    expect(floatingSourceWindowRailMode(SOURCE_WINDOW_RAIL_COLLAPSE_WIDTH - 1, false)).toBe("hidden");
    expect(floatingSourceWindowRailMode(SOURCE_WINDOW_RAIL_COLLAPSE_WIDTH - 1, true)).toBe("overlay");
    expect(floatingSourceWindowRailMode(Number.NaN, true)).toBe("overlay");
  });
});

function elementWithDataAttribute(markup: string, attribute: string): string {
  return markup.match(new RegExp(`<div(?=[^>]*${attribute})[^>]*>`))?.[0] ?? "";
}
