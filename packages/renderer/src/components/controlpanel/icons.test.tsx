import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodePreviewVisibilityIcon } from "./icons";

describe("CodePreviewVisibilityIcon", () => {
  it("keeps the selected braces-over-preview-cards glyph decorative and color-adaptive", () => {
    const markup = renderToStaticMarkup(<CodePreviewVisibilityIcon size={18} />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("width:18px");
    expect(markup).toContain("height:18px");
    expect(markup).toContain("opacity:0.58");
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain("-webkit-mask-image:url(");
    expect(markup).toContain("mask-image:url(");
    expect(markup.match(/<svg/g)).toHaveLength(1);
    expect(markup).not.toMatch(/aria-label=|role=|<title/);
  });
});
