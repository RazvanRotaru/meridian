import { describe, expect, it } from "vitest";
import type { FlowStep, GraphArtifact, GraphEdge, GraphNode, ReviewContext } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { applyTick, deriveReviewDataFromContext, tickStateOf } from "./reviewData";

const file = "src/DelegateClient.ts";
const moduleId = `ts:${file}`;
const classId = `${moduleId}#DelegateClient`;
const waitId = `${classId}.waitForHookRegistration`;
const acknowledgeId = `${classId}.acknowledgeHookRegistration`;
const promiseId = `promise:${file}#DelegateClient._hookRegistrationReady`;
const bootstrapId = "ts:src/bootstrap.ts#bootstrapIframe";

function node(
  id: string,
  kind: string,
  displayName: string,
  locationFile: string,
  startLine: number,
  endLine: number,
  parentId: string | null = null,
): GraphNode {
  return {
    id,
    kind,
    displayName,
    qualifiedName: id,
    parentId,
    location: { file: locationFile, startLine, endLine },
  };
}

const waitFlow: FlowStep[] = [{
  kind: "exit",
  variant: "return",
  label: "this._hookRegistrationReady",
  source: { file, line: 41 },
}];

const head = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-15T00:00:00.000Z",
  generator: { name: "test", version: "1" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(moduleId, "module", "DelegateClient.ts", file, 1, 80),
    node(classId, "class", "DelegateClient", file, 2, 70, moduleId),
    node(promiseId, "promise", "_hookRegistrationReady", file, 5, 8, classId),
    node(acknowledgeId, "method", "acknowledgeHookRegistration", file, 30, 37, classId),
    node(waitId, "method", "waitForHookRegistration", file, 40, 42, classId),
    node(bootstrapId, "function", "bootstrapIframe", "src/bootstrap.ts", 10, 30),
  ],
  edges: [
    { id: "return", source: waitId, target: promiseId, kind: "returnsPromise", resolution: "resolved" },
    { id: "resolve", source: acknowledgeId, target: promiseId, kind: "resolvesPromise", resolution: "resolved" },
    { id: "reject", source: acknowledgeId, target: promiseId, kind: "rejectsPromise", resolution: "resolved" },
    // The awaiter is a consumer of the story, not part of its grouped resource API.
    { id: "await", source: bootstrapId, target: promiseId, kind: "awaitsPromise", resolution: "resolved" },
  ] as GraphEdge[],
  extensions: {
    logicFlow: {
      [waitId]: waitFlow,
      [acknowledgeId]: [{
        kind: "branch",
        branchKind: "if",
        label: "if error",
        paths: [],
        source: { file, line: 31 },
      }],
      [bootstrapId]: [{ kind: "call", label: "waitForHookRegistration", target: waitId, resolution: "resolved" }],
    },
  },
} as unknown as GraphArtifact;

const base = {
  ...head,
  edges: [],
  extensions: { logicFlow: { [waitId]: waitFlow, [bootstrapId]: [] } },
} as unknown as GraphArtifact;

const context: ReviewContext = {
  changedFiles: [{ path: file, status: "modified", hunks: [{ start: 30, end: 42 }] }],
  baseRef: "main",
  baseSha: null,
  headRef: "feature",
  reviewKey: "repo|pr-promise-story",
  warnings: [],
};

describe("Promise-resource affected flow stories", () => {
  it("groups return/settlement roots under the waiter and leaves the awaiter flow separate", () => {
    const review = deriveReviewDataFromContext(context, head, buildGraphIndex(head), base);

    expect(review.rows).toHaveLength(2);
    const story = review.rows[0];
    expect(story.flow.flowId).toBe(waitId);
    expect(story.displayName).toBe("waitForHookRegistration");
    expect(story.causalResourceId).toBe(promiseId);
    expect(new Set(story.memberFlowIds)).toEqual(new Set([waitId, acknowledgeId]));
    expect(story.memberEvidence.map((member) => [member.flow.flowId, member.flowChange])).toEqual([
      [acknowledgeId, "new"],
      [waitId, "unchanged"],
    ]);
    expect(story.flowChange).toBe("new");
    expect(story.group).toBe("changed");
    expect(story.fingerprint).toMatch(/^causal:promise:/);

    expect(review.rows[1].flow.flowId).toBe(bootstrapId);
    expect(review.rows[1].memberFlowIds).toEqual([bootstrapId]);
    expect(review.rows[1].causalResourceId).toBeNull();
  });

  it("uses one merged fingerprint and representative tick for the whole story", () => {
    const story = deriveReviewDataFromContext(context, head, buildGraphIndex(head), base).rows[0];
    const ticks = applyTick({}, story, "toggle", "2026-07-15T12:00:00.000Z");

    expect(Object.keys(ticks)).toEqual([waitId]);
    expect(tickStateOf(story, ticks)).toBe("done");
    expect(ticks[waitId]?.fingerprint).toBe(story.fingerprint);
  });
});
