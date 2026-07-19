import { describe, expect, it } from "vitest";
import { OVERVIEW_PROJECTION_REQUEST } from "../graph/graphProjectionClient";
import { prReviewBaselineRestoreCommit } from "./prReviewSession";
import type { BlueprintState } from "./store";

describe("prReviewBaselineRestoreCommit", () => {
  it("atomically releases review churn and the review-owned module scene when ending the session", () => {
    const baseline: NonNullable<BlueprintState["prReviewBaseline"]> = {
      graphId: "baseline",
      projectionKey: "baseline-key",
      projectionId: "baseline-projection",
      request: OVERVIEW_PROJECTION_REQUEST,
      endpoints: {
        graphId: "baseline",
        manifestUrl: "/api/graph/manifest?id=baseline",
        projectionUrl: "/api/graph/projection?id=baseline",
        searchUrl: "/api/graph/search?id=baseline",
      },
      syntheticExecutionUrl: null,
      syntheticScenarios: [],
      syntheticExecutionTrust: null,
    };
    const state = {
      prReviewBaseline: baseline,
      syntheticExecutionUrl: null,
      syntheticScenarios: [],
      syntheticExecutionTrust: null,
      flowPaneOrigin: null,
      reviewFileDelta: {
        "src/review.ts": { added: 4, deleted: 2, status: "modified" },
      },
      moduleRfNodes: [{ id: "review-node", position: { x: 10, y: 20 }, data: {} }],
      moduleRfEdges: [{ id: "review-edge", source: "review-node", target: "other" }],
      moduleSemanticLayers: [{
        depth: 1,
        focus: null,
        anchorId: "review-node",
        label: "Review parent",
        effectiveFocus: null,
      }],
      moduleEffectiveFocus: "review-node",
      moduleLayoutStatus: "ready",
      moduleLayoutActivity: { label: "Review layout" },
    } as unknown as BlueprintState;

    const commit = prReviewBaselineRestoreCommit(state, { endSession: true });

    expect(commit).not.toBeNull();
    expect(commit).toEqual(expect.objectContaining({
      reviewFileDelta: {},
      moduleRfNodes: [],
      moduleRfEdges: [],
      moduleSemanticLayers: [],
      moduleEffectiveFocus: null,
      moduleLayoutStatus: "idle",
      moduleLayoutActivity: null,
    }));
  });
});
