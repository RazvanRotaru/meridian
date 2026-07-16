import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlowStep, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../../graph/graphIndex";
import { TimelineView } from "./TimelineView";

const ROOT = "ts:src/run.ts#run";
const TARGET = "ts:src/work.ts#work";
const STEPS: FlowStep[] = [
  { kind: "call", label: "work()", target: TARGET, resolution: "resolved" },
  { kind: "exit", variant: "return", label: "done" },
];
const FLOWS: LogicFlows = {
  [TARGET]: [{ kind: "exit", variant: "return", label: null }],
};
const INDEX = {
  nodesById: new Map([
    [ROOT, { id: ROOT, kind: "function", displayName: "run", location: { file: "src/run.ts", startLine: 1 } }],
    [TARGET, { id: TARGET, kind: "function", displayName: "work", location: { file: "src/work.ts", startLine: 1 } }],
  ]),
  changedStatus: new Map([[TARGET, "modified"]]),
} as unknown as GraphIndex;

function render(drillEnabled = true, showZoomControls = false) {
  return renderToStaticMarkup(
    <TimelineView
      density="compact"
      rootId={ROOT}
      steps={STEPS}
      flows={FLOWS}
      index={INDEX}
      selected={TARGET}
      drillEnabled={drillEnabled}
      showZoomControls={showZoomControls}
      onSelect={() => undefined}
      onDrill={() => undefined}
    />,
  );
}

describe("TimelineView compatibility export", () => {
  it("renders the participant sequence projection for the persisted timeline mode", () => {
    const markup = render();

    expect(markup).toContain('aria-label="Static sequence diagram"');
    expect(markup).toContain('data-sequence-message-kind="call"');
    expect(markup).not.toContain('data-sequence-message-kind="return"');
    expect(markup).toContain("Return from work to run: returns.");
    expect(markup).toContain("TARGET MODIFIED");
    expect(markup).toContain('aria-label="Select call target work()"');
  });

  it("supports review-safe navigation and local zoom controls", () => {
    const markup = render(false, true);

    expect(markup).not.toContain("aria-keyshortcuts");
    expect(markup).toContain('aria-label="Sequence diagram zoom"');
  });
});
