import { describe, expect, it } from "vitest";
import type { LogicEdgeSpec } from "../derive/logicGraph";
import type { LogicRfEdge } from "../layout/logicElk";
import {
  decorateRequestFlowEdges,
  REQUEST_FLOW_EDGE_CONTEXT_CLASS,
  REQUEST_FLOW_EDGE_OBSERVED_CLASS,
} from "./deriveRequestFlowPaneLayout";

const TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("request flow edge evidence paint", () => {
  it("lights only positively observed telemetry edges and subdues static context", () => {
    const observed = edge("runtime", { className: "kept", animated: true, filter: "brightness(1.1)" });
    const context = edge("static", { animated: true, opacity: 0.8 });
    const specs: LogicEdgeSpec[] = [
      {
        id: observed.id,
        source: observed.source,
        target: observed.target,
        kind: "seq",
        requestTraversal: {
          traceId: TRACE_ID,
          basis: "runtime-causal",
          relation: "parent-child",
          sourceMomentId: observed.source,
          targetMomentId: observed.target,
        },
      },
      { id: context.id, source: context.source, target: context.target, kind: "seq" },
    ];

    const painted = decorateRequestFlowEdges([observed, context], specs, TRACE_ID);

    expect(painted[0]).toMatchObject({
      className: expect.stringContaining(REQUEST_FLOW_EDGE_OBSERVED_CLASS),
      animated: true,
      zIndex: 3,
      style: { opacity: 1, strokeWidth: 3.4 },
      data: {
        kind: "seq",
        requestFlowDisposition: "observed",
        requestTraceId: TRACE_ID,
        requestFlowEvidence: { basis: "runtime-causal", relation: "parent-child" },
      },
    });
    expect(painted[0]?.className).toContain("kept");
    expect(painted[0]?.style?.filter).toContain("brightness(1.1)");
    expect(painted[0]?.style?.filter).toContain("drop-shadow");
    expect(painted[0]?.domAttributes).toMatchObject({
      "data-request-flow-evidence": "observed",
      "data-request-flow-basis": "runtime-causal",
      "data-request-flow-relation": "parent-child",
      "data-request-trace-id": TRACE_ID,
    });

    expect(painted[1]).toMatchObject({
      className: expect.stringContaining(REQUEST_FLOW_EDGE_CONTEXT_CLASS),
      animated: false,
      zIndex: 0,
      style: { opacity: 0.22, strokeWidth: 1.35 },
      data: {
        kind: "seq",
        requestFlowDisposition: "context",
        requestFlowEvidence: null,
        requestTraceId: TRACE_ID,
      },
    });
    expect(painted[1]?.domAttributes).toMatchObject({
      "data-request-flow-evidence": "context",
      "data-request-flow-basis": "static-context",
      "data-request-trace-id": TRACE_ID,
    });

    // Presentation decoration is immutable: shared Logic/PR edge objects are not rewritten.
    expect(observed.className).toBe("kept");
    expect(observed.style).toEqual({ stroke: "#C8D3E0", strokeWidth: 2, filter: "brightness(1.1)" });
    expect(context.animated).toBe(true);
    expect(context.style?.opacity).toBe(0.8);
  });

  it("surfaces exact static branch evidence as stable DOM metadata", () => {
    const branchEdge = edge("branch", { animated: false });
    const [painted] = decorateRequestFlowEdges([branchEdge], [{
      id: branchEdge.id,
      source: branchEdge.source,
      target: branchEdge.target,
      kind: "branch",
      label: "else",
      requestTraversal: {
        traceId: TRACE_ID,
        basis: "branch-path",
        spanId: "1000000000000003",
        eventIds: ["s-customer"],
        siteId: "validate:customer",
        pathIds: ["else"],
      },
    }], TRACE_ID);

    expect(painted?.className).toContain(REQUEST_FLOW_EDGE_OBSERVED_CLASS);
    expect(painted?.domAttributes).toMatchObject({
      "data-request-flow-evidence": "observed",
      "data-request-flow-basis": "branch-path",
      "data-request-flow-span-id": "1000000000000003",
      "data-request-flow-site-id": "validate:customer",
      "data-request-flow-path-ids": "else",
      "data-request-flow-event-ids": "s-customer",
    });
  });

  it("keeps a request-only caught-exception bridge visibly exceptional and observed", () => {
    const bridge = edge("request-exception", { animated: false });
    bridge.style = { stroke: "#D98A5B", strokeWidth: 2, strokeDasharray: "7 5" };
    bridge.data = { kind: "branch", branchRole: "catch" };
    const [painted] = decorateRequestFlowEdges([bridge], [{
      id: bridge.id,
      source: bridge.source,
      target: bridge.target,
      kind: "branch",
      label: "throws → catch",
      branchRole: "catch",
      requestTraversal: {
        traceId: TRACE_ID,
        basis: "branch-path",
        spanId: "1000000000000001",
        eventIds: ["caught"],
        siteId: "route:create:try",
        pathIds: ["catch"],
      },
    }], TRACE_ID);

    expect(painted).toMatchObject({
      className: expect.stringContaining(REQUEST_FLOW_EDGE_OBSERVED_CLASS),
      zIndex: 3,
      style: {
        opacity: 1,
        stroke: "#D98A5B",
        strokeWidth: 3.4,
        strokeDasharray: "7 5",
      },
      data: {
        kind: "branch",
        branchRole: "catch",
        requestFlowDisposition: "observed",
        requestFlowEvidence: { basis: "branch-path", pathIds: ["catch"] },
      },
    });
  });
});

function edge(
  id: string,
  options: { className?: string; animated?: boolean; opacity?: number; filter?: string },
): LogicRfEdge {
  return {
    id,
    source: `${id}:source`,
    target: `${id}:target`,
    className: options.className,
    animated: options.animated,
    style: {
      stroke: "#C8D3E0",
      strokeWidth: 2,
      ...(options.opacity === undefined ? {} : { opacity: options.opacity }),
      ...(options.filter === undefined ? {} : { filter: options.filter }),
    },
    data: { kind: "seq" },
  };
}
