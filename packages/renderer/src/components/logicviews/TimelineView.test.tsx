import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlowStep, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../../graph/graphIndex";
import { TimelineView } from "./TimelineView";

const ROOT = "ts:src/run.ts#run";
const TARGET = "ts:src/work.ts#work";
const STEPS: FlowStep[] = [
  { kind: "call", label: "work", target: TARGET, resolution: "resolved" },
  { kind: "exit", variant: "return", label: "done" },
];
const FLOWS: LogicFlows = {
  [TARGET]: [{ kind: "exit", variant: "return", label: null }],
};
const INDEX = {
  nodesById: new Map([
    [TARGET, { id: TARGET, kind: "function", location: { file: "src/work.ts", startLine: 1 } }],
  ]),
  changedStatus: new Map([[TARGET, "modified"]]),
} as unknown as GraphIndex;

function render(selected: string | null = null, drillEnabled = true) {
  return renderToStaticMarkup(
    <TimelineView
      density="compact"
      rootId={ROOT}
      steps={STEPS}
      flows={FLOWS}
      index={INDEX}
      selected={selected}
      drillEnabled={drillEnabled}
      onSelect={() => undefined}
      onDrill={() => undefined}
    />,
  );
}

describe("TimelineView", () => {
  it("renders target-bearing items as keyboard-accessible selection buttons", () => {
    const markup = render(TARGET);

    expect(markup).toMatch(/<button(?=[^>]*type="button")(?=[^>]*aria-pressed="true")[^>]*>/);
    expect(markup).toContain('aria-keyshortcuts="Shift+Enter"');
    expect(markup).toContain("work");
  });

  it("does not advertise drill navigation in the review-only Timeline", () => {
    expect(render(null, false)).not.toContain("aria-keyshortcuts");
  });

  it("labels an unchanged call whose target is modified without using the call-site change marker", () => {
    const markup = render();

    expect(markup).toContain("TARGET MODIFIED");
    expect(markup).toContain('aria-label="Call target modified in this PR"');
    expect(markup).toContain('data-pr-target-change-status="modified"');
    expect(markup).toContain("bottom:-20px");
    expect(markup).not.toContain('data-pr-change-marker="true"');
  });

  it("does not dim the whole Timeline when review focus points inside a summarized loop", () => {
    const markup = renderToStaticMarkup(
      <TimelineView
        density="compact"
        rootId={ROOT}
        steps={[{ kind: "loop", label: "for each item", body: STEPS }]}
        flows={FLOWS}
        index={INDEX}
        selected={TARGET}
        drillEnabled={false}
        onSelect={() => undefined}
        onDrill={() => undefined}
      />,
    );

    expect(markup).toContain("for each item");
    expect(markup).not.toContain("opacity:0.55");
  });

  it("keeps the compact return label inside the scrollable surface", () => {
    const markup = render();

    expect(markup).toMatch(/top:18px[^>]*><span[^>]*top:-14px[^>]*>function returns<\/span>/);
  });
});
