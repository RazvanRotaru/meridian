import { describe, expect, it } from "vitest";
import type { EdgeResolution, FlowStep, GraphNode, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { blockChildren, relatedNodeIds, stepsAt } from "./flowBlocks";

const call = (target: string | null, resolution: EdgeResolution = "resolved", label = target ?? "missing"): FlowStep => ({
  kind: "call",
  label,
  target,
  resolution,
});

const flows: LogicFlows = {
  root: [
    call("a"),
    {
      kind: "loop",
      label: "for users",
      body: [
        call("b"),
        {
          kind: "branch",
          label: "if valid",
          paths: [
            { role: "then", label: "then", body: [call("c")] },
            { role: "else", label: "else", body: [call("d")] },
          ],
        },
      ],
    },
    { kind: "callback", label: "onDone", body: [call("e")] },
    {
      kind: "branch",
      label: "switch mode",
      paths: [
        { role: "case", label: "case create", body: [call("create")] },
        { role: "default", label: "default", body: [call("fallback")] },
      ],
    },
  ],
};

function fakeIndex(ids: string[]): GraphIndex {
  return { nodesById: new Map(ids.map((id) => [id, { id } as GraphNode])) } as unknown as GraphIndex;
}

describe("stepsAt", () => {
  it("walks nested loop, branch, and callback block paths", () => {
    expect(stepsAt(flows, { rootId: "root", blockPath: [{ step: 1 }, { step: 1, path: 0 }] })).toEqual([call("c")]);
    expect(stepsAt(flows, { rootId: "root", blockPath: [{ step: 2 }] })).toEqual([call("e")]);
  });

  it("returns null for missing roots and invalid paths", () => {
    expect(stepsAt(flows, { rootId: "missing", blockPath: [] })).toBeNull();
    expect(stepsAt(flows, { rootId: "root", blockPath: [{ step: 9 }] })).toBeNull();
    expect(stepsAt(flows, { rootId: "root", blockPath: [{ step: 1, path: 0 }] })).toBeNull();
    expect(stepsAt(flows, { rootId: "root", blockPath: [{ step: 3, path: 4 }] })).toBeNull();
  });
});

describe("blockChildren", () => {
  it("lists directly selectable loop, callback, and branch path blocks", () => {
    expect(blockChildren(flows.root)).toEqual([
      { segment: { step: 1 }, kind: "loop", label: "for users" },
      { segment: { step: 2 }, kind: "callback", label: "onDone" },
      { segment: { step: 3, path: 0 }, kind: "branch-path", label: "switch mode: case: case create" },
      { segment: { step: 3, path: 1 }, kind: "branch-path", label: "switch mode: default" },
    ]);
  });
});

describe("relatedNodeIds", () => {
  it("includes the root and only resolved in-graph targets", () => {
    const index = fakeIndex(["root", "a", "b", "c", "e"]);
    const related = relatedNodeIds(index, flows, { rootId: "root", blockPath: [] });
    expect(related).toEqual(new Set(["root", "a", "b", "c", "e"]));
  });

  it("selects one branch path without including the other arm's targets", () => {
    const index = fakeIndex(["root", "c", "d"]);
    const related = relatedNodeIds(index, flows, { rootId: "root", blockPath: [{ step: 1 }, { step: 1, path: 0 }] });
    expect(related).toEqual(new Set(["root", "c"]));
  });
});
