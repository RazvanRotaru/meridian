import { describe, expect, it } from "vitest";
import type { FlowStep, LogicFlows, RequestTrace, TimelineEvent, TimelineSpan } from "@meridian/core";
import { ALPHA_RUN, BETA_RUN, freshStore } from "../parity/surfaceFixture";
import { deriveRequestExecutionFlow } from "./requestExecutionFlow";
import {
  logicBranchBodyPrefix,
  logicCallBodyPrefix,
  logicControlBodyPrefix,
  logicFinallyBodyPrefix,
  logicNodeId,
  logicStepPath,
  logicTopLevelBodyPrefix,
} from "./logicFlowAddress";

const TRACE_ID = "cccccccccccccccccccccccccccccccc";
const SPAN_ID = "3000000000000001";
const OCCURRENCE = `request:${TRACE_ID}:span:${SPAN_ID}`;

describe("static request traversal correlation", () => {
  it("leaves straight-line edges as context for error, unset, and incomplete spans", () => {
    const straightLine: LogicFlows = {
      [ALPHA_RUN]: [
        { kind: "call", label: "first", target: null, resolution: "unresolved" },
        { kind: "call", label: "second", target: null, resolution: "unresolved" },
      ],
    };
    const errorGraph = deriveRequestExecutionFlow(
      trace([], "error"),
      freshStore().getState().index,
      straightLine,
      new Set([OCCURRENCE]),
    );
    const unsetGraph = deriveRequestExecutionFlow(
      trace([], "unset"),
      freshStore().getState().index,
      straightLine,
      new Set([OCCURRENCE]),
    );
    const partial = trace([]);
    partial.completeness.complete = false;
    partial.completeness.droppedEvents = 1;
    const partialGraph = deriveRequestExecutionFlow(
      partial,
      freshStore().getState().index,
      straightLine,
      new Set([OCCURRENCE]),
    );

    [errorGraph, unsetGraph, partialGraph].forEach((graph) => {
      expect(edge(graph, `${OCCURRENCE}:exec::p0/0`, `${OCCURRENCE}:exec::p0/1`)?.requestTraversal)
        .toBeUndefined();
    });
  });

  it("lights exact implicit fallthroughs and leaves untaken throw arms as context", () => {
    const graph = deriveRequestExecutionFlow(
      trace([
        branch("customer", 8, "validate:customer", "else"),
        branch("lines", 11, "validate:lines", "else"),
        loop(14, 2),
      ]),
      freshStore().getState().index,
      FLOWS,
      new Set([OCCURRENCE]),
    );

    expect(edge(graph, `${OCCURRENCE}:exec::p0/0`, `${OCCURRENCE}:exec::p0/1`, "else")?.requestTraversal)
      .toMatchObject({ basis: "branch-path", spanId: SPAN_ID, siteId: "validate:customer", pathIds: ["else"] });
    expect(edge(graph, `${OCCURRENCE}:exec::p0/1`, `${OCCURRENCE}:exec::p0/2`, "else")?.requestTraversal)
      .toMatchObject({ basis: "branch-path", spanId: SPAN_ID, siteId: "validate:lines", pathIds: ["else"] });

    expect(edge(graph, `${OCCURRENCE}:exec::p0/0`, `${OCCURRENCE}:exec::p0/0/b0/0`, "then")?.requestTraversal)
      .toBeUndefined();
    expect(edge(graph, `${OCCURRENCE}:exec::p0/0/b0/0`, `${OCCURRENCE}:exec::p0/0/b0/1`)?.requestTraversal)
      .toBeUndefined();
  });

  it("keeps a precise constructor range inside the throwing arm and stops before downstream validation", () => {
    const graph = deriveRequestExecutionFlow(
      trace([
        branch("customer", 8, "validate:customer", "then"),
        {
          type: "exception",
          eventId: "thrown",
          timeUnixNano: at(3),
          attributes: {},
          exceptionType: "ValidationError",
          handled: false,
          source: { file: "src/order.ts", line: 9 },
        },
      ], "error"),
      freshStore().getState().index,
      FLOWS,
      new Set([OCCURRENCE]),
    );

    expect(edge(graph, `${OCCURRENCE}:exec::p0/0`, `${OCCURRENCE}:exec::p0/0/b0/0`, "then")?.requestTraversal)
      .toMatchObject({ basis: "branch-path", siteId: "validate:customer", pathIds: ["then"] });
    expect(edge(graph, `${OCCURRENCE}:exec::p0/0/b0/0`, `${OCCURRENCE}:exec::p0/0/b0/1`)?.requestTraversal)
      .toMatchObject({ basis: "branch-path", siteId: "validate:customer" });
    expect(edge(graph, `${OCCURRENCE}:exec::p0/0`, `${OCCURRENCE}:exec::p0/1`, "else")?.requestTraversal)
      .toBeUndefined();
    expect(edge(graph, `${OCCURRENCE}:exec::p0/1`, `${OCCURRENCE}:exec::p0/2`, "else")?.requestTraversal)
      .toBeUndefined();
  });

  it("lights every observed arm when one static branch is evaluated repeatedly", () => {
    const repeatedFlows: LogicFlows = {
      [ALPHA_RUN]: [
        {
          kind: "branch",
          branchKind: "if",
          label: "if line.isGift",
          source: { file: "order.ts", line: 8 },
          paths: [{
            label: "then",
            role: "then",
            pathId: "then",
            body: [{ kind: "call", label: "markGift", target: BETA_RUN, resolution: "resolved" }],
          }],
        },
        { kind: "call", label: "continueLine", target: BETA_RUN, resolution: "resolved" },
      ],
    };
    const graph = deriveRequestExecutionFlow(
      trace([
        branch("gift", 8, "line:gift", "then"),
        branch("ordinary", 8, "line:gift", "else"),
      ]),
      freshStore().getState().index,
      repeatedFlows,
      new Set([OCCURRENCE]),
    );
    const branchId = `${OCCURRENCE}:exec::p0/0`;
    const giftId = `${OCCURRENCE}:exec::p0/0/b0/0`;
    const joinId = `${branchId}::join`;
    const afterId = `${OCCURRENCE}:exec::p0/1`;

    expect(edge(graph, branchId, giftId, "then")?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["gift"], pathIds: ["then"] });
    expect(edge(graph, giftId, joinId)?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["gift"], pathIds: ["then"] });
    expect(edge(graph, branchId, joinId, "else")?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["ordinary"], pathIds: ["else"] });
    expect(edge(graph, joinId, afterId)?.requestTraversal)
      .toMatchObject({
        basis: "branch-path",
        eventIds: ["gift", "ordinary"],
        pathIds: ["then", "else"],
      });
  });

  it("keeps observed branch evidence on the visible summary when the branch is collapsed", () => {
    const branchId = `${OCCURRENCE}:exec::p0/0`;
    const afterId = `${OCCURRENCE}:exec::p0/1`;
    const collapsedFlows: LogicFlows = {
      [ALPHA_RUN]: [
        {
          kind: "branch",
          branchKind: "if",
          label: "if ready",
          source: { file: "order.ts", line: 8 },
          paths: [{
            label: "then",
            role: "then",
            pathId: "then",
            body: [{ kind: "call", label: "inside", target: null, resolution: "unresolved" }],
          }],
        },
        { kind: "call", label: "after", target: null, resolution: "unresolved" },
      ],
    };
    const graph = deriveRequestExecutionFlow(
      trace([branch("taken", 8, "branch:ready", "then")]),
      freshStore().getState().index,
      collapsedFlows,
      // The span occurrence is default-collapsed, while structural branches are default-open.
      // Toggle both ids: reveal the static body, then fold only this branch summary.
      new Set([OCCURRENCE, branchId]),
    );

    expect(graph.nodes.some((node) => node.id === `${branchId}/b0/0`)).toBe(false);
    expect(edge(graph, branchId, afterId)?.requestTraversal).toMatchObject({
      basis: "branch-path",
      eventIds: ["taken"],
      pathIds: ["then"],
    });
  });

  it("shares nested call, branch, and control addresses with the Logic graph builder", () => {
    const nestedFlows: LogicFlows = {
      [ALPHA_RUN]: [
        { kind: "call", label: "nested", target: BETA_RUN, resolution: "resolved" },
      ],
      [BETA_RUN]: [{
        kind: "branch",
        branchKind: "if",
        label: "if ready",
        source: { file: "order.ts", line: 20 },
        paths: [{
          label: "then",
          role: "then",
          pathId: "then",
          body: [{
            kind: "loop",
            label: "for each item",
            source: { file: "order.ts", line: 21 },
            body: [
              { kind: "call", label: "first", target: null, resolution: "unresolved" },
              { kind: "call", label: "second", target: null, resolution: "unresolved" },
            ],
          }],
        }],
      }],
    };
    const execPrefix = `${OCCURRENCE}:exec`;
    const callPath = logicStepPath(logicTopLevelBodyPrefix(0), 0);
    const callId = logicNodeId(execPrefix, callPath);
    const branchPath = logicStepPath(logicCallBodyPrefix(callPath), 0);
    const branchId = logicNodeId(execPrefix, branchPath);
    const loopPath = logicStepPath(logicBranchBodyPrefix(branchPath, 0), 0);
    const loopId = logicNodeId(execPrefix, loopPath);
    const loopBodyPrefix = logicControlBodyPrefix(loopPath, 0);
    const firstId = logicNodeId(execPrefix, logicStepPath(loopBodyPrefix, 0));
    const secondId = logicNodeId(execPrefix, logicStepPath(loopBodyPrefix, 1));

    const graph = deriveRequestExecutionFlow(
      trace([
        branch("nested-branch", 20, "nested:branch", "then"),
        loop(21, 2),
      ]),
      freshStore().getState().index,
      nestedFlows,
      new Set([OCCURRENCE, callId]),
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      callId,
      branchId,
      loopId,
      firstId,
      secondId,
    ]));
    expect(edge(graph, branchId, loopId, "then")?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["nested-branch"] });
    expect(edge(graph, firstId, secondId)?.requestTraversal)
      .toMatchObject({ basis: "loop-body", eventIds: ["loop"], iterations: 2 });
  });

  it("propagates a nested throw while converting a nested return into call continuation", () => {
    const execPrefix = `${OCCURRENCE}:exec`;
    const callPath = logicStepPath(logicTopLevelBodyPrefix(0), 0);
    const callId = logicNodeId(execPrefix, callPath);
    const afterId = logicNodeId(execPrefix, logicStepPath(logicTopLevelBodyPrefix(0), 1));
    const outer: FlowStep[] = [
      { kind: "call", label: "nested", target: BETA_RUN, resolution: "resolved" },
      { kind: "call", label: "after", target: null, resolution: "unresolved" },
    ];
    const throwing = deriveRequestExecutionFlow(
      trace([]),
      freshStore().getState().index,
      {
        [ALPHA_RUN]: outer,
        [BETA_RUN]: [
          { kind: "call", label: "makeError", target: null, resolution: "unresolved" },
          { kind: "exit", variant: "throw", label: "error" },
        ],
      },
      new Set([OCCURRENCE, callId]),
    );
    const returning = deriveRequestExecutionFlow(
      trace([]),
      freshStore().getState().index,
      {
        [ALPHA_RUN]: outer,
        [BETA_RUN]: [{ kind: "exit", variant: "return", label: "value" }],
      },
      new Set([OCCURRENCE, callId]),
    );

    expect(edge(throwing, callId, afterId)?.requestTraversal).toBeUndefined();
    expect(edge(returning, callId, afterId)?.requestTraversal)
      .toMatchObject({ basis: "span-body", spanId: SPAN_ID });
  });

  it("stops a loop occurrence when its observed body throws", () => {
    const loopFlows: LogicFlows = {
      [ALPHA_RUN]: [
        {
          kind: "loop",
          label: "for each item",
          source: { file: "order.ts", line: 20 },
          body: [
            { kind: "call", label: "risky", target: null, resolution: "unresolved", source: { file: "order.ts", line: 21 } },
            { kind: "call", label: "skipped", target: null, resolution: "unresolved", source: { file: "order.ts", line: 22 } },
          ],
        },
        { kind: "call", label: "afterLoop", target: null, resolution: "unresolved" },
      ],
    };
    const graph = deriveRequestExecutionFlow(
      trace([
        loopAt("loop-failure", 20, 1),
        exception("loop-throw", 21),
      ], "error"),
      freshStore().getState().index,
      loopFlows,
      new Set([OCCURRENCE]),
    );
    const loopPath = logicStepPath(logicTopLevelBodyPrefix(0), 0);
    const bodyPrefix = logicControlBodyPrefix(loopPath, 0);
    const riskyId = logicNodeId(`${OCCURRENCE}:exec`, logicStepPath(bodyPrefix, 0));
    const skippedId = logicNodeId(`${OCCURRENCE}:exec`, logicStepPath(bodyPrefix, 1));
    const loopId = logicNodeId(`${OCCURRENCE}:exec`, loopPath);
    const afterId = logicNodeId(`${OCCURRENCE}:exec`, logicStepPath(logicTopLevelBodyPrefix(0), 1));

    expect(edge(graph, riskyId, skippedId)?.requestTraversal).toBeUndefined();
    expect(edge(graph, loopId, afterId)?.requestTraversal).toBeUndefined();
  });

  it("traverses the executed try prefix before catch, then runs catch and finally", () => {
    const tryFlows = caughtTryFlows();
    const graph = deriveRequestExecutionFlow(
      trace([
        branchAt("caught", 29, "try:order", "catch"),
        exception("try-throw", 31),
      ]),
      freshStore().getState().index,
      tryFlows,
      new Set([OCCURRENCE]),
    );
    const execPrefix = `${OCCURRENCE}:exec`;
    const tryPath = logicStepPath(logicTopLevelBodyPrefix(0), 0);
    const tryId = logicNodeId(execPrefix, tryPath);
    const prepareId = logicNodeId(execPrefix, logicStepPath(logicBranchBodyPrefix(tryPath, 0), 0));
    const riskyId = logicNodeId(execPrefix, logicStepPath(logicBranchBodyPrefix(tryPath, 0), 1));
    const skippedId = logicNodeId(execPrefix, logicStepPath(logicBranchBodyPrefix(tryPath, 0), 2));
    const recoverId = logicNodeId(execPrefix, logicStepPath(logicBranchBodyPrefix(tryPath, 1), 0));
    const recoveredId = logicNodeId(execPrefix, logicStepPath(logicBranchBodyPrefix(tryPath, 1), 1));
    const joinId = `${tryId}::join`;
    const finallyId = `${tryId}::finally`;
    const cleanupId = logicNodeId(execPrefix, logicStepPath(logicFinallyBodyPrefix(tryPath), 0));
    const cleanedId = logicNodeId(execPrefix, logicStepPath(logicFinallyBodyPrefix(tryPath), 1));
    const afterId = logicNodeId(execPrefix, logicStepPath(logicTopLevelBodyPrefix(0), 1));

    expect(edge(graph, tryId, prepareId, "try")?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["caught"], pathIds: ["catch"] });
    expect(edge(graph, prepareId, riskyId)?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["caught"], pathIds: ["catch"] });
    expect(edge(graph, riskyId, skippedId)?.requestTraversal).toBeUndefined();
    expect(edge(graph, riskyId, recoverId, "throws → catch"))
      .toMatchObject({
        id: expect.stringContaining("request-exception:0"),
        kind: "branch",
        branchRole: "catch",
        requestTraversal: { basis: "branch-path", eventIds: ["caught"], pathIds: ["catch"] },
      });
    expect(edge(graph, tryId, recoverId, "catch error")?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["caught"] });
    expect(edge(graph, recoverId, recoveredId)?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["caught"] });
    expect(edge(graph, skippedId, joinId)?.requestTraversal).toBeUndefined();
    expect(edge(graph, recoveredId, joinId)?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["caught"] });
    expect(edge(graph, joinId, finallyId)?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["caught"] });
    expect(edge(graph, finallyId, cleanupId)?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["caught"] });
    expect(edge(graph, cleanupId, cleanedId)?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["caught"] });
    expect(edge(graph, cleanedId, afterId)?.requestTraversal)
      .toMatchObject({ basis: "branch-path", eventIds: ["caught"] });
  });

  it("bridges a failing child call to the caught arm without lighting its normal continuation", () => {
    const request = trace([branchAt("repository-timeout", 29, "route:create:try", "catch")], "error");
    request.spans.push(
      childSpan("4000000000000001", 1, "error"),
      childSpan("4000000000000002", 3, "ok"),
    );
    const flows: LogicFlows = {
      [ALPHA_RUN]: [{
        kind: "branch",
        branchKind: "try",
        label: "try/catch",
        source: { file: "order.ts", line: 29 },
        paths: [
          {
            label: "try",
            role: "try",
            pathId: "try",
            body: [
              { kind: "call", label: "placeOrder", target: BETA_RUN, resolution: "resolved" },
              { kind: "call", label: "created", target: null, resolution: "unresolved" },
            ],
          },
          {
            label: "catch error",
            role: "catch",
            pathId: "catch",
            body: [
              { kind: "call", label: "toErrorResponse", target: BETA_RUN, resolution: "resolved" },
              { kind: "exit", variant: "return", label: "error response" },
            ],
          },
        ],
      }],
    };
    const graph = deriveRequestExecutionFlow(
      request,
      freshStore().getState().index,
      flows,
      new Set([OCCURRENCE]),
    );
    const tryPath = logicStepPath(logicTopLevelBodyPrefix(0), 0);
    const execPrefix = `${OCCURRENCE}:exec`;
    const placeId = logicNodeId(execPrefix, logicStepPath(logicBranchBodyPrefix(tryPath, 0), 0));
    const createdId = logicNodeId(execPrefix, logicStepPath(logicBranchBodyPrefix(tryPath, 0), 1));
    const recoveryId = logicNodeId(execPrefix, logicStepPath(logicBranchBodyPrefix(tryPath, 1), 0));

    expect(edge(graph, placeId, createdId)?.kind).toBe("seq");
    expect(edge(graph, placeId, createdId)?.requestTraversal).toBeUndefined();
    expect(edge(graph, placeId, recoveryId, "throws → catch")).toMatchObject({
      kind: "branch",
      branchRole: "catch",
      requestTraversal: {
        basis: "branch-path",
        eventIds: ["repository-timeout"],
        pathIds: ["catch"],
      },
    });
  });

  it("keeps mandatory-finally evidence on the visible summary when cleanup is collapsed", () => {
    const execPrefix = `${OCCURRENCE}:exec`;
    const tryPath = logicStepPath(logicTopLevelBodyPrefix(0), 0);
    const tryId = logicNodeId(execPrefix, tryPath);
    const finallyId = `${tryId}::finally`;
    const cleanupId = logicNodeId(execPrefix, logicStepPath(logicFinallyBodyPrefix(tryPath), 0));
    const afterId = logicNodeId(execPrefix, logicStepPath(logicTopLevelBodyPrefix(0), 1));
    const graph = deriveRequestExecutionFlow(
      trace([
        branchAt("caught", 29, "try:order", "catch"),
        exception("try-throw", 31),
      ]),
      freshStore().getState().index,
      caughtTryFlows(),
      new Set([OCCURRENCE, finallyId]),
    );

    expect(graph.nodes.some((node) => node.id === cleanupId)).toBe(false);
    expect(edge(graph, finallyId, afterId)?.requestTraversal).toMatchObject({
      basis: "branch-path",
      eventIds: ["caught"],
      pathIds: ["catch"],
    });
  });

  it("does not guess a try arm from span status without branch evidence", () => {
    const execPrefix = `${OCCURRENCE}:exec`;
    const tryPath = logicStepPath(logicTopLevelBodyPrefix(0), 0);
    const prepareId = logicNodeId(execPrefix, logicStepPath(logicBranchBodyPrefix(tryPath, 0), 0));
    const riskyId = logicNodeId(execPrefix, logicStepPath(logicBranchBodyPrefix(tryPath, 0), 1));
    const tryId = logicNodeId(execPrefix, tryPath);
    const finallyId = `${tryId}::finally`;

    (["unset", "ok"] as const).forEach((status) => {
      const graph = deriveRequestExecutionFlow(
        trace([], status),
        freshStore().getState().index,
        caughtTryFlows(),
        new Set([OCCURRENCE]),
      );
      expect(edge(graph, tryId, prepareId, "try")?.requestTraversal).toBeUndefined();
      expect(edge(graph, prepareId, riskyId)?.requestTraversal).toBeUndefined();
      expect(edge(graph, `${tryId}::join`, finallyId)?.requestTraversal).toBeUndefined();
    });
  });

  it("keeps detached child failures on the parent flow without child-order evidence", () => {
    const detachedFlows: LogicFlows = {
      [ALPHA_RUN]: [
        { kind: "call", label: "before", target: BETA_RUN, resolution: "resolved" },
        { kind: "call", label: "background", target: BETA_RUN, resolution: "resolved", detached: true },
        { kind: "call", label: "after", target: BETA_RUN, resolution: "resolved" },
      ],
    };
    const request = trace([]);
    request.spans.push(
      childSpan("4000000000000001", 1, "ok"),
      childSpan("4000000000000002", 2, "error"),
      childSpan("4000000000000003", 3, "ok"),
    );
    const graph = deriveRequestExecutionFlow(
      request,
      freshStore().getState().index,
      detachedFlows,
      new Set([OCCURRENCE]),
    );
    const beforeId = `${OCCURRENCE}:exec::p0/0`;
    const detachedId = `${OCCURRENCE}:exec::p0/1`;
    const afterId = `${OCCURRENCE}:exec::p0/2`;

    expect(edge(graph, beforeId, detachedId)?.requestTraversal)
      .toMatchObject({ basis: "span-body", spanId: SPAN_ID });
    expect(edge(graph, detachedId, afterId)?.requestTraversal)
      .toMatchObject({ basis: "span-body", spanId: SPAN_ID });
  });
});

const FLOWS: LogicFlows = {
  [ALPHA_RUN]: [
    {
      kind: "branch",
      branchKind: "if",
      label: "if !request.customerId",
      source: { file: "order.ts", line: 8 },
      paths: [{
        label: "then",
        role: "then",
        pathId: "then",
        body: [
          { kind: "call", label: "ValidationError", target: BETA_RUN, resolution: "resolved", source: { file: "order.ts", line: 9, col: 10, endLine: 9, endCol: 31 } },
          { kind: "exit", variant: "throw", label: "new ValidationError()", source: { file: "order.ts", line: 9, col: 4, endLine: 9, endCol: 32 } },
        ],
      }],
    },
    {
      kind: "branch",
      branchKind: "if",
      label: "if request.lines.length === 0",
      source: { file: "order.ts", line: 11 },
      paths: [{
        label: "then",
        role: "then",
        pathId: "then",
        body: [
          { kind: "call", label: "ValidationError", target: BETA_RUN, resolution: "resolved", source: { file: "order.ts", line: 12 } },
          { kind: "exit", variant: "throw", label: "new ValidationError()", source: { file: "order.ts", line: 12 } },
        ],
      }],
    },
    {
      kind: "loop",
      label: "for each line",
      source: { file: "order.ts", line: 14 },
      body: [{ kind: "call", label: "assertLineIsSane", target: BETA_RUN, resolution: "resolved", source: { file: "order.ts", line: 15 } }],
    },
  ],
};

function caughtTryFlows(): LogicFlows {
  return {
    [ALPHA_RUN]: [
      {
        kind: "branch",
        branchKind: "try",
        label: "try/catch",
        source: { file: "order.ts", line: 29 },
        paths: [
          {
            label: "try",
            role: "try",
            pathId: "try",
            body: [
              { kind: "call", label: "prepare", target: null, resolution: "unresolved", source: { file: "order.ts", line: 30 } },
              { kind: "call", label: "risky", target: null, resolution: "unresolved", source: { file: "order.ts", line: 31 } },
              { kind: "call", label: "skipped", target: null, resolution: "unresolved", source: { file: "order.ts", line: 32 } },
            ],
          },
          {
            label: "catch error",
            role: "catch",
            pathId: "catch",
            source: { file: "order.ts", line: 33 },
            body: [
              { kind: "call", label: "recover", target: null, resolution: "unresolved", source: { file: "order.ts", line: 34 } },
              { kind: "call", label: "recovered", target: null, resolution: "unresolved", source: { file: "order.ts", line: 35 } },
            ],
          },
          {
            label: "finally",
            role: "finally",
            pathId: "finally",
            body: [
              { kind: "call", label: "cleanup", target: null, resolution: "unresolved", source: { file: "order.ts", line: 36 } },
              { kind: "call", label: "cleaned", target: null, resolution: "unresolved", source: { file: "order.ts", line: 37 } },
            ],
          },
        ],
      },
      { kind: "call", label: "afterTry", target: null, resolution: "unresolved" },
    ],
  };
}

function trace(events: TimelineEvent[], status: "unset" | "ok" | "error" = "ok"): RequestTrace {
  return {
    traceId: TRACE_ID,
    name: "POST /orders",
    rootSpanId: SPAN_ID,
    startedAtUnixNano: at(0),
    endedAtUnixNano: at(10),
    status,
    attributes: {},
    spans: [{
      spanId: SPAN_ID,
      nodeId: ALPHA_RUN,
      name: "validateOrderRequest",
      kind: "server",
      startedAtUnixNano: at(0),
      endedAtUnixNano: at(10),
      status,
      attributes: {},
      events,
    }],
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
  };
}

function childSpan(
  spanId: string,
  startMs: number,
  status: "unset" | "ok" | "error",
): TimelineSpan {
  return {
    spanId,
    parentSpanId: SPAN_ID,
    nodeId: BETA_RUN,
    name: "child",
    kind: "internal",
    startedAtUnixNano: at(startMs),
    endedAtUnixNano: at(startMs + 1),
    status,
    attributes: {},
    events: [],
  };
}

function branch(eventId: string, line: number, siteId: string, pathId: string): TimelineEvent {
  return {
    type: "branch.taken",
    eventId,
    timeUnixNano: at(line - 6),
    attributes: {},
    siteId,
    pathId,
    condition: line === 8 ? "!request.customerId" : "request.lines.length === 0",
    outcome: pathId === "then",
    source: { file: "src/order.ts", line },
  };
}

function branchAt(eventId: string, line: number, siteId: string, pathId: string): TimelineEvent {
  return {
    type: "branch.taken",
    eventId,
    timeUnixNano: at(2),
    attributes: {},
    siteId,
    pathId,
    condition: "try/catch",
    outcome: pathId,
    source: { file: "src/order.ts", line },
  };
}

function loop(line: number, iterations: number): TimelineEvent {
  return {
    type: "loop.summary",
    eventId: "loop",
    timeUnixNano: at(4),
    attributes: {},
    siteId: "validate:line-loop",
    label: "for request.lines",
    iterations,
    emittedIterations: iterations,
    truncated: false,
    source: { file: "src/order.ts", line },
  };
}

function loopAt(eventId: string, line: number, iterations: number): TimelineEvent {
  return {
    type: "loop.summary",
    eventId,
    timeUnixNano: at(2),
    attributes: {},
    siteId: "loop:body",
    label: "for each item",
    iterations,
    emittedIterations: iterations,
    truncated: false,
    source: { file: "src/order.ts", line },
  };
}

function exception(eventId: string, line: number): TimelineEvent {
  return {
    type: "exception",
    eventId,
    timeUnixNano: at(3),
    attributes: {},
    exceptionType: "Failure",
    handled: false,
    source: { file: "src/order.ts", line },
  };
}

function edge(
  graph: ReturnType<typeof deriveRequestExecutionFlow>,
  source: string,
  target: string,
  label?: string,
) {
  return graph.edges.find((candidate) => candidate.source === source && candidate.target === target && candidate.label === label);
}

function at(ms: number): string {
  return (1_000_000_000n + BigInt(ms) * 1_000_000n).toString();
}
