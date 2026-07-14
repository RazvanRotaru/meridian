import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JsonValue, SyntheticNodeSnapshot } from "@meridian/core";
import {
  diffSyntheticValues,
  SyntheticDataInspector,
  type SyntheticValueChange,
} from "./SyntheticDataInspector";

const SNAPSHOT: SyntheticNodeSnapshot = {
  spanId: "0000000000000005",
  nodeId: "ts:src/pricing/pricingService.ts#PricingService.price",
  occurrenceKey: "PricingService.price:1",
  input: {
    request: {
      customerId: "customer_with_a_deliberately_long_identifier_that_must_not_be_truncated_in_the_detail_inspector",
      lines: [{ sku: "tea", quantity: 2, unitPriceCents: 450 }],
    },
  },
  output: {
    subtotalCents: 900,
    discountCents: 90,
    taxCents: 162,
    totalCents: 972,
  },
};

describe("SyntheticDataInspector", () => {
  it("renders the complete input and output together in the default data pane", () => {
    const markup = renderToStaticMarkup(
      <SyntheticDataInspector
        occurrenceLabel="PricingService.price"
        snapshot={SNAPSHOT}
        position={{ current: 5, total: 16 }}
      />,
    );

    expect(markup).toContain('aria-label="Synthetic data inspector"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab" aria-selected="true"');
    expect(markup).toContain('data-synthetic-inspector-tab="data"');
    expect(markup).toContain('aria-label="Input and output data"');
    expect(markup).toContain("customer_with_a_deliberately_long_identifier_that_must_not_be_truncated_in_the_detail_inspector");
    expect(markup).toContain('aria-label="Output JSON"');
    expect(markup).toContain("totalCents");
    expect(markup).toContain('aria-label="Copy Input JSON"');
    expect(markup).toContain('aria-label="Copy Output JSON"');
    expect(markup).toContain('aria-label="Occurrence 5 of 16"');
    expect(markup.indexOf('aria-label="Input JSON"')).toBeLessThan(markup.indexOf('aria-label="Output JSON"'));
  });

  it("distinguishes an explicit null output from void or undefined", () => {
    const explicitNull = renderInspector({ ...SNAPSHOT, output: null }, "data");
    const noOutput = renderInspector(snapshotWithoutOutcome(), "data");

    expect(explicitNull).toContain('aria-label="Output JSON"');
    expect(explicitNull).toContain(">null</pre>");
    expect(explicitNull).not.toContain("No output value");
    expect(noOutput).toContain('data-synthetic-output-state="void"');
    expect(noOutput).toContain("returned void or undefined");
    expect(noOutput).not.toContain('aria-label="Copy Output JSON"');
  });

  it("shows an error instead of manufacturing output or changes", () => {
    const failed: SyntheticNodeSnapshot = {
      ...snapshotWithoutOutcome(),
      error: "ValidationError: order is missing a customer",
    };
    const output = renderInspector(failed, "data");
    const changes = renderInspector(failed, "changes");

    expect(output).toContain('data-synthetic-output-state="error"');
    expect(output).toContain("No successful output was produced");
    expect(output).toContain("ValidationError: order is missing a customer");
    expect(output).toContain('aria-label="Copy error"');
    expect(changes).toContain('data-synthetic-changes-state="error"');
    expect(changes).toContain("threw before it produced an output value");
  });

  it("renders deep structural changes with full before/after values and a lineage caveat", () => {
    const markup = renderInspector(SNAPSHOT, "changes");

    expect(markup).toContain('aria-label="Structural input and output changes"');
    expect(markup).toContain('aria-label="Changed JSON paths"');
    expect(markup).toContain('data-change-kind="removed"');
    expect(markup).toContain('data-change-kind="added"');
    expect(markup).toContain("$.request");
    expect(markup).toContain("$.totalCents");
    expect(markup).toContain("does not prove data lineage");
    expect(markup).toContain('aria-label="Copy structural changes"');
  });

  it("states when an observed occurrence has no captured snapshot", () => {
    const markup = renderToStaticMarkup(
      <SyntheticDataInspector occurrenceLabel="Unmapped client span" snapshot={null} />,
    );

    expect(markup).toContain("No boundary snapshot");
    expect(markup).toContain("were not captured");
    expect(markup).not.toContain('role="tablist"');
  });
});

describe("diffSyntheticValues", () => {
  const before: JsonValue = {
    customer: { id: "before", flags: ["known"] },
    removed: { reason: "old" },
    "non identifier": true,
  };
  const after: JsonValue = {
    added: 2,
    customer: { id: "after", flags: ["known", "new"] },
    "non identifier": false,
  };

  it("finds deterministic added, removed, and leaf-level changed paths deeply", () => {
    expect(diffSyntheticValues(before, after)).toEqual<SyntheticValueChange[]>([
      { kind: "added", path: "$.added", after: 2 },
      { kind: "added", path: "$.customer.flags[1]", after: "new" },
      { kind: "changed", path: "$.customer.id", before: "before", after: "after" },
      { kind: "changed", path: '$["non identifier"]', before: true, after: false },
      { kind: "removed", path: "$.removed", before: { reason: "old" } },
    ]);
  });

  it("can stop at top-level structural changes for a shallow summary", () => {
    expect(diffSyntheticValues(before, after, "shallow")).toEqual<SyntheticValueChange[]>([
      { kind: "added", path: "$.added", after: 2 },
      {
        kind: "changed",
        path: "$.customer",
        before: { id: "before", flags: ["known"] },
        after: { id: "after", flags: ["known", "new"] },
      },
      { kind: "changed", path: '$["non identifier"]', before: true, after: false },
      { kind: "removed", path: "$.removed", before: { reason: "old" } },
    ]);
  });

  it("returns no changes for equal objects regardless of property order", () => {
    expect(diffSyntheticValues({ first: 1, second: [true] }, { second: [true], first: 1 })).toEqual([]);
  });

  it("records a container type transition at its exact path", () => {
    expect(diffSyntheticValues({ value: [1, 2] }, { value: { 0: 1, 1: 2 } })).toEqual([
      { kind: "changed", path: "$.value", before: [1, 2], after: { 0: 1, 1: 2 } },
    ]);
  });
});

function renderInspector(snapshot: SyntheticNodeSnapshot, initialTab: "data" | "changes"): string {
  return renderToStaticMarkup(
    <SyntheticDataInspector
      occurrenceLabel="PricingService.price"
      snapshot={snapshot}
      initialTab={initialTab}
    />,
  );
}

function snapshotWithoutOutcome(): SyntheticNodeSnapshot {
  return {
    spanId: SNAPSHOT.spanId,
    nodeId: SNAPSHOT.nodeId,
    occurrenceKey: SNAPSHOT.occurrenceKey,
    input: SNAPSHOT.input,
  };
}
