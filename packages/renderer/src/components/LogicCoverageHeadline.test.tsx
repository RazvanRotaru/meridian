import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExecutionCoverageHeadline } from "./LogicFlowView";

describe("Logic runtime coverage headline", () => {
  it("keeps callee execution separate from selected branch-path coverage", () => {
    const markup = renderToStaticMarkup(
      <ExecutionCoverageHeadline
        root={{ status: "covered", label: "Executed", sub: "2 aggregate hits" }}
        flow={{ covered: 1, uncovered: 0, total: 1 }}
        branches={{ hit: 2, total: 4, percent: 50 }}
        hasLaneSignals
      />,
    );

    expect(markup).toContain("Visible callees executed");
    expect(markup).toContain("100%");
    expect(markup).toContain("1/1 functions");
    expect(markup).toContain("Selected branch paths");
    expect(markup).toContain("50%");
    expect(markup).toContain("2/4 paths");
    expect(markup).toContain("Selected Logic branch coverage: 50%, 2 of 4 measured paths hit");
    expect(markup).toContain("Istanbul aggregate · not per-test attribution");
    expect(markup).not.toContain("test reachability");
  });

  it("does not invent a percentage when no branch path is measurable", () => {
    const markup = renderToStaticMarkup(
      <ExecutionCoverageHeadline
        root={{ status: "covered", label: "Executed", sub: "1 aggregate hit" }}
        flow={null}
        branches={null}
        hasLaneSignals
      />,
    );

    expect(markup).not.toContain("Selected branch paths");
    expect(markup).toContain("unknown");
  });
});
