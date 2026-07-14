import { describe, expect, it } from "vitest";
import {
  boundedSyntheticJsonValueSchema,
  syntheticFieldWatchersSchema,
  syntheticInputOverridesSchema,
  syntheticExecutionManifestSchema,
  syntheticExecutionSchema,
} from "./synthetic-execution";
import type { RequestTrace } from "./trace";

const ROOT = "ts:src/root.ts#root";
const OTHER = "ts:src/other.ts#other";

describe("synthetic execution contracts", () => {
  it("accepts a safe manifest and rejects traversal and duplicate scenario ids", () => {
    const scenario = {
      id: "happy",
      label: "Happy path",
      rootId: ROOT,
      defaultInput: { value: 1 },
      invoke: { module: "src/index.ts", export: "build", method: "service.run" },
    };
    expect(syntheticExecutionManifestSchema.safeParse({ manifestVersion: "1.0.0", scenarios: [scenario] }).success).toBe(true);
    expect(syntheticExecutionManifestSchema.safeParse({
      manifestVersion: "1.0.0",
      scenarios: [{ ...scenario, invoke: { ...scenario.invoke, module: "../secrets.ts" } }],
    }).success).toBe(false);
    expect(syntheticExecutionManifestSchema.safeParse({
      manifestVersion: "1.0.0",
      scenarios: [scenario, { ...scenario, label: "Duplicate" }],
    }).success).toBe(false);
    expect(syntheticExecutionManifestSchema.safeParse({
      manifestVersion: "1.0.0",
      scenarios: [{ ...scenario, invoke: { ...scenario.invoke, method: "__proto__.run" } }],
    }).success).toBe(false);
  });

  it("bounds collection width, total nodes, strings, and nesting depth", () => {
    expect(boundedSyntheticJsonValueSchema.safeParse({ small: [1, true, null] }).success).toBe(true);
    expect(boundedSyntheticJsonValueSchema.safeParse(Array.from({ length: 513 }, () => 0)).success).toBe(false);
    expect(boundedSyntheticJsonValueSchema.safeParse("x".repeat(16_385)).success).toBe(false);
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 14; depth += 1) nested = [nested];
    expect(boundedSyntheticJsonValueSchema.safeParse(nested).success).toBe(false);
  });

  it("requires every snapshot to join the same node as its trace span", () => {
    const trace = requestTrace();
    const execution = {
      executionVersion: "1.0.0",
      scenarioId: "happy",
      rootId: ROOT,
      generatedAt: "2026-07-12T00:00:00.000Z",
      input: { value: 1 },
      outcome: "completed",
      output: { value: 2 },
      trace,
      snapshots: [{ spanId: trace.rootSpanId, nodeId: ROOT, occurrenceKey: "r", input: { value: 1 }, output: { value: 2 } }],
      inputOverrideResults: [],
      watchHits: [],
      warnings: [],
    };
    expect(syntheticExecutionSchema.safeParse(execution).success).toBe(true);
    expect(syntheticExecutionSchema.safeParse({
      ...execution,
      snapshots: [{ ...execution.snapshots[0], nodeId: OTHER }],
    }).success).toBe(false);
    expect(syntheticExecutionSchema.safeParse({ ...execution, rootId: OTHER }).success).toBe(false);
  });

  it("bounds occurrence controls and rejects ambiguous or prototype-traversing requests", () => {
    const target = { nodeId: ROOT, occurrenceKey: "r.1:1" };
    expect(syntheticInputOverridesSchema.safeParse([{ id: "edit", target, input: { input: 2 } }]).success).toBe(true);
    expect(syntheticInputOverridesSchema.safeParse([
      { id: "first", target, input: { input: 2 } },
      { id: "second", target, input: { input: 3 } },
    ]).success).toBe(false);
    expect(syntheticFieldWatchersSchema.safeParse([{
      id: "watch",
      phase: "input",
      path: ["request", "__proto__"],
      operator: "exists",
    }]).success).toBe(false);
    expect(syntheticFieldWatchersSchema.safeParse([{
      id: "watch",
      phase: "output",
      path: ["total"],
      operator: "equals",
    }]).success).toBe(false);
  });

  it("accepts a partial watcher stop only when the hit joins its snapshot", () => {
    const trace = requestTrace();
    trace.status = "unset";
    trace.spans[0]!.status = "unset";
    trace.completeness.complete = false;
    trace.completeness.droppedValues = 1;
    const hit = {
      id: "watch-hit-1",
      watcherId: "watch",
      spanId: trace.rootSpanId,
      nodeId: ROOT,
      occurrenceKey: "r",
      phase: "input",
      path: ["input", "enabled"],
      operator: "equals",
      present: true,
      value: true,
      timeUnixNano: "150",
    };
    const execution = {
      executionVersion: "1.0.0",
      scenarioId: "happy",
      rootId: ROOT,
      generatedAt: "2026-07-12T00:00:00.000Z",
      input: { enabled: true },
      outcome: "stopped",
      trace,
      snapshots: [{ spanId: trace.rootSpanId, nodeId: ROOT, occurrenceKey: "r", input: { input: { enabled: true } } }],
      inputOverrideResults: [],
      watchHits: [hit],
      stop: { reason: "watcher", watchHitId: hit.id },
      warnings: [],
    };
    expect(syntheticExecutionSchema.safeParse(execution).success).toBe(true);
    expect(syntheticExecutionSchema.safeParse({ ...execution, output: 1 }).success).toBe(false);
    expect(syntheticExecutionSchema.safeParse({
      ...execution,
      watchHits: [{ ...hit, occurrenceKey: "wrong" }],
    }).success).toBe(false);
  });
});

function requestTrace(): RequestTrace {
  const rootSpanId = "1000000000000001";
  return {
    traceId: "11111111111111111111111111111111",
    name: "Happy path",
    rootSpanId,
    startedAtUnixNano: "100",
    endedAtUnixNano: "200",
    status: "ok",
    attributes: { "meridian.synthetic": true },
    spans: [{
      spanId: rootSpanId,
      nodeId: ROOT,
      name: "root",
      kind: "internal",
      startedAtUnixNano: "100",
      endedAtUnixNano: "200",
      status: "ok",
      attributes: {},
      events: [],
    }],
    completeness: { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 },
  };
}
