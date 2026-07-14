import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlowStep, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../../graph/graphIndex";
import type { FlowViewProps } from "../../derive/flowViewModel";
import { BlocksView } from "./BlocksView";
import { MetroView } from "./MetroView";

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
    [ROOT, { id: ROOT, kind: "function", displayName: "run", location: { file: "src/run.ts", startLine: 1 } }],
    [TARGET, { id: TARGET, kind: "function", location: { file: "src/work.ts", startLine: 1 } }],
  ]),
  changedStatus: new Map([[TARGET, "modified"]]),
} as unknown as GraphIndex;

function viewProps(drillEnabled: boolean): FlowViewProps & { density: "compact"; drillEnabled: boolean } {
  return {
    density: "compact",
    drillEnabled,
    rootId: ROOT,
    steps: STEPS,
    flows: FLOWS,
    index: INDEX,
    selected: TARGET,
    onSelect: () => undefined,
    onDrill: () => undefined,
  };
}

describe("compact alternate flow projections", () => {
  it("renders Metro targets as buttons without review-only drill shortcuts", () => {
    const markup = renderToStaticMarkup(<MetroView {...viewProps(false)} />);

    expect(markup).toContain('<svg width=');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toMatch(/<button(?=[^>]*type="button")(?=[^>]*aria-pressed="true")[^>]*>/);
    expect(markup).not.toContain("aria-keyshortcuts");
  });

  it("renders Blocks targets as buttons without review-only drill shortcuts", () => {
    const markup = renderToStaticMarkup(<BlocksView {...viewProps(false)} />);

    expect(markup).toContain("▶ run");
    expect(markup).toMatch(/<button(?=[^>]*type="button")(?=[^>]*aria-pressed="true")[^>]*>/);
    expect(markup).not.toContain("aria-keyshortcuts");
  });

  it("distinguishes a dropped result from a proven Promise handoff in Blocks", () => {
    const generic = renderToStaticMarkup(
      <BlocksView {...viewProps(false)} steps={[{ ...STEPS[0] as Extract<FlowStep, { kind: "call" }>, detached: true }]} />,
    );
    const promise = renderToStaticMarkup(
      <BlocksView
        {...viewProps(false)}
        steps={[{
          ...STEPS[0] as Extract<FlowStep, { kind: "call" }>,
          detached: true,
          async: { kind: "launch", taskId: "task:work" },
        }]}
      />,
    );

    expect(generic).toContain("RESULT DROPPED");
    expect(generic).not.toContain("HANDED OFF · RUNS LATER");
    expect(promise).toContain("PROMISE · NOT AWAITED");
    expect(promise).toContain("HANDED OFF · RUNS LATER");
  });

  it.each([
    ["Metro", MetroView],
    ["Blocks", BlocksView],
  ] as const)("labels modified callees in the %s projection without marking the source call changed", (_name, View) => {
    const markup = renderToStaticMarkup(<View {...viewProps(false)} />);

    expect(markup).toContain("TARGET MODIFIED");
    expect(markup).toContain('aria-label="Call target modified in this PR"');
    expect(markup).toContain('data-pr-target-change-status="modified"');
    expect(markup).not.toContain('data-pr-change-marker="true"');
  });

  it.each([
    ["Metro", MetroView],
    ["Blocks", BlocksView],
  ] as const)("does not dim the %s projection when the navigator focuses its changed root", (_name, View) => {
    const markup = renderToStaticMarkup(<View {...viewProps(false)} selected={ROOT} />);

    expect(markup).not.toContain('aria-pressed="true"');
    expect(markup).not.toContain("opacity:0.55");
    expect(markup).not.toContain("opacity:0.82");
  });

  it.each([
    ["Metro", MetroView],
    ["Blocks", BlocksView],
  ] as const)("keeps the %s standalone drill shortcut", (_name, View) => {
    const markup = renderToStaticMarkup(<View {...viewProps(true)} />);

    expect(markup).toContain('aria-keyshortcuts="Shift+Enter"');
  });
});
