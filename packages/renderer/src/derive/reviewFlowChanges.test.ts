import { describe, expect, it } from "vitest";
import type { ChangeStatus, EdgeResolution, FlowStep, GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { reviewFlowChanges } from "./reviewFlowChanges";

const call = (
  target: string | null,
  resolution: EdgeResolution = "resolved",
  label = target ?? "missing",
): FlowStep => ({ kind: "call", label, target, resolution });

function fakeIndex(
  names: Record<string, string>,
  statuses: Record<string, ChangeStatus>,
  changedIds: readonly string[] = [],
): GraphIndex {
  return {
    nodesById: new Map(Object.entries(names).map(([id, displayName]) => [id, { id, displayName } as GraphNode])),
    changedStatus: new Map(Object.entries(statuses)),
    // Deliberately present for the exact-status regression: the helper must not read this broader set.
    changedIds: new Set(changedIds),
  } as unknown as GraphIndex;
}

describe("reviewFlowChanges", () => {
  it("puts the changed root first, then recursively changed call targets in flow order", () => {
    const steps: FlowStep[] = [
      call("a", "resolved", "first a"),
      {
        kind: "loop",
        label: "for each item",
        body: [call("b", "resolved", "inside loop"), call("a", "resolved", "second a")],
      },
      {
        kind: "callback",
        label: "on complete",
        body: [call("c", "resolved", "inside callback")],
      },
      {
        kind: "branch",
        label: "if ready",
        paths: [
          { label: "then", body: [call("d", "resolved", "then call")] },
          { label: "else", body: [call("b", "resolved", "second b")] },
        ],
      },
    ];
    const index = fakeIndex(
      { root: "Run", a: "Alpha", b: "Beta", c: "Gamma", d: "Delta" },
      { root: "modified", a: "added", b: "deleted", c: "modified", d: "added" },
    );

    expect(reviewFlowChanges("root", steps, index)).toEqual([
      { targetId: "root", status: "modified", label: "Run" },
      { targetId: "a", status: "added", label: "Alpha" },
      { targetId: "b", status: "deleted", label: "Beta" },
      { targetId: "c", status: "modified", label: "Gamma" },
      { targetId: "d", status: "added", label: "Delta" },
    ]);
  });

  it("uses exact changedStatus entries and ignores unresolved, external, and target-less calls", () => {
    const index = fakeIndex(
      { unchanged: "Unchanged", unresolved: "Unresolved", external: "External" },
      { unresolved: "modified", external: "added", missing: "deleted" },
      ["unchanged"],
    );
    const steps: FlowStep[] = [
      call("unchanged", "resolved"),
      call("unresolved", "unresolved"),
      call("external", "external"),
      call(null, "unresolved"),
      call("missing", "resolved", "fallback name"),
    ];

    expect(reviewFlowChanges("root", steps, index)).toEqual([
      { targetId: "missing", status: "deleted", label: "fallback name" },
    ]);
  });

  it("deduplicates a recursive call back to an already-listed changed root", () => {
    const index = fakeIndex({ root: "Run" }, { root: "modified" });

    expect(reviewFlowChanges("root", [call("root", "resolved", "recurse")], index)).toEqual([
      { targetId: "root", status: "modified", label: "Run" },
    ]);
  });
});
