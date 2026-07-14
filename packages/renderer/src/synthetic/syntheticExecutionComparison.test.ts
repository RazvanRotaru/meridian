import { describe, expect, it } from "vitest";
import type {
  JsonValue,
  SyntheticExecution,
  SyntheticNodeSnapshot,
  TimelineEvent,
  TimelineSpan,
} from "@meridian/core";
import { compareSyntheticExecutions } from "./syntheticExecutionComparison";

const ROOT = "ts:src/root.ts#root";
const LINE = "ts:src/line.ts#runLine";

describe("compareSyntheticExecutions", () => {
  it("ignores per-run ids, clocks, durations, producer array order, and object property order", () => {
    const before = execution({ run: "before", reverse: false });
    const after = execution({ run: "after", reverse: true, baseNano: 9_000_000_000n });

    const comparison = compareSyntheticExecutions(before, after);

    expect(comparison).toMatchObject({
      compatible: true,
      confidence: "complete",
      inputChanges: [],
      summary: {
        inputChangeCount: 0,
        pathChangeCount: 0,
        outputChangeCount: 0,
        statusChangeCount: 0,
        changedOccurrenceCount: 0,
        hasChanges: false,
      },
    });
    expect(comparison.occurrences).toHaveLength(3);
    expect(comparison.occurrences.every((occurrence) => (
      occurrence.presence === "matched" && !occurrence.changed
    ))).toBe(true);
    expect(comparison.occurrences[1]?.key).not.toContain(before.trace.traceId);
    expect(comparison.occurrences[1]?.key).not.toContain(before.trace.spans[1]?.spanId);
  });

  it("aligns repeated calls by parent path and ordinal while reporting input, decisions, and a new iteration", () => {
    const before = execution({ run: "before", quantity: 2, lineCount: 2, pathId: "then" });
    const after = execution({ run: "after", quantity: 3, lineCount: 3, pathId: "else" });

    const comparison = compareSyntheticExecutions(before, after);
    const lines = comparison.occurrences.filter((occurrence) => occurrence.nodeId === LINE);
    const root = comparison.occurrences.find((occurrence) => occurrence.nodeId === ROOT)!;

    expect(comparison.inputChanges).toEqual([
      { kind: "changed", path: "$.request.quantity", before: 2, after: 3 },
    ]);
    expect(lines.map((occurrence) => [occurrence.ordinal, occurrence.presence])).toEqual([
      [1, "matched"],
      [2, "matched"],
      [3, "after-only"],
    ]);
    expect(root.decisionChanges.map((change) => [change.type, change.kind])).toEqual([
      ["branch", "changed"],
      ["loop", "changed"],
    ]);
    expect(root.decisionChanges[0]?.before).toMatchObject({ type: "branch", pathId: "then" });
    expect(root.decisionChanges[0]?.after).toMatchObject({ type: "branch", pathId: "else" });
    expect(comparison.summary).toMatchObject({
      inputChangeCount: 1,
      pathChangeCount: 3,
      changedOccurrenceCount: 2,
      hasChanges: true,
    });
  });

  it("keeps value, explicit null, void, error, and uncaptured outcomes distinct", () => {
    const before = execution({ run: "before" });
    const after = execution({ run: "after" });
    before.snapshots[0] = { ...before.snapshots[0]!, output: null };
    after.snapshots[0] = withoutOutcome(after.snapshots[0]!);
    before.snapshots[1] = withoutOutcome(before.snapshots[1]!, "ValidationError: before");
    after.snapshots[1] = { ...after.snapshots[1]!, output: { accepted: true } };
    after.snapshots = after.snapshots.filter((snapshot) => snapshot.spanId !== after.trace.spans[2]?.spanId);
    before.trace.spans[1]!.status = "error";

    const comparison = compareSyntheticExecutions(before, after);
    const root = comparison.occurrences[0]!;
    const firstLine = comparison.occurrences[1]!;
    const secondLine = comparison.occurrences[2]!;

    expect(root.outcomeChange).toMatchObject({ before: { kind: "value", value: null }, after: { kind: "void" } });
    expect(firstLine).toMatchObject({
      statusChanged: true,
      outcomeChange: { before: { kind: "error" }, after: { kind: "value" } },
    });
    expect(secondLine).toMatchObject({
      snapshotAvailabilityChanged: true,
      snapshotInputChanges: null,
      outcomeChange: { before: { kind: "value" }, after: { kind: "uncaptured" } },
    });
    expect(comparison.summary).toMatchObject({ outputChangeCount: 3, statusChangeCount: 1 });
  });

  it("does not cross-match identical nodes called by different parents", () => {
    const before = execution({ run: "before" });
    const after = execution({ run: "after" });
    const beforeLine = before.trace.spans[2]!;
    const afterLine = after.trace.spans[2]!;
    beforeLine.parentSpanId = before.trace.spans[1]!.spanId;
    afterLine.parentSpanId = after.trace.spans[1]!.spanId;

    const comparison = compareSyntheticExecutions(before, after);
    const lines = comparison.occurrences.filter((occurrence) => occurrence.nodeId === LINE);

    expect(lines).toHaveLength(2);
    expect(lines.map((occurrence) => occurrence.ordinal)).toEqual([1, 1]);
    expect(lines[0]?.parentKey).not.toBe(lines[1]?.parentKey);
  });

  it("refuses different roots or scenarios and marks incomplete/warned captures as partial", () => {
    const before = execution({ run: "before", complete: false });
    const after = execution({ run: "after", warnings: ["one callable was not instrumented"] });
    const partial = compareSyntheticExecutions(before, after);
    const otherScenario = compareSyntheticExecutions(before, { ...after, scenarioId: "other" });
    const otherRoot = compareSyntheticExecutions(before, { ...after, rootId: "ts:src/other.ts#root" });

    expect(partial).toMatchObject({ compatible: true, confidence: "partial" });
    expect(partial.partialReasons).toEqual([
      "Previous execution is a partial capture.",
      "Current execution reported capture warnings.",
    ]);
    expect(otherScenario).toMatchObject({
      compatible: false,
      incompatibilityReason: "Synthetic executions use different scenarios.",
      occurrences: [],
    });
    expect(otherRoot).toMatchObject({
      compatible: false,
      incompatibilityReason: "Synthetic executions target different flow roots.",
      occurrences: [],
    });
  });
});

interface ExecutionOptions {
  run: "before" | "after";
  baseNano?: bigint;
  reverse?: boolean;
  quantity?: number;
  lineCount?: number;
  pathId?: string;
  complete?: boolean;
  warnings?: string[];
}

function execution(options: ExecutionOptions): SyntheticExecution {
  const base = options.baseNano ?? 1_000_000_000n;
  const quantity = options.quantity ?? 2;
  const lineCount = options.lineCount ?? 2;
  const ids = Array.from({ length: lineCount + 1 }, (_, index) => spanId(options.run, index + 1));
  const rootId = ids[0]!;
  const events: TimelineEvent[] = [
    branchEvent(options.run, base + 2n, options.pathId ?? "then"),
    loopEvent(options.run, base + 3n, lineCount),
  ];
  const root: TimelineSpan = span(rootId, ROOT, undefined, base, base + 20n, events, "ok");
  const lines = Array.from({ length: lineCount }, (_, index) => (
    span(ids[index + 1]!, LINE, rootId, base + BigInt(4 + index * 3), base + BigInt(6 + index * 3), [], "ok")
  ));
  const spans = options.reverse ? [root, ...lines].reverse() : [root, ...lines];
  const input: JsonValue = options.run === "after"
    ? { request: { note: "stable", quantity } }
    : { request: { quantity, note: "stable" } };
  const snapshots: SyntheticNodeSnapshot[] = [
    { spanId: rootId, nodeId: ROOT, occurrenceKey: "root:1", input, output: { accepted: lineCount } },
    ...lines.map((line, index) => ({
      spanId: line.spanId,
      nodeId: LINE,
      occurrenceKey: `line:${index + 1}`,
      input: { line: index + 1 },
      output: { accepted: true },
    })),
  ];
  return {
    executionVersion: "1.0.0",
    outcome: "completed",
    scenarioId: "scenario",
    rootId: ROOT,
    generatedAt: options.run === "before" ? "2026-07-13T00:00:00.000Z" : "2026-07-13T00:01:00.000Z",
    input,
    output: { accepted: lineCount },
    trace: {
      traceId: options.run === "before" ? "11111111111111111111111111111111" : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "Synthetic scenario",
      rootSpanId: rootId,
      startedAtUnixNano: base.toString(),
      endedAtUnixNano: (base + 20n).toString(),
      status: "ok",
      attributes: {},
      spans,
      completeness: {
        complete: options.complete ?? true,
        droppedSpans: options.complete === false ? 1 : 0,
        droppedEvents: 0,
        droppedValues: 0,
      },
    },
    snapshots: options.reverse ? snapshots.reverse() : snapshots,
    inputOverrideResults: [],
    watchHits: [],
    warnings: options.warnings ?? [],
  };
}

function span(
  spanIdValue: string,
  nodeId: string,
  parentSpanId: string | undefined,
  startedAt: bigint,
  endedAt: bigint,
  events: TimelineEvent[],
  status: TimelineSpan["status"],
): TimelineSpan {
  return {
    spanId: spanIdValue,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    nodeId,
    name: nodeId === ROOT ? "root" : "runLine",
    kind: "internal",
    startedAtUnixNano: startedAt.toString(),
    endedAtUnixNano: endedAt.toString(),
    status,
    attributes: {},
    events,
  };
}

function branchEvent(run: "before" | "after", time: bigint, pathId: string): TimelineEvent {
  return {
    type: "branch.taken",
    eventId: `${run}-branch`,
    timeUnixNano: time.toString(),
    attributes: {},
    siteId: "root:decision",
    pathId,
    condition: "request.quantity > 2",
    outcome: pathId === "then",
    valueName: "request.quantity",
    value: pathId === "then" ? 2 : 3,
    source: { file: "src/root.ts", line: 4 },
  };
}

function loopEvent(run: "before" | "after", time: bigint, iterations: number): TimelineEvent {
  return {
    type: "loop.summary",
    eventId: `${run}-loop`,
    timeUnixNano: time.toString(),
    attributes: {},
    siteId: "root:loop",
    label: "for lines",
    iterations,
    emittedIterations: iterations,
    truncated: false,
    source: { file: "src/root.ts", line: 8 },
  };
}

function spanId(run: "before" | "after", index: number): string {
  return run === "before"
    ? index.toString(16).padStart(16, "0")
    : `${"a".repeat(15)}${index.toString(16)}`;
}

function withoutOutcome(snapshot: SyntheticNodeSnapshot, error?: string): SyntheticNodeSnapshot {
  return {
    spanId: snapshot.spanId,
    nodeId: snapshot.nodeId,
    occurrenceKey: snapshot.occurrenceKey,
    input: snapshot.input,
    ...(error === undefined ? {} : { error }),
  };
}
