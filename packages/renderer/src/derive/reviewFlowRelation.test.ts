import { describe, expect, it } from "vitest";
import type { FlowStep, LogicFlows } from "@meridian/core";
import { reviewFlowRootsRelatedToNodes } from "./reviewFlowRelation";
import { buildFlowContainmentIndex } from "./flowInspect";

const SELECTED = "ts:src/selected.ts#selected";
const DIRECT_CALLER = "ts:src/direct.ts#directCaller";
const UNRELATED = "ts:src/unrelated.ts#unrelated";

describe("reviewFlowRootsRelatedToNodes", () => {
  it("includes the selected block's own flow and flows that call it from nested control paths", () => {
    const nestedCall: FlowStep = {
      kind: "branch",
      label: "if ready",
      paths: [{
        label: "then",
        body: [{ kind: "call", label: "selected", target: SELECTED, resolution: "resolved" }],
      }],
    };
    const flows: LogicFlows = {
      [SELECTED]: [],
      [DIRECT_CALLER]: [nestedCall],
      [UNRELATED]: [{ kind: "call", label: "selected", target: SELECTED, resolution: "unresolved" }],
    };

    expect(reviewFlowRootsRelatedToNodes(buildFlowContainmentIndex(flows), new Set([SELECTED]))).toEqual(
      new Set([SELECTED, DIRECT_CALLER]),
    );
  });

  it("unions related roots for a multi-selection", () => {
    const second = "ts:src/second.ts#second";
    const secondCaller = "ts:src/second-caller.ts#secondCaller";
    const flows: LogicFlows = {
      [DIRECT_CALLER]: [{ kind: "call", label: "selected", target: SELECTED, resolution: "resolved" }],
      [secondCaller]: [{ kind: "call", label: "second", target: second, resolution: "resolved" }],
    };

    expect(reviewFlowRootsRelatedToNodes(buildFlowContainmentIndex(flows), new Set([SELECTED, second]))).toEqual(
      new Set([SELECTED, DIRECT_CALLER, second, secondCaller]),
    );
  });
});
