import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GraphLayoutIndicator } from "./GraphLayoutIndicator";

describe("GraphLayoutIndicator", () => {
  it("announces the active operation and its clustering detail", () => {
    const markup = renderToStaticMarkup(
      <GraphLayoutIndicator label="Updating service layout…" detail="Least coupling · target 8" />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain("Updating service layout…");
    expect(markup).toContain("Least coupling · target 8");
  });

  it("omits an empty detail row", () => {
    const markup = renderToStaticMarkup(<GraphLayoutIndicator label="Arranging graph…" />);
    expect(markup).toContain("Arranging graph…");
    expect(markup).not.toContain("Least coupling");
  });
});
