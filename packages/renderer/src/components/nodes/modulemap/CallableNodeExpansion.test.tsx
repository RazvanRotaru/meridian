import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider, type Node, type NodeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { StepData } from "../../../derive/flowSteps";
import type { BlockData, ModuleCardData, UnitCardData } from "../../../derive/moduleLevel";
import { freshStore } from "../../../parity/surfaceFixture";
import { StoreProvider } from "../../../state/StoreContext";
import { BaseNodeActionScope } from "../BaseNode";
import { BlockNode } from "./BlockNode";
import { ModuleCardNode } from "./ModuleCardNode";
import { StepNode } from "./StepNode";
import { UnitCardNode } from "./UnitCardNode";

describe("Map callable empty-flow composition", () => {
  it("keeps the same shared block node and disclosure when an empty method expands", () => {
    const base: BlockData = {
      label: "performProtectedWork",
      blockKind: "method",
      callable: true,
      expandable: true,
      emptyFlow: true,
      childCount: 0,
      isExpanded: false,
      semantics: {
        modifiers: ["async"],
        returnsPromise: true,
        asyncState: { kind: "awaited" },
      },
    };
    const collapsed = renderBlock(base);
    const expanded = renderBlock({ ...base, isExpanded: true });

    for (const markup of [collapsed, expanded]) {
      expect(markup.match(/data-base-node="true"/g)).toHaveLength(1);
      expect(markup.match(/data-base-node-disclosure="true"/g)).toHaveLength(1);
      expect(markup).toContain('data-base-node-kind="method"');
      expect(markup).toContain("METHOD");
      expect(markup).toContain("ASYNC");
      expect(markup).toContain("PROMISE");
      expect(markup).toContain("AWAITED");
    }
    expect(collapsed).toContain('data-base-node-expanded="false"');
    expect(collapsed).not.toContain("data-node-empty-expansion");
    expect(expanded).toContain('data-base-node-expanded="true"');
    expect(expanded).toContain('data-node-empty-expansion="true"');
    expect(expanded).toContain("No charted calls or control flow");
  });

  it("uses the same disclosure and empty-state body for a resolved empty call occurrence", () => {
    const base: StepData = {
      label: "visitOrder",
      stepKind: "call",
      nodeKind: "method",
      targetId: "ts:orders.ts#OrderStore.visitOrder",
      resolution: "resolved",
      resolved: true,
      isContainer: true,
      isExpanded: false,
      childCount: 0,
      emptyFlow: true,
      semantics: { returnsPromise: true, asyncState: { kind: "awaited" } },
    };
    const collapsed = renderStep(base);
    const expanded = renderStep({ ...base, isExpanded: true });

    for (const markup of [collapsed, expanded]) {
      expect(markup.match(/data-base-node="true"/g)).toHaveLength(1);
      expect(markup.match(/data-base-node-disclosure="true"/g)).toHaveLength(1);
      expect(markup).toContain('data-base-node-kind="method"');
      expect(markup).toContain("PROMISE");
      expect(markup).toContain("AWAITED");
    }
    expect(collapsed).not.toContain("data-node-empty-expansion");
    expect(expanded).toContain('data-node-empty-expansion="true"');
    expect(expanded).toContain("No charted calls or control flow");
  });
});

describe("Map entity empty-details composition", () => {
  it("uses the shared disclosure and empty expansion for a source-only file", () => {
    const base: ModuleCardData = {
      label: "empty.ts",
      fullPath: "src/empty.ts",
      category: "app",
      inCount: 0,
      outCount: 0,
      isEntry: false,
      isContainer: true,
      isExpanded: false,
      unitCount: 0,
    };
    const collapsed = renderFile(base);
    const expanded = renderFile({ ...base, isExpanded: true });

    expect(collapsed.match(/data-base-node-disclosure="true"/g)).toHaveLength(1);
    expect(collapsed).not.toContain("data-node-empty-expansion");
    expect(expanded.match(/data-base-node-disclosure="true"/g)).toHaveLength(1);
    expect(expanded).toContain('data-node-empty-expansion="true"');
    expect(expanded).toContain("No charted declarations");
  });

  it("uses the shared disclosure and empty expansion for a memberless interface", () => {
    const base: UnitCardData = {
      label: "OrderContract",
      unitKind: "interface",
      memberCount: 0,
      isContainer: true,
      isExpanded: false,
      isFrame: false,
    };
    const collapsed = renderUnit(base);
    const expanded = renderUnit({ ...base, isExpanded: true, isFrame: true });

    expect(collapsed.match(/data-base-node-disclosure="true"/g)).toHaveLength(1);
    expect(collapsed).toContain('data-base-node-kind="interface"');
    expect(expanded.match(/data-base-node-disclosure="true"/g)).toHaveLength(1);
    expect(expanded).toContain('data-node-empty-expansion="true"');
    expect(expanded).toContain("No charted members");
  });
});

function renderBlock(data: BlockData): string {
  const props = { id: "ts:work.ts#Worker.performProtectedWork", data } as NodeProps<Node<BlockData, "block">>;
  return renderNode(<BlockNode {...props} />);
}

function renderStep(data: StepData): string {
  const props = { id: "step:ts:app.ts#run:0", data } as NodeProps<Node<StepData, "step">>;
  return renderNode(<StepNode {...props} />);
}

function renderFile(data: ModuleCardData): string {
  const props = { id: "ts:src/empty.ts", data } as NodeProps<Node<ModuleCardData, "file">>;
  return renderNode(<ModuleCardNode {...props} />);
}

function renderUnit(data: UnitCardData): string {
  const props = { id: "ts:src/contracts.ts#OrderContract", data } as NodeProps<Node<UnitCardData, "unit">>;
  return renderNode(<UnitCardNode {...props} />);
}

function renderNode(node: React.ReactNode): string {
  const store = freshStore();
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <ReactFlowProvider>
        <BaseNodeActionScope toggleExpand={() => undefined} navigateInto={() => undefined}>
          {node}
        </BaseNodeActionScope>
      </ReactFlowProvider>
    </StoreProvider>,
  );
}
