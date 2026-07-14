import { createElement, type ComponentProps, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { LogicActionBar } from "./LogicActionBar";

describe("LogicActionBar", () => {
  it("enables whole-flow actions before a target is selected", () => {
    const markup = renderActionBar({ selectedCount: 0, canFocus: true, canExpand: true, canCollapse: true });

    expect(actionButton(markup, "Focus selection")).not.toContain("aria-disabled");
    expect(actionButton(markup, "Expand selection")).not.toContain("aria-disabled");
    expect(actionButton(markup, "Collapse selection")).not.toContain("aria-disabled");
    expect(markup).toContain("Focus the whole visible flow in the viewport");
    expect(markup).toContain("Expand every collapsed occurrence in the whole visible flow");
    expect(markup).toContain("Collapse every open occurrence in the whole visible flow");
    expect(markup).toContain('aria-label="Logic flow selection actions"');
  });

  it("still disables whole-flow actions that have nothing to change", () => {
    const markup = renderActionBar({ selectedCount: 0, canFocus: true, canExpand: false, canCollapse: false });

    expect(actionButton(markup, "Focus selection")).not.toContain("aria-disabled");
    expect(actionButton(markup, "Expand selection")).toContain('aria-disabled="true"');
    expect(actionButton(markup, "Collapse selection")).toContain('aria-disabled="true"');
  });

  it("enables only the actions supported by the selected occurrences", () => {
    const markup = renderActionBar({ selectedCount: 2, canFocus: true, canExpand: true, canCollapse: false });

    expect(actionButton(markup, "Focus selection")).not.toContain("aria-disabled");
    expect(actionButton(markup, "Expand selection")).not.toContain("aria-disabled");
    expect(actionButton(markup, "Collapse selection")).toContain('aria-disabled="true"');
    expect(markup).toContain("Focus the 2 selected occurrences in the viewport");
  });
});

function renderActionBar(
  props: Pick<ComponentProps<typeof LogicActionBar>, "selectedCount" | "canFocus" | "canExpand" | "canCollapse">,
): string {
  return renderToStaticMarkup(
    createElement(
      ReactFlowProvider,
      null,
      createElement(LogicActionBar as FunctionComponent<ComponentProps<typeof LogicActionBar>>, {
        ...props,
        onFocusSelection: () => undefined,
        onExpandSelection: () => undefined,
        onCollapseSelection: () => undefined,
      }),
    ),
  );
}

function actionButton(markup: string, ariaLabel: string): string {
  const match = markup.match(new RegExp(`<button[^>]*aria-label="${ariaLabel}"[^>]*>`));
  if (!match) {
    throw new Error(`Missing ${ariaLabel} button`);
  }
  return match[0];
}
