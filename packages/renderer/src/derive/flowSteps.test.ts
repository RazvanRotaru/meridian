import { describe, expect, it } from "vitest";
import type { LogicFlows } from "@meridian/core";
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
});
