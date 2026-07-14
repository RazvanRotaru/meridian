import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  selectedSyntheticFlowIndex,
  SyntheticFlowNavigator,
  syntheticFlowOptions,
  type SyntheticFlowStep,
} from "./SyntheticFlowNavigator";

const STEPS: SyntheticFlowStep[] = [{
  id: "span:place-order",
  nodeId: "ts:src/orderService.ts#placeOrder",
  label: "placeOrder",
  callerBreadcrumb: [],
}, {
  id: "span:validate",
  nodeId: "ts:src/orderValidator.ts#validateOrderRequest",
  label: "validateOrderRequest",
  callerBreadcrumb: ["placeOrder"],
}, {
  id: "span:line-1",
  nodeId: "ts:src/orderValidator.ts#assertLineIsSane",
  label: "assertLineIsSane",
  callerBreadcrumb: ["placeOrder", "validateOrderRequest"],
}, {
  id: "span:line-2",
  nodeId: "ts:src/orderValidator.ts#assertLineIsSane",
  label: "assertLineIsSane",
  callerBreadcrumb: ["placeOrder", "validateOrderRequest"],
}];

describe("SyntheticFlowNavigator", () => {
  it("shows one selected capture with scenario, root, position, caller path, and repeated occurrence labels", () => {
    const markup = renderNavigator(STEPS, "span:line-2");

    expect(markup).toContain('aria-label="Synthetic flow navigator"');
    expect(markup).toContain("Place order — priced and persisted");
    expect(markup).toContain("placeOrder");
    expect(markup).toContain('aria-label="Synthetic flow selection"');
    expect(markup).toContain('data-synthetic-step-id="span:line-1"');
    expect(markup).toContain("assertLineIsSane · occurrence 1 of 2");
    expect(markup).toContain("assertLineIsSane · occurrence 2 of 2");
    expect(markup).toContain('<option value="span:line-2" data-synthetic-step-id="span:line-2" selected="">');
    expect(markup).toContain('aria-label="Capture order 4 of 4"');
    expect(markup).toContain('data-synthetic-selected-step-id="span:line-2"');
    expect(markup).toContain('aria-label="Caller breadcrumb: placeOrder to validateOrderRequest to assertLineIsSane · occurrence 2 of 2"');
  });

  it("disables only the navigation boundary reached in capture order", () => {
    const first = renderNavigator(STEPS, STEPS[0]!.id);
    const middle = renderNavigator(STEPS, STEPS[1]!.id);
    const last = renderNavigator(STEPS, STEPS.at(-1)!.id);

    expect(buttonTag(first, "Previous synthetic flow")).toContain("disabled");
    expect(buttonTag(first, "Next synthetic flow")).not.toContain("disabled");
    expect(buttonTag(middle, "Previous synthetic flow")).not.toContain("disabled");
    expect(buttonTag(middle, "Next synthetic flow")).not.toContain("disabled");
    expect(buttonTag(last, "Previous synthetic flow")).not.toContain("disabled");
    expect(buttonTag(last, "Next synthetic flow")).toContain("disabled");
  });

  it("renders an honest empty state with both navigation actions disabled", () => {
    const markup = renderNavigator([], null);

    expect(markup).toContain("No captured flows");
    expect(markup).toContain("No runtime flows were captured for this synthetic run.");
    expect(markup).toContain('aria-label="Capture order 0 of 0"');
    expect(buttonTag(markup, "Previous synthetic flow")).toContain("disabled");
    expect(buttonTag(markup, "Next synthetic flow")).toContain("disabled");
  });
});

describe("synthetic flow option model", () => {
  it("preserves capture order, numbers only repeated artifact occurrences, and falls back to the first selection", () => {
    const options = syntheticFlowOptions([
      ...STEPS,
      {
        id: "span:unmapped-a",
        nodeId: null,
        label: "external",
        callerBreadcrumb: ["placeOrder"],
      },
      {
        id: "span:unmapped-b",
        nodeId: null,
        label: "external",
        callerBreadcrumb: ["placeOrder"],
      },
    ]);

    expect(options.map((option) => option.id)).toEqual([
      "span:place-order",
      "span:validate",
      "span:line-1",
      "span:line-2",
      "span:unmapped-a",
      "span:unmapped-b",
    ]);
    expect(options[2]).toMatchObject({ occurrenceIndex: 1, occurrenceCount: 2 });
    expect(options[3]).toMatchObject({ occurrenceIndex: 2, occurrenceCount: 2 });
    expect(options[4]?.displayLabel).toBe("external");
    expect(options[5]?.displayLabel).toBe("external");
    expect(selectedSyntheticFlowIndex(options, "missing")).toBe(0);
    expect(selectedSyntheticFlowIndex([], null)).toBe(-1);
  });
});

function renderNavigator(steps: readonly SyntheticFlowStep[], selectedId: string | null): string {
  return renderToStaticMarkup(
    <SyntheticFlowNavigator
      steps={steps}
      selectedId={selectedId}
      scenarioLabel="Place order — priced and persisted"
      rootLabel="placeOrder"
      onSelect={vi.fn()}
      onPrevious={vi.fn()}
      onNext={vi.fn()}
    />,
  );
}

function buttonTag(markup: string, ariaLabel: string): string {
  return markup.match(new RegExp(`<button[^>]*aria-label="${ariaLabel}"[^>]*>`))?.[0] ?? "";
}
