/**
 * Pins the list pane's row-visibility rules: the file-filter chip matches by a flow's own file
 * OR any module it touches, "Hide reviewed" drops checked rows, and the two compose (a flow can
 * be dropped by either).
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { RankedReviewFlow } from "../derive/reviewFlows";
import { visibleFlows } from "./reviewListFilters";

function node(id: string, file: string): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId: null, location: { file, startLine: 1 } } as GraphNode;
}

const INDEX = buildGraphIndex({
  nodes: [node("m:api", "src/api.ts"), node("m:svc", "src/svc.ts"), node("m:util", "src/util.ts")],
  edges: [],
} as unknown as GraphArtifact);

function flow(overrides: Partial<RankedReviewFlow>): RankedReviewFlow {
  return {
    rootId: "m:api#handler",
    displayName: "handler",
    file: "src/api.ts",
    reasons: ["changed"],
    callsIntoFiles: [],
    stepCount: 1,
    branchCount: 0,
    touchedModuleIds: ["m:api"],
    ...overrides,
  };
}

describe("visibleFlows", () => {
  it("keeps every flow when unfiltered and not hiding reviewed", () => {
    const flows = [flow({}), flow({ rootId: "m:svc#compute", file: "src/svc.ts", touchedModuleIds: ["m:svc"] })];
    const result = visibleFlows(flows, INDEX, { filterFile: null, hideReviewed: false, reviewedFlowIds: new Set() });
    expect(result).toEqual(flows);
  });

  it("keeps a flow whose own file matches the filter", () => {
    const flows = [flow({})];
    const result = visibleFlows(flows, INDEX, { filterFile: "src/api.ts", hideReviewed: false, reviewedFlowIds: new Set() });
    expect(result).toEqual(flows);
  });

  it("keeps a flow whose touched module (not its own file) matches the filter", () => {
    const calling = flow({ rootId: "m:api#handler", touchedModuleIds: ["m:api", "m:svc"] });
    const result = visibleFlows([calling], INDEX, { filterFile: "src/svc.ts", hideReviewed: false, reviewedFlowIds: new Set() });
    expect(result).toEqual([calling]);
  });

  it("drops a flow that touches neither the filtered file nor a matching module", () => {
    const result = visibleFlows([flow({})], INDEX, { filterFile: "src/util.ts", hideReviewed: false, reviewedFlowIds: new Set() });
    expect(result).toEqual([]);
  });

  it("hides a reviewed flow when hideReviewed is set", () => {
    const reviewed = flow({ rootId: "reviewed-flow" });
    const pending = flow({ rootId: "pending-flow" });
    const result = visibleFlows([reviewed, pending], INDEX, {
      filterFile: null,
      hideReviewed: true,
      reviewedFlowIds: new Set(["reviewed-flow"]),
    });
    expect(result.map((f) => f.rootId)).toEqual(["pending-flow"]);
  });

  it("composes the file filter and hideReviewed together", () => {
    const inFileReviewed = flow({ rootId: "a", file: "src/api.ts", touchedModuleIds: ["m:api"] });
    const inFilePending = flow({ rootId: "b", file: "src/api.ts", touchedModuleIds: ["m:api"] });
    const otherFile = flow({ rootId: "c", file: "src/svc.ts", touchedModuleIds: ["m:svc"] });
    const result = visibleFlows([inFileReviewed, inFilePending, otherFile], INDEX, {
      filterFile: "src/api.ts",
      hideReviewed: true,
      reviewedFlowIds: new Set(["a"]),
    });
    expect(result.map((f) => f.rootId)).toEqual(["b"]);
  });
});
