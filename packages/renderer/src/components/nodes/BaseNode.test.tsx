import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BaseNode, BaseNodeActionScope, NodeDisclosure, type BaseNodeModel } from "./BaseNode";

const KINDS = ["folder", "file", "class", "interface", "object", "method", "function"] as const;
const STYLE: React.CSSProperties = {};

function model(kind: string, expanded = false): BaseNodeModel {
  return {
    instanceId: `instance:${kind}`,
    targetId: `target:${kind}`,
    nodeType: kind,
    kind,
    label: kind,
    childCount: 1,
    canExpand: true,
    expanded,
    canNavigate: true,
    data: {},
  };
}

function render(modelValue: BaseNodeModel, actions: React.ReactNode = <span data-decoration="true">status</span>) {
  return renderToStaticMarkup(
    <BaseNodeActionScope toggleExpand={() => undefined} navigateInto={() => undefined}>
      <BaseNode
        model={modelValue}
        style={STYLE}
        headerStyle={STYLE}
        labelStyle={STYLE}
        leading={<span data-leading="true">kind</span>}
        actions={actions}
      />
    </BaseNodeActionScope>,
  );
}

describe("shared base graph node", () => {
  it.each(KINDS)("puts the %s disclosure once at the end of the title action rail", (kind) => {
    const markup = render(model(kind));

    expect(markup.match(/data-base-node-disclosure/g)).toHaveLength(1);
    expect(markup.indexOf('data-decoration="true"')).toBeLessThan(markup.indexOf("data-base-node-disclosure"));
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(`aria-label="Expand ${kind}"`);
  });

  it("uses the same tail control for the expanded frame state", () => {
    const markup = render(model("method", true));

    expect(markup.match(/data-base-node-disclosure/g)).toHaveLength(1);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="Collapse method"');
    expect(markup).toContain("▾");
  });

  it("does not render a dangling disclosure without children or a mounted expansion action", () => {
    const empty = { ...model("interface"), canExpand: false, childCount: 0 };
    const inconsistentEmpty = { ...model("object"), canExpand: true, childCount: 0 };
    const withoutChildren = renderToStaticMarkup(
      <BaseNode model={empty} style={STYLE} headerStyle={STYLE} labelStyle={STYLE} />,
    );
    const withoutActualChildren = renderToStaticMarkup(
      <BaseNodeActionScope toggleExpand={() => undefined}>
        <BaseNode model={inconsistentEmpty} style={STYLE} headerStyle={STYLE} labelStyle={STYLE} />
      </BaseNodeActionScope>,
    );
    const withoutController = renderToStaticMarkup(
      <BaseNode model={model("function")} style={STYLE} headerStyle={STYLE} labelStyle={STYLE} />,
    );

    expect(withoutChildren).not.toContain("data-base-node-disclosure");
    expect(withoutActualChildren).not.toContain("data-base-node-disclosure");
    expect(withoutController).not.toContain("data-base-node-disclosure");
  });

  it("routes expansion with the occurrence identity while preserving the artifact identity", () => {
    const toggle = vi.fn();
    const occurrence = { ...model("function"), instanceId: "root::call/2", targetId: "ts:work.ts#run" };
    const disclosure = NodeDisclosure({ model: occurrence, onToggle: toggle });
    const stopPropagation = vi.fn();

    disclosure.props.onClick({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: "root::call/2",
      targetId: "ts:work.ts#run",
    }));
    expect(occurrence.instanceId).not.toBe(occurrence.targetId);
  });
});
