import type { FlowPath } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { resolveLogicFlowOccurrence } from "./logicFlowOccurrence";

const A = "ts:src/a.ts#a";
const B = "ts:src/b.ts#b";
const C = "ts:src/c.ts#c";
const D = "ts:src/d.ts#d";
const EXEC = "request:trace:span:span:exec";

describe("resolveLogicFlowOccurrence", () => {
  it("resolves a call under a folded loop without consulting layout nodes", () => {
    const bodies: FlowPath[] = [{
      label: "root",
      body: [
        { kind: "await", label: "first", mode: "single", inputs: [] },
        { kind: "await", label: "second", mode: "single", inputs: [] },
        {
          kind: "loop",
          label: "for lines",
          body: [{ kind: "call", label: "assert", target: A, resolution: "resolved" }],
        },
      ],
    }];

    expect(resolveLogicFlowOccurrence({
      rootId: EXEC,
      bodies,
      flows: {},
      occurrenceId: `${EXEC}::p0/2/p0/0`,
    })).toEqual({ kind: "target", targetId: A, requiredFlowIds: [A] });
  });

  it("returns the exact missing call-chain shard, then resolves the deeper target", () => {
    const bodies: FlowPath[] = [{
      label: "root",
      body: [{ kind: "call", label: "a", target: A, resolution: "resolved" }],
    }];
    const occurrenceId = `${EXEC}::p0/0/0`;

    expect(resolveLogicFlowOccurrence({
      rootId: EXEC,
      bodies,
      flows: {},
      occurrenceId,
    })).toEqual({ kind: "blocked", missingFlowId: A, requiredFlowIds: [A] });

    expect(resolveLogicFlowOccurrence({
      rootId: EXEC,
      bodies,
      flows: { [A]: [{ kind: "call", label: "b", target: B, resolution: "resolved" }] },
      occurrenceId,
    })).toEqual({ kind: "target", targetId: B, requiredFlowIds: [A, B] });
  });

  it("shares branch, callback, shared-finally, and fallback-try address shapes with the renderer", () => {
    const bodies: FlowPath[] = [{
      label: "root",
      body: [{
        kind: "branch",
        branchKind: "if",
        label: "if ready",
        paths: [
          { label: "then", role: "then", body: [] },
          { label: "else", role: "else", body: [{ kind: "call", label: "a", target: A, resolution: "resolved" }] },
        ],
      }, {
        kind: "callback",
        label: "callback",
        body: [{ kind: "call", label: "b", target: B, resolution: "resolved" }],
      }, {
        kind: "branch",
        branchKind: "try",
        label: "try shared finally",
        paths: [
          { label: "try", role: "try", body: [] },
          { label: "catch", role: "catch", body: [] },
          { label: "finally", role: "finally", body: [{ kind: "call", label: "c", target: C, resolution: "resolved" }] },
        ],
      }, {
        kind: "branch",
        branchKind: "try",
        label: "try fallback",
        paths: [
          { label: "try", role: "try", body: [{ kind: "exit", variant: "return", label: null }] },
          { label: "catch", role: "catch", body: [{ kind: "call", label: "d", target: D, resolution: "resolved" }] },
          { label: "finally", role: "finally", body: [] },
        ],
      }],
    }];

    for (const [occurrenceId, targetId] of [
      [`${EXEC}::p0/0/b1/0`, A],
      [`${EXEC}::p0/1/p0/0`, B],
      [`${EXEC}::p0/2/finally/0`, C],
      [`${EXEC}::p0/3/p1/0`, D],
    ] as const) {
      expect(resolveLogicFlowOccurrence({ rootId: EXEC, bodies, flows: {}, occurrenceId }))
        .toEqual({ kind: "target", targetId, requiredFlowIds: [targetId] });
    }
    expect(resolveLogicFlowOccurrence({
      rootId: EXEC,
      bodies,
      flows: {},
      occurrenceId: `${EXEC}::p0/2::finally`,
    })).toEqual({ kind: "structural", requiredFlowIds: [] });
  });

  it("fails closed for malformed, stale, and unresolved call occurrences", () => {
    const bodies: FlowPath[] = [{
      label: "root",
      body: [{ kind: "call", label: "external", target: A, resolution: "external" }],
    }];

    expect(resolveLogicFlowOccurrence({
      rootId: EXEC,
      bodies,
      flows: {},
      occurrenceId: `${EXEC}::p0/0`,
    })).toEqual({ kind: "structural", requiredFlowIds: [] });
    expect(resolveLogicFlowOccurrence({
      rootId: EXEC,
      bodies,
      flows: {},
      occurrenceId: `${EXEC}::p9/0`,
    })).toBeNull();
    expect(resolveLogicFlowOccurrence({
      rootId: EXEC,
      bodies,
      flows: {},
      occurrenceId: "request:other:exec::p0/0",
    })).toBeNull();
  });
});
