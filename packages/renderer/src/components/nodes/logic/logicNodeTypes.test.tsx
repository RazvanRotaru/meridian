import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangedTag, withChanged } from "./logicNodeTypes";

describe("logic PR-change paint", () => {
  it("washes the whole node, keeps external hatching, and strengthens a dimmed changed node", () => {
    const style = withChanged({
      opacity: 0.5,
      backgroundImage: "repeating-linear-gradient(-45deg, transparent 0 8px, #fff 8px 10px)",
    }, "#E2A33C", "dimmed");

    expect(style.opacity).toBe(0.82);
    expect(style.backgroundImage).toContain("linear-gradient(#E2A33C2E, #E2A33C2E)");
    expect(style.backgroundImage).toContain("repeating-linear-gradient");
    expect(style.outline).toBe("2px solid #E2A33C");
    expect(style.boxShadow).toContain("#E2A33CDD");
  });

  it("keeps selection's ring while retaining the PR body wash", () => {
    const style = withChanged({ boxShadow: "0 0 0 2px #6BE38A" }, "#3FB950", "selected");

    expect(style.boxShadow).toBe("0 0 0 2px #6BE38A");
    expect(style.outline).toBeUndefined();
    expect(style.backgroundImage).toBe("linear-gradient(#3FB9502E, #3FB9502E)");
  });

  it("normalizes the unchanged background too, avoiding shorthand/longhand transitions", () => {
    const style = withChanged({ background: "#10151C" }, null, "none");

    expect(style.background).toBeUndefined();
    expect(style.backgroundColor).toBe("#10151C");
    expect(style.backgroundImage).toBeUndefined();
  });

  it("preserves a structural node's gradient while layering PR status paint", () => {
    const style = withChanged({ background: "linear-gradient(90deg, #111, #222)" }, "#E5484D", "none");

    expect(style.backgroundColor).toBeUndefined();
    expect(style.backgroundImage).toContain("linear-gradient(#E5484D2E, #E5484D2E)");
    expect(style.backgroundImage).toContain("linear-gradient(90deg, #111, #222)");
  });

  it("renders a filled accessible beacon that survives overview zoom", () => {
    const markup = renderToStaticMarkup(<ChangedTag color="#E5484D" />);

    expect(markup).toContain('aria-label="Changed in this PR"');
    expect(markup).toContain('data-pr-change-marker="true"');
    expect(markup).toContain("background:#E5484D33");
    expect(markup).toContain("Δ");
  });
});
