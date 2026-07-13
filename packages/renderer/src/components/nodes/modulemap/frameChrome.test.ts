import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FrameTitleBar, frameTitleBarStyle, resolveSurfaceExpandAction, TITLE_BAR } from "./frameChrome";

describe("Map container title", () => {
  it("keeps the shared disclosure control in the title tail", () => {
    const markup = renderToStaticMarkup(createElement(
      FrameTitleBar,
      {
        chevron: createElement("button", { "aria-label": "Expand" }, "▸"),
        children: createElement("span", null, "directory"),
      },
    ));

    expect(markup.indexOf("directory")).toBeLessThan(markup.indexOf('aria-label="Expand"'));
  });

  it.each([
    ["added", "#3FB950"],
    ["modified", "#E2A33C"],
    ["deleted", "#E5484D"],
    ["renamed", "#E2A33C"],
  ] as const)("colours a %s container title from the shared change palette", (status, color) => {
    expect(frameTitleBarStyle(status)).toMatchObject({
      borderBottomColor: color,
      backgroundImage: `linear-gradient(0deg, ${color}66, ${color}66)`,
    });
  });

  it("keeps an unchanged container title on the resting style", () => {
    expect(frameTitleBarStyle(undefined)).toBe(TITLE_BAR);
  });

  it("wires the status style through the shared title component", () => {
    const markup = renderToStaticMarkup(createElement(
      FrameTitleBar,
      {
        status: "deleted",
        children: createElement("span", null, "removed directory"),
      },
    ));

    expect(markup).toContain("border-bottom-color:#E5484D");
    expect(markup).toContain("linear-gradient(0deg, #E5484D66, #E5484D66)");
  });
});

describe("surface expansion action", () => {
  it("keeps a fully frozen read-only surface without disclosure", () => {
    expect(resolveSurfaceExpandAction(true, null, vi.fn())).toBeNull();
  });

  it("lets a read-only surface expose its own presentation-local disclosure", () => {
    const local = vi.fn();
    const store = vi.fn();
    const action = resolveSurfaceExpandAction(true, local, store);

    action?.("package");

    expect(action).toBe(local);
    expect(local).toHaveBeenCalledWith("package");
    expect(store).not.toHaveBeenCalled();
  });

  it("retains the shared store action on an ordinary interactive surface", () => {
    const store = vi.fn();
    expect(resolveSurfaceExpandAction(false, null, store)).toBe(store);
  });
});
