import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { affectedFlowTouchesIds, type AffectedFlowRow } from "../../derive/reviewData";
import { affectedReviewFlowRelatesToNodes } from "../../derive/reviewFlowRelation";
import { ReviewFlowsSection, affectedFlowFiles, affectedFlowGroupCount, visibleAffectedFlows } from "./ReviewFlowsSection";

const WAIT_FLOW = {
  flowId: "ts:src/client.ts#waitForHookRegistration",
  ownerFile: "src/client.ts",
  ownerChanged: true,
  changedFilesHit: [] as string[],
};
const ACK_FLOW = {
  flowId: "ts:src/hooks.ts#acknowledgeHookRegistration",
  ownerFile: "src/hooks.ts",
  ownerChanged: true,
  changedFilesHit: [] as string[],
};

const NEW_ROW: AffectedFlowRow = {
  flow: {
    ...WAIT_FLOW,
    ownerChanged: true,
    changedFilesHit: ["src/hooks.ts"],
  },
  memberEvidence: [
    {
      flow: WAIT_FLOW,
      displayName: "waitForHookRegistration",
      kind: "method",
      file: "src/client.ts",
      startLine: 32,
      isTest: false,
      flowChange: "new",
      fingerprint: "wait-flow",
    },
    {
      flow: ACK_FLOW,
      displayName: "acknowledgeHookRegistration",
      kind: "method",
      file: "src/hooks.ts",
      startLine: 42,
      isTest: false,
      flowChange: "new",
      fingerprint: "ack-flow",
    },
  ],
  memberFlowIds: [WAIT_FLOW.flowId, ACK_FLOW.flowId],
  causalResourceId: "promise:src/client.ts#hookRegistrationReady",
  displayName: "waitForHookRegistration",
  kind: "method",
  file: "src/client.ts",
  startLine: 32,
  isTest: false,
  group: "changed",
  flowChange: "new",
  fingerprint: "new-flow",
};

const STATE = {
  review: {
    context: { reviewKey: "fixture", changedFiles: [], warnings: [] },
    rows: [NEW_ROW],
    flows: { [NEW_ROW.flow.flowId]: [] },
  },
  reviewTicks: {},
  reviewGroups: null,
  reviewActiveGroupId: null,
  reviewPathScope: null,
  reviewFocusedSubgraph: null,
  moduleSelected: new Set([ACK_FLOW.flowId]),
  index: { nodesById: new Map([[ACK_FLOW.flowId, { displayName: "acknowledgeHookRegistration" }]]) },
  flowSelection: null,
  reviewFlowSplitView: "timeline",
  reviewOpenFlowSplitOnSelect: true,
  reviewFlowExplicitView: null,
  prSelected: null,
  prPreparedArtifactCurrent: false,
};

vi.mock("../../state/StoreContext", () => ({
  useBlueprint: (selector: (state: typeof STATE) => unknown) => selector(STATE),
  useBlueprintActions: () => ({
    toggleReviewTick: () => undefined,
    setReviewLit: () => undefined,
    selectFlowEntry: () => undefined,
    openReviewFlow: () => undefined,
    requestSyntheticEditor: () => undefined,
  }),
}));

describe("ReviewFlowsSection", () => {
  it("shows a grouped Promise API once under its waiter representative", () => {
    const markup = renderToStaticMarkup(<ReviewFlowsSection />);

    expect(markup).toContain("Affected logic flows");
    expect(markup).toContain("1 new");
    expect(markup).toContain(">NEW<");
    expect(markup).toContain("View flow");
    expect(markup).toContain('aria-label="View sequence for waitForHookRegistration"');
    expect(markup).not.toContain('aria-label="View sequence for acknowledgeHookRegistration"');
    expect(markup).toContain('aria-label="Affected logic flows list"');
    expect(markup).toContain('aria-label="Show only flows related to acknowledgeHookRegistration"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain(">Related<");
    expect(markup.indexOf('aria-label="Show only flows related to acknowledgeHookRegistration"'))
      .toBeLessThan(markup.indexOf('role="region" aria-label="Affected logic flows list"'));
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-controls="review-affected-logic-flows-list"');
  });

  it("retains every member's owner file for path and change-group scoping", () => {
    expect(affectedFlowFiles(NEW_ROW)).toEqual(["src/client.ts", "src/hooks.ts"]);
    expect(affectedFlowTouchesIds(NEW_ROW, new Set([ACK_FLOW.flowId]))).toBe(true);
    expect(affectedFlowGroupCount(NEW_ROW, [
      { id: "client", label: "client", files: ["src/client.ts"], moduleIds: [], flowIds: [WAIT_FLOW.flowId] },
      { id: "host", label: "host", files: ["src/hooks.ts"], moduleIds: [], flowIds: [ACK_FLOW.flowId] },
    ])).toBe(2);
    expect(affectedReviewFlowRelatesToNodes(
      NEW_ROW,
      new Set([ACK_FLOW.flowId]),
      new Set([ACK_FLOW.flowId]),
    )).toBe(true);
    expect(affectedReviewFlowRelatesToNodes(
      NEW_ROW,
      new Set(),
      new Set([NEW_ROW.causalResourceId!]),
    )).toBe(true);
  });

  it("does not offer base-side direct roots as PR-head flows in synchronous review mode", () => {
    const impacted = { ...NEW_ROW, group: "impacted" as const, flowChange: "unknown" as const };

    expect(visibleAffectedFlows([NEW_ROW, impacted], false)).toEqual([impacted]);
    expect(visibleAffectedFlows([NEW_ROW, impacted], true)).toEqual([NEW_ROW, impacted]);
  });
});
