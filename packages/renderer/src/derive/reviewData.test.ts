/**
 * deriveReviewData: joins core's affected-flow predicate + fingerprint to the node index for one row
 * per touched flow. null when there is no valid `review` extension; owner-changed flows group
 * "changed" and sort ahead of "impacted" callers; each row carries the flow's current fingerprint,
 * which tickStateOf compares against a stored tick to read todo / done / stale.
 */

import { describe, expect, it } from "vitest";
import type { FlowStep, GraphArtifact, GraphNode, JsonValue, LogicFlows } from "@meridian/core";
import { flowFingerprint } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { applyTick, deriveReviewData, tickStateOf, type AffectedFlowRow } from "./reviewData";

function fn(id: string, file: string, startLine: number, tags?: string[]): GraphNode {
  return {
    id,
    kind: "function",
    qualifiedName: id,
    displayName: id.split("#")[1] ?? id,
    parentId: id.split("#")[0],
    location: { file, startLine },
    ...(tags ? { tags } : {}),
  } as GraphNode;
}

function mod(id: string, file: string): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId: null, location: { file, startLine: 1 } } as GraphNode;
}

function call(target: string): FlowStep {
  return { kind: "call", label: `call ${target}`, target, resolution: "resolved" };
}

const DO_WORK = "ts:app/svc.ts#doWork";
const RUN = "ts:app/caller.ts#run";
const IDLE = "ts:app/other.ts#idle";

const FLOWS: LogicFlows = {
  [DO_WORK]: [call(RUN)], // owner file changed → affected regardless of steps
  [RUN]: [call(DO_WORK)], // owner unchanged, but calls INTO the changed svc.ts → impacted
  [IDLE]: [call(RUN)], // owner unchanged, calls only into unchanged code → NOT affected
};

function nodes(): GraphNode[] {
  return [
    mod("ts:app/svc.ts", "app/svc.ts"),
    mod("ts:app/caller.ts", "app/caller.ts"),
    mod("ts:app/other.ts", "app/other.ts"),
    fn(DO_WORK, "app/svc.ts", 10),
    fn(RUN, "app/caller.ts", 5, ["test"]),
    fn(IDLE, "app/other.ts", 3),
  ];
}

function artifact(review: JsonValue | undefined, flows: LogicFlows = FLOWS): GraphArtifact {
  const extensions: Record<string, JsonValue> = { logicFlow: flows as unknown as JsonValue };
  if (review !== undefined) {
    extensions.review = review;
  }
  return { nodes: nodes(), edges: [], extensions } as unknown as GraphArtifact;
}

const VALID_REVIEW: JsonValue = {
  changedFiles: [{ path: "app/svc.ts", status: "modified" }],
  baseRef: "origin/main",
  baseSha: "abc1234",
  headRef: "feat/x",
  reviewKey: "repo|feat/x|origin/main",
  warnings: [],
};

function dataFor(review: JsonValue | undefined, flows?: LogicFlows) {
  const art = artifact(review, flows);
  return deriveReviewData(art, buildGraphIndex(art));
}

function rowFor(data: NonNullable<ReturnType<typeof dataFor>>, flowId: string): AffectedFlowRow {
  return data.rows.find((r) => r.flow.flowId === flowId) as AffectedFlowRow;
}

describe("deriveReviewData — gating", () => {
  it("returns null when there is no review extension", () => {
    expect(dataFor(undefined)).toBeNull();
  });

  it("returns null when the review extension is malformed", () => {
    expect(dataFor({ changedFiles: "nope" } as unknown as JsonValue)).toBeNull();
  });
});

describe("deriveReviewData — rows", () => {
  it("decorates each affected flow from its owner node", () => {
    const data = dataFor(VALID_REVIEW)!;
    const row = rowFor(data, DO_WORK);
    expect(row.displayName).toBe("doWork");
    expect(row.kind).toBe("function");
    expect(row.file).toBe("app/svc.ts");
    expect(row.startLine).toBe(10);
    expect(row.group).toBe("changed");
  });

  it("groups owner-changed flows 'changed' ahead of 'impacted' callers, excluding untouched flows", () => {
    const data = dataFor(VALID_REVIEW)!;
    expect(data.rows.map((r) => r.flow.flowId)).toEqual([DO_WORK, RUN]); // idle is not affected
    expect(data.rows.map((r) => r.group)).toEqual(["changed", "impacted"]);
    expect(rowFor(data, RUN).flow.changedFilesHit).toEqual(["app/svc.ts"]);
  });

  it("reads isTest from the index testIds set", () => {
    const data = dataFor(VALID_REVIEW)!;
    expect(rowFor(data, RUN).isTest).toBe(true); // tagged "test"
    expect(rowFor(data, DO_WORK).isTest).toBe(false);
  });

  it("carries the current flow fingerprint on every row", () => {
    const data = dataFor(VALID_REVIEW)!;
    expect(rowFor(data, DO_WORK).fingerprint).toBe(flowFingerprint(FLOWS[DO_WORK]));
    expect(rowFor(data, DO_WORK).fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("exposes the review context", () => {
    const data = dataFor(VALID_REVIEW)!;
    expect(data.context.reviewKey).toBe("repo|feat/x|origin/main");
    expect(data.context.changedFiles).toEqual([{ path: "app/svc.ts", status: "modified" }]);
  });
});

describe("tickStateOf", () => {
  const row = { flow: { flowId: DO_WORK }, fingerprint: "cafebabe" } as AffectedFlowRow;

  it("is todo with no stored tick", () => {
    expect(tickStateOf(row, {})).toBe("todo");
  });

  it("is done when the stored fingerprint still matches", () => {
    expect(tickStateOf(row, { [DO_WORK]: { at: "now", fingerprint: "cafebabe" } })).toBe("done");
  });

  it("is stale when the stored fingerprint differs (flow changed since review)", () => {
    expect(tickStateOf(row, { [DO_WORK]: { at: "then", fingerprint: "deadbeef" } })).toBe("stale");
  });
});

describe("applyTick", () => {
  const row = { flow: { flowId: DO_WORK }, fingerprint: "cafebabe" } as AffectedFlowRow;
  const todo = {};
  const done = { [DO_WORK]: { at: "then", fingerprint: "cafebabe" } };
  const stale = { [DO_WORK]: { at: "then", fingerprint: "deadbeef" } };

  it("toggle: todo → fresh tick at the given time and fingerprint", () => {
    expect(applyTick(todo, row, "toggle", "T1")).toEqual({ [DO_WORK]: { at: "T1", fingerprint: "cafebabe" } });
  });

  it("toggle: done → un-ticked", () => {
    expect(applyTick(done, row, "toggle", "T1")).toEqual({});
  });

  it("toggle: stale → re-tick with the fresh fingerprint", () => {
    expect(applyTick(stale, row, "toggle", "T1")).toEqual({ [DO_WORK]: { at: "T1", fingerprint: "cafebabe" } });
  });

  it("confirm: todo → fresh tick", () => {
    expect(applyTick(todo, row, "confirm", "T1")).toEqual({ [DO_WORK]: { at: "T1", fingerprint: "cafebabe" } });
  });

  it("confirm: done → left exactly as-is (never un-ticks)", () => {
    expect(applyTick(done, row, "confirm", "T1")).toEqual(done);
  });

  it("confirm: stale → re-confirm with the fresh fingerprint", () => {
    expect(applyTick(stale, row, "confirm", "T1")).toEqual({ [DO_WORK]: { at: "T1", fingerprint: "cafebabe" } });
  });

  it("does not mutate the input record", () => {
    applyTick(done, row, "toggle", "T1");
    expect(done).toEqual({ [DO_WORK]: { at: "then", fingerprint: "cafebabe" } });
  });
});
