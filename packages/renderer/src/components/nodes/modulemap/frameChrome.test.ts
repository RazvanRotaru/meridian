import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FrameTitleBar, resolveSurfaceExpandAction } from "./frameChrome";

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
