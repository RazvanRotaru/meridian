import type { FlowStep, GraphNode } from "@meridian/core";
import { describe, expect, it } from "vitest";
import {
  callOccurrenceSemantics,
  declarationSemantics,
  detachedCallSummary,
  mergeNodeSemantics,
} from "./nodeSemantics";

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "ts:work.ts#Worker.run",
    kind: "method",
    qualifiedName: "Worker.run",
    displayName: "run",
    location: { file: "work.ts", startLine: 1 },
    ...overrides,
  };
}

describe("node semantic derivation", () => {
  it("preserves declaration modifiers and a Promise return independently", () => {
    expect(declarationSemantics(node({
      signature: "run(): Promise<Result>",
      tags: ["public", "async", "static"],
    }))).toEqual({ modifiers: ["async", "static"], returnsPromise: true });
  });

  it("does not call a Python async declaration a JavaScript Promise", () => {
    expect(declarationSemantics(node({
      id: "py:worker.py#run",
      signature: "run() -> Result",
      tags: ["async"],
    }))).toEqual({ modifiers: ["async"] });
  });

  it("does not infer a Promise from async syntax alone", () => {
    expect(declarationSemantics(node({
      signature: "stream(): AsyncGenerator<Result>",
      tags: ["async"],
    }))).toEqual({ modifiers: ["async"] });
  });

  it("keeps an extracted async generator explicit and non-Promise", () => {
    expect(declarationSemantics(node({
      signature: "stream(): AsyncGenerator<Result>",
      tags: ["async", "generator"],
    }))).toEqual({ modifiers: ["async", "generator"] });
  });

  it("uses the extractor's type-checked Promise result tag when syntax omits a return type", () => {
    expect(declarationSemantics(node({
      signature: "load()",
      tags: ["async", "returns-promise"],
    }))).toEqual({ modifiers: ["async"], returnsPromise: true });
  });

  it("does not mistake a nested Promise type for the callable's direct result", () => {
    expect(declarationSemantics(node({
      signature: "factory(): () => Promise<Result>",
    }))).toBeUndefined();
    expect(declarationSemantics(node({
      signature: "wrapper(): { pending: Promise<Result> }",
    }))).toBeUndefined();
    expect(declarationSemantics(node({
      signature: "register(handler: { (x: Result): Promise<void> })",
    }))).toBeUndefined();
    expect(declarationSemantics(node({
      signature: "register(handler: (x: Result) => void): Promise<void>",
    }))).toEqual({ returnsPromise: true });
    expect(declarationSemantics(node({
      signature: "loadAll(): Promise<Result>[]",
    }))).toBeUndefined();
    expect(declarationSemantics(node({
      signature: "maybe(): Promise<Result> | null",
    }))).toBeUndefined();
    expect(declarationSemantics(node({
      signature: "nested(): Promise<Array<Result>>",
    }))).toEqual({ returnsPromise: true });
    expect(declarationSemantics(node({
      signature: "callback(): Promise<() => void>",
    }))).toEqual({ returnsPromise: true });
  });

  it("does not treat JavaScript await as proof of a Promise-valued call", () => {
    expect(callOccurrenceSemantics({
      awaited: true,
      async: { kind: "direct-await", taskId: "task:1" },
    })).toEqual({ asyncState: { kind: "awaited" } });
  });

  it("gives explicit detached state precedence over its launch annotation", () => {
    expect(callOccurrenceSemantics({
      detached: true,
      async: { kind: "launch", taskId: "task:1" },
    })).toEqual({ returnsPromise: true, asyncState: { kind: "detached" } });
  });

  it("keeps a launch truthful when the Promise may be joined later", () => {
    expect(callOccurrenceSemantics({
      async: { kind: "launch", taskId: "task:1", binding: "pending" },
    })).toEqual({
      returnsPromise: true,
      asyncState: { kind: "launched", binding: "pending" },
    });
  });

  it("merges declaration and occurrence lanes without losing modifiers", () => {
    expect(mergeNodeSemantics(
      { modifiers: ["async"], returnsPromise: true },
      { asyncState: { kind: "awaited" } },
      { nestedNotAwaited: 2 },
    )).toEqual({
      modifiers: ["async"],
      returnsPromise: true,
      asyncState: { kind: "awaited" },
      nestedNotAwaited: 2,
    });
  });

  it("separates proven detached Promises from arbitrary dropped results inside a callee", () => {
    const steps: FlowStep[] = [
      {
        kind: "call",
        label: "publish",
        target: null,
        resolution: "unresolved",
        detached: true,
        async: { kind: "launch", taskId: "task:publish" },
      },
      {
        kind: "branch",
        label: "if enabled",
        paths: [{
          label: "then",
          body: [{ kind: "call", label: "void syncLog", target: null, resolution: "unresolved", detached: true }],
        }],
      },
    ];

    expect(detachedCallSummary(steps)).toEqual({ notAwaited: 1, resultsDropped: 1 });
  });
});
