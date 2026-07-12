import { describe, expect, it } from "vitest";
import {
  logicBranchBodyPrefix,
  logicCallBodyPrefix,
  logicControlBodyPrefix,
  logicFinallyBodyPrefix,
  logicNodeId,
  logicServiceFrameId,
  logicStepPath,
  logicTopLevelBodyPrefix,
} from "./logicFlowAddress";

describe("Logic flow addresses", () => {
  it("keeps the established nested node-id grammar in one pure contract", () => {
    const topLevelCall = logicStepPath(logicTopLevelBodyPrefix(0), 2);
    const nestedBranch = logicStepPath(logicCallBodyPrefix(topLevelCall), 1);
    const branchLoop = logicStepPath(logicBranchBodyPrefix(nestedBranch, 3), 0);
    const loopCall = logicStepPath(logicControlBodyPrefix(branchLoop, 0), 4);

    expect(topLevelCall).toBe("p0/2");
    expect(nestedBranch).toBe("p0/2/1");
    expect(branchLoop).toBe("p0/2/1/b3/0");
    expect(logicFinallyBodyPrefix(nestedBranch)).toBe("p0/2/1/finally/");
    expect(logicNodeId("request:trace:exec", loopCall))
      .toBe("request:trace:exec::p0/2/1/b3/0/p0/4");
    expect(logicServiceFrameId("root", nestedBranch)).toBe("root::svc/p0/2/1");
  });
});
