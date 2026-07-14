import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Node } from "@xyflow/react";
import type { RequestTrace, SyntheticScenarioDescriptor } from "@meridian/core";
import { STATIC_LOGIC_VIEW_MODES } from "../../derive/flowViewModel";
import {
  flowPanePresentation,
  flowPaneNavigationTarget,
  flowPaneShouldRender,
  FlowChangeNavigator,
  flowPaneFocusNode,
  focusedOpeningCenter,
  preferredSyntheticScenario,
  requestFlowContext,
  shouldAutoFitFlowPane,
  syntheticScenariosForRoot,
} from "./FlowPane";

describe("flowPanePresentation", () => {
  it.each(STATIC_LOGIC_VIEW_MODES)("uses the reader's configured $mode projection during PR review", ({ mode }) => {
    expect(flowPanePresentation(true, mode)).toBe(mode);
  });

  it.each(STATIC_LOGIC_VIEW_MODES)("keeps the ordinary Code flows explorer on its execution graph when $mode is preferred", ({ mode }) => {
    expect(flowPanePresentation(false, mode)).toBe("graph");
  });
});

describe("flowPaneNavigationTarget", () => {
  it("routes a navigable static occurrence to its canonical callable", () => {
    expect(flowPaneNavigationTarget({ targetId: "ts:orders.ts#visitOrder", canNavigate: true }))
      .toBe("ts:orders.ts#visitOrder");
  });

  it("keeps structural, runtime-only, and unresolved moments in the pane", () => {
    expect(flowPaneNavigationTarget({ targetId: null, canNavigate: true })).toBeNull();
    expect(flowPaneNavigationTarget({ targetId: "ts:orders.ts#visitOrder", canNavigate: false })).toBeNull();
  });
});

describe("flowPaneShouldRender", () => {
  it("hides only the review split when automatic opening is disabled", () => {
    expect(flowPaneShouldRender(true, false)).toBe(false);
    expect(flowPaneShouldRender(true, true)).toBe(true);
  });

  it("keeps ordinary Code-flow panes visible regardless of the review preference", () => {
    expect(flowPaneShouldRender(false, false)).toBe(true);
    expect(flowPaneShouldRender(false, true)).toBe(true);
  });
});

describe("request flow pane context", () => {
  it("summarizes the whole selected request rather than one clicked callable", () => {
    const trace = {
      name: "POST /orders",
      status: "error",
      startedAtUnixNano: "1000000000",
      endedAtUnixNano: "1045000000",
      completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
      spans: [
        { nodeId: "run", events: [{}, {}] },
        { nodeId: "run", events: [{}] },
        { nodeId: "other", events: Array(5).fill({}) },
      ],
    } as unknown as RequestTrace;

    expect(requestFlowContext(trace, "staging")).toEqual({
      requestName: "POST /orders",
      environment: "staging",
      status: "error",
      spanCount: 3,
      eventCount: 8,
      durationMs: 45,
      complete: true,
    });
    expect(requestFlowContext(null, "staging")).toBeNull();
  });
});

describe("request flow camera fitting", () => {
  it("fits a mounted request trace only once but keeps static pane relayout fitting", () => {
    expect(shouldAutoFitFlowPane(true, false)).toBe(true);
    expect(shouldAutoFitFlowPane(true, true)).toBe(false);
    expect(shouldAutoFitFlowPane(false, false)).toBe(true);
    expect(shouldAutoFitFlowPane(false, true)).toBe(true);
  });

  it("centers focused child steps in absolute graph coordinates instead of their container origin", () => {
    const parent = { id: "root", position: { x: 100, y: 200 }, width: 600, height: 500 } as Node;
    const first = { id: "first", parentId: "root", position: { x: 20, y: 40 }, width: 200, height: 60 } as Node;
    const second = { id: "second", parentId: "root", position: { x: 20, y: 180 }, width: 180, height: 60 } as Node;

    expect(focusedOpeningCenter([first, second], [parent, first, second])).toEqual({ x: 220, y: 340 });
  });
});

describe("synthetic scenario selection", () => {
  const scenarios: SyntheticScenarioDescriptor[] = [{
    id: "happy",
    label: "Happy path",
    rootId: "ts:src/order.ts#placeOrder",
    defaultInput: { valid: true },
  }, {
    id: "validation-error",
    label: "Validation error",
    rootId: "ts:src/order.ts#placeOrder",
    defaultInput: { valid: false },
  }, {
    id: "other-root",
    label: "Other",
    rootId: "ts:src/other.ts#run",
    defaultInput: null,
  }];

  it("keeps every advertised scenario for the selected root and honors the explicit choice", () => {
    const matching = syntheticScenariosForRoot(scenarios, "ts:src/order.ts#placeOrder");
    expect(matching.map((scenario) => scenario.id)).toEqual(["happy", "validation-error"]);
    expect(preferredSyntheticScenario(matching, "validation-error")?.id).toBe("validation-error");
    expect(preferredSyntheticScenario(matching, "missing")?.id).toBe("happy");
  });
});

describe("review flow change navigation", () => {
  it("exposes an explicit, status-named focus action that is not color-only", () => {
    const markup = renderToStaticMarkup(createElement(FlowChangeNavigator, {
      changes: [{ targetId: "target", status: "modified", label: "validateOrder" }],
      selectedTarget: null,
      onFocus: () => undefined,
    }));

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Changed nodes in this logic flow"');
    expect(markup).toContain('aria-label="Focus modified node validateOrder"');
    expect(markup).toContain("MODIFIED");
    expect(markup).toContain("validateOrder");
  });

  it("uses the legible deletion text color while retaining deletion semantics", () => {
    const markup = renderToStaticMarkup(createElement(FlowChangeNavigator, {
      changes: [{ targetId: "target", status: "deleted", label: "oldHandler" }],
      selectedTarget: null,
      onFocus: () => undefined,
    }));

    expect(markup).toContain("color:#FF7B82");
    expect(markup).toContain("DELETED");
    expect(markup).toContain('aria-label="Focus deleted node oldHandler"');
  });

  it("prefers a changed root entry over a recursive occurrence and resolves other targets", () => {
    const nodes = [
      { id: "root::entry", position: { x: 0, y: 0 }, data: { targetId: null } },
      { id: "root::recursive", position: { x: 50, y: 0 }, data: { targetId: "root" } },
      { id: "root::0", position: { x: 100, y: 0 }, data: { targetId: "target" } },
      { id: "root::1", position: { x: 200, y: 0 }, data: { targetId: "target" } },
    ] as Node[];

    expect(flowPaneFocusNode(nodes, "target")?.id).toBe("root::0");
    expect(flowPaneFocusNode(nodes, "root")?.id).toBe("root::entry");
    expect(flowPaneFocusNode(nodes, "missing")).toBeNull();
  });
});
