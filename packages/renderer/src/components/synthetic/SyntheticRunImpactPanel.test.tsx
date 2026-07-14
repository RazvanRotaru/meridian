import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  SyntheticExecutionComparison,
  SyntheticOccurrenceComparison,
} from "../../synthetic/syntheticExecutionComparison";
import { SyntheticRunImpactPanel } from "./SyntheticRunImpactPanel";

const PRICE = "ts:src/pricing/pricingService.ts#PricingService.price";

describe("SyntheticRunImpactPanel", () => {
  it("summarizes the run and renders only changed observed occurrences with honest evidence", () => {
    const markup = renderImpact(changedComparison(), "after-price");

    expect(markup).toContain('aria-label="Synthetic run impact: 1 whole-flow input changes, 2 observed path changes, 1 output changes, 1 status changes, 3 changed callable occurrences"');
    expect(markup).toContain('data-synthetic-run-impact="changed"');
    expect(markup).toContain('data-impact-summary="input"');
    expect(markup).toContain('data-impact-summary="path"');
    expect(markup).toContain('aria-label="Changed whole-flow input fields"');
    expect(markup).toContain("$.request.discountCode");
    expect(markup).toContain("WELCOME10");
    expect(markup).toContain('aria-label="Changed observed callable occurrences"');
    expect(markup).toContain("price");
    expect(markup).toContain("1 path event change");
    expect(markup).toContain("output value changed");
    expect(markup).toContain("sendOrderConfirmation");
    expect(markup).toContain("AFTER ONLY");
    expect(markup).toContain("observed only in changed run");
    expect(markup).toContain("validateOrderRequest");
    expect(markup).toContain("BEFORE ONLY");
    expect(markup).toContain("not observed in changed run");
    expect(markup).not.toContain("unchangedHelper");
    expect(markup).toContain("does not prove field-level data lineage");
    expect(markup).toContain("aligned by capture order");
  });

  it("makes current occurrences keyboard-reachable while leaving previous-only rows non-interactive", () => {
    const markup = renderImpact(changedComparison(), "after-price");

    expect(markup).toContain('aria-label="Show current occurrence price in the execution graph" aria-pressed="true"');
    expect(markup).toContain('aria-label="Show current occurrence sendOrderConfirmation in the execution graph" aria-pressed="false"');
    expect(markup).not.toContain('aria-label="Show current occurrence validateOrderRequest in the execution graph"');
  });

  it("states when a compatible rerun has no captured differences", () => {
    const comparison = changedComparison();
    comparison.occurrences = comparison.occurrences.map((row) => ({ ...row, changed: false }));
    comparison.summary = {
      inputChangeCount: 0,
      pathChangeCount: 0,
      outputChangeCount: 0,
      statusChangeCount: 0,
      changedOccurrenceCount: 0,
      hasChanges: false,
    };
    const markup = renderImpact(comparison);

    expect(markup).toContain('data-synthetic-run-impact="unchanged"');
    expect(markup).toContain("NO OBSERVED CHANGE");
    expect(markup).toContain("No captured execution differences");
    expect(markup).not.toContain('aria-label="Changed observed callable occurrences"');
  });

  it("bounds a broad input diff and discloses how many changed fields remain", () => {
    const comparison = changedComparison();
    comparison.inputChanges = Array.from({ length: 8 }, (_, index) => ({
      kind: "added" as const,
      path: `$.field${index}`,
      after: `value-${index}-${"x".repeat(100)}`,
    }));
    comparison.summary.inputChangeCount = 8;
    const markup = renderImpact(comparison);

    expect(markup).toContain("$.field0");
    expect(markup).toContain("$.field5");
    expect(markup).not.toContain("$.field6");
    expect(markup).toContain("+2 more changed fields");
    expect(markup).toContain("…");
  });

  it("discloses partial captures and explains incompatible comparisons", () => {
    const partial = changedComparison();
    partial.confidence = "partial";
    partial.partialReasons = ["Previous capture dropped 1 span."];
    const partialMarkup = renderImpact(partial);
    const incompatibleMarkup = renderImpact({
      ...partial,
      compatible: false,
      incompatibilityReason: "The runs use different scenarios.",
    });

    expect(partialMarkup).toContain('data-comparison-confidence="partial"');
    expect(partialMarkup).toContain("uncaptured differences may be missing");
    expect(incompatibleMarkup).toContain('data-synthetic-run-impact="incompatible"');
    expect(incompatibleMarkup).toContain("UNAVAILABLE");
    expect(incompatibleMarkup).toContain("The runs use different scenarios.");
  });
});

function changedComparison(): SyntheticExecutionComparison {
  return {
    compatible: true,
    incompatibilityReason: null,
    confidence: "complete",
    partialReasons: [],
    inputChanges: [{ kind: "changed", path: "$.request.discountCode", before: null, after: "WELCOME10" }],
    occurrences: [
      occurrence({
        key: "price#1",
        nodeId: PRICE,
        name: "PricingService.price",
        before: capture("before-price"),
        after: capture("after-price"),
        decisionChanges: [{ key: "price:discount", kind: "changed", type: "branch", before: null, after: null }],
        outcomeChange: { before: { kind: "value", value: { total: 100 } }, after: { kind: "value", value: { total: 90 } }, valueChanges: [] },
        changed: true,
      }),
      occurrence({
        key: "send#1",
        nodeId: "ts:src/email.ts#sendOrderConfirmation",
        name: "EmailService.sendOrderConfirmation",
        presence: "after-only",
        before: null,
        after: capture("after-send"),
        statusChanged: true,
        changed: true,
      }),
      occurrence({
        key: "validate#1",
        nodeId: "ts:src/validation.ts#validateOrderRequest",
        name: "validateOrderRequest",
        presence: "before-only",
        before: capture("before-validate"),
        after: null,
        changed: true,
      }),
      occurrence({
        key: "helper#1",
        nodeId: null,
        name: "unchangedHelper",
        before: capture("before-helper"),
        after: capture("after-helper"),
        changed: false,
      }),
    ],
    summary: {
      inputChangeCount: 1,
      pathChangeCount: 2,
      outputChangeCount: 1,
      statusChangeCount: 1,
      changedOccurrenceCount: 3,
      hasChanges: true,
    },
  };
}

function occurrence(overrides: Partial<SyntheticOccurrenceComparison>): SyntheticOccurrenceComparison {
  return {
    key: "node#1",
    nodeId: null,
    name: "node",
    parentKey: null,
    ordinal: 1,
    presence: "matched",
    before: capture("before"),
    after: capture("after"),
    statusChanged: false,
    snapshotInputChanges: null,
    snapshotAvailabilityChanged: false,
    outcomeChange: null,
    decisionChanges: [],
    changed: true,
    ...overrides,
  };
}

function capture(spanId: string) {
  return { spanId, status: "ok" as const, snapshot: null };
}

function renderImpact(comparison: SyntheticExecutionComparison, selectedCurrentSpanId: string | null = null): string {
  return renderToStaticMarkup(
    <SyntheticRunImpactPanel
      comparison={comparison}
      selectedCurrentSpanId={selectedCurrentSpanId}
      labelForNode={(nodeId) => nodeId === PRICE ? "price" : undefined}
      onSelectCurrentOccurrence={vi.fn()}
    />,
  );
}
