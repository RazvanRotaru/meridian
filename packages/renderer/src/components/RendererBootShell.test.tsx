import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RendererBootShell } from "./RendererBootShell";

describe("RendererBootShell", () => {
  it("commits renderer toolbar/canvas geometry instead of a centered splash", () => {
    const markup = renderToStaticMarkup(createElement(RendererBootShell));
    expect(markup).toContain('data-testid="renderer-boot-shell"');
    expect(markup).toContain("Loading the first bounded graph view");
    expect(markup).toContain('aria-busy="true"');
  });
});
