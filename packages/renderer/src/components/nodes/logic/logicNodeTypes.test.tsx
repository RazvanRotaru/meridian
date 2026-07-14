import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { LogicNodeData } from "../../../derive/logicGraph";
import type { DefGroupData, LogicFlowOrientation, LogicRfNode } from "../../../layout/logicElk";
import { ALPHA_RUN, freshStore } from "../../../parity/surfaceFixture";
import { StoreProvider } from "../../../state/StoreContext";
import { BaseNodeActionScope } from "../BaseNode";
import {
  ChangedTag,
  logicNodeTypes,
  syntheticOccurrenceSelectState,
  TargetChangedTag,
  withChanged,
} from "./logicNodeTypes";
import { LogicFlowOrientationProvider } from "./LogicFlowOrientationContext";

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

  it.each([
    ["added", "#3FB950"],
    ["modified", "#E2A33C"],
    ["deleted", "#FF7B82"],
    ["renamed", "#E2A33C"],
  ] as const)("renders a textual accessible %s-callee cue without claiming the call site changed", (status, color) => {
    const markup = renderToStaticMarkup(<TargetChangedTag status={status} />);

    expect(markup).toContain(`aria-label="Call target ${status} in this PR"`);
    expect(markup).toContain('data-pr-target-change-marker="true"');
    expect(markup).toContain(`data-pr-target-change-status="${status}"`);
    expect(markup).toContain(`color:${color}`);
    expect(markup).toContain(`TARGET ${status.toUpperCase()}`);
    expect(markup).not.toContain('data-pr-change-marker="true"');
  });
});

describe("Logic definition-owner frame", () => {
  it("uses BaseNode's trailing disclosure for the shared owner-frame expansion contract", () => {
    const DefGroup = logicNodeTypes.defgroup;
    const data: DefGroupData = {
      targetId: null,
      label: "Repository",
      kind: "interface",
      childCount: 3,
      expandable: true,
      isExpanded: true,
      isContainer: true,
    };
    const props = { id: "module::defgroup/interface", data } as NodeProps<LogicRfNode>;
    const markup = renderToStaticMarkup(
      <BaseNodeActionScope toggleExpand={() => undefined}>
        <DefGroup {...props} />
      </BaseNodeActionScope>,
    );

    expect(markup).toContain('data-base-node="true"');
    expect(markup).toContain('data-base-node-kind="interface"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup.match(/data-base-node-disclosure="true"/g)).toHaveLength(1);
    expect(markup.indexOf("INTERFACE")).toBeLessThan(markup.indexOf("data-base-node-disclosure"));
  });
});
describe("Logic async node composition", () => {
  it("uses the shared kind and semantic rail for a standalone await gate", () => {
    const AsyncNode = logicNodeTypes.async;
    const data: LogicNodeData = {
      logicKind: "await",
      label: "await pending",
      targetId: null,
      resolution: null,
      expandable: false,
      isExpanded: false,
      isContainer: false,
      compact: false,
      callScope: null,
      greyed: false,
      provenance: null,
      childCount: 1,
      awaited: true,
      semantics: { asyncState: { kind: "await", taskCount: 1 } },
      asyncEvent: { kind: "await", mode: "single", inputs: [] },
      asyncPorts: [],
    };
    const props = { id: "flow::await/0", data } as NodeProps<LogicRfNode>;
    const markup = renderToStaticMarkup(
      <ReactFlowProvider><AsyncNode {...props} /></ReactFlowProvider>,
    );

    expect(markup).toContain('data-base-node-kind="await"');
    expect(markup).toContain('data-node-kind-label="await"');
    expect(markup).toContain('data-node-semantic-state="await"');
    expect(markup).toContain("AWAITED");
  });
});

describe("Logic callable semantic composition", () => {
  it("keeps identity, declaration, result, occurrence, and provenance when a card expands into a frame", () => {
    const base: LogicNodeData = {
      logicKind: "call",
      label: "launchInventoryRefresh",
      targetId: ALPHA_RUN,
      resolution: "resolved",
      navigable: true,
      expandable: true,
      isExpanded: false,
      isContainer: false,
      compact: false,
      callScope: "internal",
      greyed: false,
      provenance: { pkg: "inventory-domain", module: "refreshInventory.ts" },
      childCount: 2,
      callKind: "method",
      semantics: {
        modifiers: ["async", "static"],
        returnsPromise: true,
        asyncState: { kind: "launched", binding: "inventoryTask" },
      },
    };
    const collapsed = renderBlock(base);
    const expanded = renderBlock({ ...base, isExpanded: true, isContainer: true });

    for (const markup of [collapsed, expanded]) {
      expect(markup).toContain('data-base-node-kind="method"');
      expect(markup).toContain("METHOD");
      expect(markup).toContain("ASYNC");
      expect(markup).toContain("STATIC");
      expect(markup).toContain("PROMISE");
      expect(markup).toContain("LAUNCHED · inventoryTask");
      expect(markup).toContain("inventory-domain");
      expect(markup).toContain("refreshInventory.ts");
      expect(markup.match(/data-base-node-disclosure="true"/g)).toHaveLength(1);
    }
    expect(collapsed).toContain('data-base-node-expanded="false"');
    expect(expanded).toContain('data-base-node-expanded="true"');
    expect(expanded.indexOf("refreshInventory.ts")).toBeLessThan(expanded.indexOf("data-base-node-disclosure"));
  });

  it("uses the same disclosure and semantic composition for an empty callable's honest expanded state", () => {
    const base: LogicNodeData = {
      logicKind: "call",
      label: "performProtectedWork",
      targetId: ALPHA_RUN,
      resolution: "resolved",
      navigable: true,
      expandable: true,
      isExpanded: false,
      isContainer: false,
      compact: false,
      callScope: "internal",
      greyed: false,
      provenance: { pkg: "orders-service", module: "executionGraphGallery.ts" },
      childCount: 0,
      emptyFlow: true,
      callKind: "method",
      semantics: {
        modifiers: ["async"],
        returnsPromise: true,
        asyncState: { kind: "awaited" },
      },
    };
    const collapsed = renderBlock(base);
    const expanded = renderBlock({ ...base, isExpanded: true, isContainer: true });

    for (const markup of [collapsed, expanded]) {
      expect(markup.match(/data-base-node-disclosure="true"/g)).toHaveLength(1);
      expect(markup).toContain("METHOD");
      expect(markup).toContain("ASYNC");
      expect(markup).toContain("PROMISE");
      expect(markup).toContain("AWAITED");
    }
    expect(collapsed).not.toContain('data-node-empty-expansion="true"');
    expect(expanded).toContain('data-node-empty-expansion="true"');
    expect(expanded).toContain('role="note"');
    expect(expanded).toContain("No charted calls or control flow");
    expect(expanded).toContain('aria-expanded="true"');
  });
});

describe("Logic structural node disclosure", () => {
  const branchPorts = [
    { id: "then", label: "then", role: "then" as const, order: 0 },
    { id: "else", label: "else", role: "else" as const, order: 1 },
  ];
  const exceptionPorts = [
    { id: "try", label: "try", role: "try" as const, order: 0 },
    { id: "catch", label: "catch error", role: "catch" as const, order: 1 },
  ];
  const cases: Array<{
    name: string;
    type: "control" | "branch" | "exception" | "finally";
    kind: LogicNodeData["logicKind"];
    label: string;
    branchPorts?: LogicNodeData["branchPorts"];
  }> = [
    { name: "loop control", type: "control", kind: "loop", label: "for each order" },
    { name: "branch", type: "branch", kind: "if", label: "if order.ready", branchPorts },
    { name: "exception", type: "exception", kind: "try", label: "try/catch", branchPorts: exceptionPorts },
    { name: "finally", type: "finally", kind: "finally", label: "finally" },
  ];

  for (const nodeCase of cases) {
    it(`renders one shared, accessible disclosure for the ${nodeCase.name} in both states`, () => {
      for (const isExpanded of [false, true]) {
        const markup = renderStructuralNode(nodeCase.type, {
          logicKind: nodeCase.kind,
          label: nodeCase.label,
          targetId: null,
          resolution: null,
          expandable: true,
          isExpanded,
          isContainer: nodeCase.type === "control" && isExpanded,
          compact: false,
          callScope: null,
          greyed: false,
          provenance: null,
          childCount: 2,
          branchPorts: nodeCase.branchPorts,
        });

        expect(markup).toContain('data-base-node="true"');
        expect(markup.match(/data-base-node-disclosure="true"/g)).toHaveLength(1);
        expect(markup).toContain(`aria-expanded="${isExpanded}"`);
        expect(markup).toContain(`data-node-disclosure-state="${isExpanded ? "expanded" : "collapsed"}"`);
        expect(markup.toLowerCase()).not.toContain("expand in place");
      }
    });
  }
});

describe("synthetic runtime node snapshots", () => {
  it("renders explicit compact IN/OUT rows and selects only the clicked occurrence", () => {
    const store = freshStore();
    store.setState({
      flowPaneOrigin: "synthetic",
      syntheticSelectedMomentId: "occurrence:first",
    });
    const data: LogicNodeData = {
      logicKind: "call",
      label: "run",
      targetId: ALPHA_RUN,
      resolution: "resolved",
      expandable: false,
      isExpanded: false,
      isContainer: false,
      compact: false,
      callScope: "internal",
      greyed: false,
      provenance: null,
      childCount: 0,
      runtime: {
        kind: "span",
        status: "ok",
        snapshot: {
          input: { amount: 42 },
          output: { accepted: true },
        },
      },
    };

    const selected = renderRuntimeNode(store, "occurrence:first", data);
    const repeated = renderRuntimeNode(store, "occurrence:second", data);

    expect(selected).toContain('data-synthetic-snapshot="occurrence:first"');
    expect(selected).toContain("IN");
    expect(selected).toContain("OUT");
    expect(selected).toContain("{&quot;amount&quot;:42}");
    expect(selected).toContain("{&quot;accepted&quot;:true}");
    expect(repeated).toContain('data-synthetic-snapshot="occurrence:second"');
    expect(syntheticOccurrenceSelectState("occurrence:first", "occurrence:first")).toBe("selected");
    expect(syntheticOccurrenceSelectState("occurrence:second", "occurrence:first")).toBe("dimmed");
    expect(syntheticOccurrenceSelectState("occurrence:first", null)).toBe("none");

    const vertical = renderRuntimeNode(store, "occurrence:first", data, "vertical");
    expect(vertical).toContain("react-flow__handle-top");
    expect(vertical).toContain("react-flow__handle-bottom");
    expect(vertical).not.toContain("react-flow__handle-left");
    expect(vertical).not.toContain("react-flow__handle-right");
  });

  it("keeps failures on the OUT row instead of inventing an output value", () => {
    const store = freshStore();
    store.setState({ flowPaneOrigin: "synthetic" });
    const data = {
      logicKind: "call",
      label: "run",
      targetId: ALPHA_RUN,
      resolution: "resolved",
      expandable: false,
      isExpanded: false,
      isContainer: false,
      compact: false,
      callScope: "internal",
      greyed: false,
      provenance: null,
      childCount: 0,
      runtime: { kind: "span", snapshot: { input: 4, error: "boom" } },
    } satisfies LogicNodeData;

    const html = renderRuntimeNode(store, "occurrence:error", data);
    expect(html).toContain("ERROR · boom");
    expect(html).toContain("OUT");
  });
});

function renderBlock(data: LogicNodeData): string {
  const store = freshStore();
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  const Block = logicNodeTypes.block;
  const props = { id: "flow::call/0", data } as NodeProps<LogicRfNode>;
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <ReactFlowProvider>
        <BaseNodeActionScope toggleExpand={() => undefined}>
          <Block {...props} />
        </BaseNodeActionScope>
      </ReactFlowProvider>
    </StoreProvider>,
  );
}

function renderStructuralNode(
  type: "control" | "branch" | "exception" | "finally",
  data: LogicNodeData,
): string {
  const store = freshStore();
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  const Node = logicNodeTypes[type];
  const props = { id: `flow::${type}/0`, data } as NodeProps<LogicRfNode>;
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <ReactFlowProvider>
        <BaseNodeActionScope toggleExpand={() => undefined}>
          <Node {...props} />
        </BaseNodeActionScope>
      </ReactFlowProvider>
    </StoreProvider>,
  );
}

function renderRuntimeNode(
  store: ReturnType<typeof freshStore>,
  id: string,
  data: LogicNodeData,
  orientation: LogicFlowOrientation = "horizontal",
): string {
  const Block = logicNodeTypes.block as ComponentType<{ id: string; data: LogicNodeData }>;
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <ReactFlowProvider>
        <LogicFlowOrientationProvider value={orientation}>
          <Block id={id} data={data} />
        </LogicFlowOrientationProvider>
      </ReactFlowProvider>
    </StoreProvider>,
  );
}
