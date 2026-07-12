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

  it.each([
    ["Metro", MetroView],
    ["Blocks", BlocksView],
  ] as const)("keeps the %s standalone drill shortcut", (_name, View) => {
    const markup = renderToStaticMarkup(<View {...viewProps(true)} />);

    expect(markup).toContain('aria-keyshortcuts="Shift+Enter"');
  });
});
