import { describe, expect, it } from "vitest";
import type { GraphNode, LogicFlows } from "@meridian/core";
import { emitFlowSteps } from "./flowSteps";

describe("emitFlowSteps call ownership", () => {
  it("attributes calls inside an expanded callee to that callee's artifact block", () => {
    const flows: LogicFlows = {
      "ts:app.ts#start": [
        { kind: "call", label: "load", target: "ts:lib.ts#load", resolution: "resolved" },
      ],
      "ts:lib.ts#load": [
        { kind: "call", label: "read", target: "ts:data.ts#read", resolution: "resolved" },
      ],
    };

    const emission = emitFlowSteps(
      "ts:app.ts#start",
      flows["ts:app.ts#start"],
      flows,
      new Set(["step:ts:app.ts#start:0"]),
    );

    expect(emission.calls).toEqual([
      {
        stepId: "step:ts:app.ts#start:0",
        blockId: "ts:app.ts#start",
        target: "ts:lib.ts#load",
      },
      {
        stepId: "step:step:ts:app.ts#start:0:0",
        blockId: "ts:lib.ts#load",
        target: "ts:data.ts#read",
      },
    ]);
  });

  it("retains callable kind, declaration traits, Promise state, and nested warnings for Map nodes", () => {
    const flows: LogicFlows = {
      "ts:app.ts#start": [{
        kind: "call",
        label: "worker.load",
        target: "ts:worker.ts#Worker.load",
        resolution: "resolved",
        awaited: true,
        async: { kind: "direct-await", taskId: "task:load" },
      }],
      "ts:worker.ts#Worker.load": [{
        kind: "call",
        label: "publish",
        target: null,
        resolution: "unresolved",
        detached: true,
        async: { kind: "launch", taskId: "task:publish" },
      }],
    };
    const target: GraphNode = {
      id: "ts:worker.ts#Worker.load",
      kind: "method",
      qualifiedName: "Worker.load",
      displayName: "load",
      location: { file: "worker.ts", startLine: 1 },
      signature: "load(): Promise<Result>",
      tags: ["async"],
    };

    const emission = emitFlowSteps(
      "ts:app.ts#start",
      flows["ts:app.ts#start"],
      flows,
      new Set(),
      (id) => id,
      (id) => id === target.id ? target : undefined,
    );

    expect(emission.steps[0]?.data).toMatchObject({
      nodeKind: "method",
      targetId: target.id,
      resolution: "resolved",
      signature: "load(): Promise<Result>",
      semantics: {
        modifiers: ["async"],
        returnsPromise: true,
        asyncState: { kind: "awaited" },
        nestedNotAwaited: 1,
      },
    });
  });

  it("keeps a resolved local call expandable when its callee has no charted steps", () => {
    const owner = "ts:app.ts#start";
    const target = "ts:worker.ts#Worker.visitOrder";
    const flows: LogicFlows = {
      [owner]: [{ kind: "call", label: "visitOrder", target, resolution: "resolved" }],
      [target]: [],
    };
    const stepId = `step:${owner}:0`;

    const collapsed = emitFlowSteps(owner, flows[owner], flows, new Set());
    expect(collapsed.steps).toHaveLength(1);
    expect(collapsed.steps[0]).toMatchObject({
      id: stepId,
      parentId: owner,
      data: {
        targetId: target,
        resolution: "resolved",
        resolved: true,
        isContainer: true,
        isExpanded: false,
        emptyFlow: true,
      },
    });

    const expanded = emitFlowSteps(owner, flows[owner], flows, new Set([stepId]));
    // Expansion decorates the same call occurrence; it does not invent a placeholder child node.
    expect(expanded.steps).toHaveLength(1);
    expect(expanded.steps[0]).toMatchObject({
      id: stepId,
      data: { isContainer: true, isExpanded: true, emptyFlow: true },
    });
    expect(expanded.steps.filter((step) => step.parentId === stepId)).toEqual([]);
    expect(expanded.chain).toEqual([]);
    // The real call relationship survives even though the callee body is empty.
    expect(expanded.calls).toEqual([{ stepId, blockId: owner, target }]);
  });

  it("leaves external and unresolved calls non-expandable", () => {
    const owner = "ts:app.ts#start";
    const flows: LogicFlows = {
      [owner]: [
        { kind: "call", label: "fetch", target: "ext:web#fetch", resolution: "external" },
        { kind: "call", label: "dynamic", target: null, resolution: "unresolved" },
      ],
    };

    const emission = emitFlowSteps(owner, flows[owner], flows, new Set([
      `step:${owner}:0`,
      `step:${owner}:1`,
    ]));

    expect(emission.steps.map((step) => step.data)).toEqual([
      expect.objectContaining({ resolution: "external", isContainer: false, isExpanded: false }),
      expect.objectContaining({ resolution: "unresolved", isContainer: false, isExpanded: false }),
    ]);
    expect(emission.steps.every((step) => step.data.emptyFlow !== true)).toBe(true);
  });

  it("gives empty loops, callbacks, cases, and try/catch the same honest expansion", () => {
    const owner = "ts:app.ts#emptyStructures";
    const flow: LogicFlows[string] = [
      { kind: "loop", label: "for each order", body: [] },
      { kind: "callback", label: "on complete", body: [] },
      { kind: "branch", label: "switch status", paths: [{ label: "case pending", body: [] }] },
      {
        kind: "branch",
        branchKind: "try",
        label: "try/catch",
        paths: [{ label: "try", role: "try", body: [] }, { label: "catch error", role: "catch", body: [] }],
      },
    ];
    const ids = flow.map((_, index) => `step:${owner}:${index}`);

    const collapsed = emitFlowSteps(owner, flow, { [owner]: flow }, new Set());
    expect(collapsed.steps.map((entry) => entry.data)).toEqual(flow.map(() => expect.objectContaining({
      isContainer: true,
      isExpanded: false,
      childCount: 0,
      emptyFlow: true,
    })));

    const expanded = emitFlowSteps(owner, flow, { [owner]: flow }, new Set(ids));
    expect(expanded.steps).toHaveLength(flow.length);
    expect(expanded.steps.map((entry) => entry.data)).toEqual(flow.map(() => expect.objectContaining({
      isContainer: true,
      isExpanded: true,
      childCount: 0,
      emptyFlow: true,
    })));
    expect(expanded.steps.every((entry) => !ids.includes(entry.parentId))).toBe(true);
    expect(expanded.chain).toHaveLength(flow.length - 1);
  });
});
