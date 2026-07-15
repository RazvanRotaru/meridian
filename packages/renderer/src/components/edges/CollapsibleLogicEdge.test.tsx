import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LogicRfEdgeData } from "../../layout/logicElk";
import { EdgeCollapseControl } from "./CollapsibleLogicEdge";
import { LogicEdgeActionScope } from "./LogicEdgeActionScope";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    EdgeToolbar: ({ children }: { children: React.ReactNode }) => <div data-edge-toolbar="true">{children}</div>,
  };
});

describe("EdgeCollapseControl", () => {
  it("makes a labeled branch path visibly foldable at rest", () => {
    const markup = renderControl({
      kind: "branch",
      collapsible: true,
      collapseKey: "branch:then",
      branchRole: "then",
    }, "then");

    expect(markup).toContain('aria-label="Collapse only the then path"');
    expect(markup).toContain('data-edge-fold-cue="persistent-branch"');
    expect(markup).toContain("opacity:1");
    expect(markup).toContain("pointer-events:auto");
  });

  it("keeps unlabeled and non-branch edge controls quiet until hover or focus", () => {
    const unlabeledBranch = renderControl({
      kind: "branch",
      collapsible: true,
      collapseKey: "branch:unlabeled",
    });
    const labeledSequence = renderControl({
      kind: "seq",
      collapsible: true,
      collapseKey: "seq:labeled",
    }, "contains");

    for (const markup of [unlabeledBranch, labeledSequence]) {
      expect(markup).toContain('data-edge-fold-cue="hover"');
      expect(markup).toContain("opacity:0");
      expect(markup).toContain("pointer-events:none");
    }
  });
});

function renderControl(data: LogicRfEdgeData, label?: string): string {
  return renderToStaticMarkup(
    <LogicEdgeActionScope toggleCollapse={() => undefined}>
      <EdgeCollapseControl edgeId="edge" x={100} y={100} data={data} label={label} />
    </LogicEdgeActionScope>,
  );
}
