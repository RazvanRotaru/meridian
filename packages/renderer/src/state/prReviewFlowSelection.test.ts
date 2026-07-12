import { describe, expect, it, vi } from "vitest";
import type { FlowStep, GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { FlowSelectionRef } from "../derive/flowBlocks";
import { paintMinimalLevel } from "../components/paintMinimal";
import { createBlueprintStore, type StoreDependencies } from "./store";
import type { PrSummary } from "./prTypes";
import type { ReviewFlowSplitView } from "./reviewPreferences";

function node(
  id: string,
  kind: string,
  file: string,
  parentId: string | null,
  startLine: number,
  endLine: number,
): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id.split(/[.#]/).at(-1) ?? id,
    parentId,
    location: { file, startLine, endLine },
  };
}

const PACKAGE_ID = "ts:src";
const ROOT_FILE = "ts:src/orders.ts";
const ROOT_CLASS = `${ROOT_FILE}#OrderService`;
const ROOT_METHOD = `${ROOT_CLASS}.placeOrder`;
const ALT_ROOT_METHOD = `${ROOT_CLASS}.retryOrder`;
const SECOND_ALT_ROOT_METHOD = `${ROOT_CLASS}.resumeOrder`;
const TARGET_FILE = "ts:src/validation.ts";
const TARGET_FUNCTION = `${TARGET_FILE}#validateOrderRequest`;
const NEXT_FILE = "ts:src/policy.ts";
const NEXT_FUNCTION = `${NEXT_FILE}#loadPolicy`;
const CALLER_FILE = "ts:src/preview.ts";
const CALLER_FUNCTION = `${CALLER_FILE}#previewOrder`;
const UNRELATED_FILE = "ts:src/audit.ts";
const UNRELATED_FUNCTION = `${UNRELATED_FILE}#recordAttempt`;

const callTarget: FlowStep = {
  kind: "call",
  label: "validateOrderRequest",
  target: TARGET_FUNCTION,
  resolution: "resolved",
};
const callUnrelated: FlowStep = {
  kind: "call",
  label: "recordAttempt",
  target: UNRELATED_FUNCTION,
  resolution: "resolved",
};

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-11T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(PACKAGE_ID, "package", "src", null, 1, 80),
    node(ROOT_FILE, "module", "src/orders.ts", PACKAGE_ID, 1, 50),
    node(ROOT_CLASS, "class", "src/orders.ts", ROOT_FILE, 3, 40),
    node(ROOT_METHOD, "method", "src/orders.ts", ROOT_CLASS, 10, 25),
    node(ALT_ROOT_METHOD, "method", "src/orders.ts", ROOT_CLASS, 30, 35),
    node(SECOND_ALT_ROOT_METHOD, "method", "src/orders.ts", ROOT_CLASS, 36, 39),
    node(TARGET_FILE, "module", "src/validation.ts", PACKAGE_ID, 1, 20),
    node(TARGET_FUNCTION, "function", "src/validation.ts", TARGET_FILE, 3, 8),
    node(NEXT_FILE, "module", "src/policy.ts", PACKAGE_ID, 1, 20),
    node(NEXT_FUNCTION, "function", "src/policy.ts", NEXT_FILE, 3, 8),
    node(CALLER_FILE, "module", "src/preview.ts", PACKAGE_ID, 1, 20),
    node(CALLER_FUNCTION, "function", "src/preview.ts", CALLER_FILE, 3, 8),
    node(UNRELATED_FILE, "module", "src/audit.ts", PACKAGE_ID, 1, 20),
    node(UNRELATED_FUNCTION, "function", "src/audit.ts", UNRELATED_FILE, 3, 8),
  ],
  edges: [
    {
      id: `imports@${ROOT_FILE}|${TARGET_FILE}`,
      source: ROOT_FILE,
      target: TARGET_FILE,
      kind: "imports",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${ROOT_METHOD}|${TARGET_FUNCTION}`,
      source: ROOT_METHOD,
      target: TARGET_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${ALT_ROOT_METHOD}|${TARGET_FUNCTION}`,
      source: ALT_ROOT_METHOD,
      target: TARGET_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${SECOND_ALT_ROOT_METHOD}|${TARGET_FUNCTION}`,
      source: SECOND_ALT_ROOT_METHOD,
      target: TARGET_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${TARGET_FUNCTION}|${NEXT_FUNCTION}`,
      source: TARGET_FUNCTION,
      target: NEXT_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${CALLER_FUNCTION}|${TARGET_FUNCTION}`,
      source: CALLER_FUNCTION,
      target: TARGET_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
    {
      id: `calls@${ROOT_METHOD}|${UNRELATED_FUNCTION}`,
      source: ROOT_METHOD,
      target: UNRELATED_FUNCTION,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
    },
  ],
  extensions: {
    logicFlow: {
      [ROOT_METHOD]: [callTarget],
      [ALT_ROOT_METHOD]: [callTarget],
      [SECOND_ALT_ROOT_METHOD]: [callTarget],
      [TARGET_FUNCTION]: [],
    },
  },
} as unknown as GraphArtifact;

const FLOW_SELECTION: FlowSelectionRef = { rootId: ROOT_METHOD, blockPath: [] };

function pr(number: number): PrSummary {
  return {
    number,
    title: `PR ${number}`,
    body: null,
    author: "octo",
    headRef: "feature/review-flow",
    headSha: null,
    baseRef: "main",
    updatedAt: "2026-07-11T00:00:00.000Z",
    draft: false,
    state: "open",
    url: `https://github.com/o/r/pull/${number}`,
  };
}

function freshStore(extra?: Partial<StoreDependencies>) {
  return createBlueprintStore({
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prSessionSource: { repository: "https://github.com/o/r", subdir: "" },
    prsUrl: "/api/prs?id=artifact-1",
    prOneUrl: "/api/prs/one?id=artifact-1",
    prFilesUrl: "/api/prs/files?id=artifact-1",
    prRelatedUrl: "/api/prs/related?id=artifact-1",
    prCommentsUrl: "/api/prs/comments?id=artifact-1",
    prChecksUrl: "/api/prs/checks?id=artifact-1",
    prReviewUrl: "/api/prs/review?id=artifact-1",
    ...extra,
  });
}

async function activeReviewStore(reviewFlowSplitView: ReviewFlowSplitView = "graph") {
  const store = freshStore();
  store.setState({
    reviewFlowSplitView,
    viewMode: "prs",
    prSelected: 17,
    prsList: { open: [pr(17)], closed: null },
    prFiles: [
      {
        path: "src/orders.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        hunks: [{ start: 15, end: 16 }],
      },
    ],
  });

  await store.getState().reviewPrInGraph();
  await vi.waitFor(() => {
    expect(store.getState().minimalLayoutStatus).toBe("ready");
  });
  expect(store.getState().review?.rows.map((row) => row.flow.flowId)).toContain(ROOT_METHOD);
  expect(store.getState().minimalSeedIds).toEqual([ROOT_FILE]);
  return store;
}

async function impactedFlowReviewStore() {
  const artifact = {
    ...ARTIFACT,
    extensions: {
      ...ARTIFACT.extensions,
      logicFlow: {
        [ROOT_METHOD]: [callTarget, callUnrelated],
        [ALT_ROOT_METHOD]: [callTarget],
        [SECOND_ALT_ROOT_METHOD]: [callTarget],
        [TARGET_FUNCTION]: [],
        [UNRELATED_FUNCTION]: [],
      },
    },
  } as unknown as GraphArtifact;
  const store = freshStore({ artifact, index: buildGraphIndex(artifact) });
  store.setState({
    reviewFlowSplitView: "graph",
    viewMode: "prs",
    prSelected: 17,
    prsList: { open: [pr(17)], closed: null },
    prFiles: [
      {
        path: "src/validation.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [{ start: 3, end: 4 }],
      },
    ],
  });

  await store.getState().reviewPrInGraph();
  await vi.waitFor(() => {
    expect(store.getState().minimalLayoutStatus).toBe("ready");
  });
  expect(store.getState().review?.rows).toContainEqual(expect.objectContaining({
    group: "impacted",
    flow: expect.objectContaining({ flowId: ROOT_METHOD }),
  }));
  expect(store.getState().minimalSeedIds).toEqual([TARGET_FILE]);
  return store;
}

describe("PR-review logic-flow selection", () => {
  it.each(["timeline", "metro", "blocks"] as const)(
    "skips execution-graph ELK for %s and derives it only when requested",
    async (alternateView) => {
      const store = await activeReviewStore(alternateView);

      store.getState().selectFlowEntry(FLOW_SELECTION);
      await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
      expect(store.getState().flowPaneLayoutStatus).toBe("idle");
      expect(store.getState().flowPaneRfNodes).toEqual([]);
      expect(store.getState().flowPaneRfEdges).toEqual([]);

      store.getState().setReviewFlowSplitView("graph");
      await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
      expect(store.getState().flowPaneRfNodes.length).toBeGreaterThan(0);

      store.getState().setReviewFlowSplitView(alternateView);
      expect(store.getState().flowPaneLayoutStatus).toBe("idle");
      expect(store.getState().flowPaneRfNodes).toEqual([]);
      expect(store.getState().flowPaneRfEdges).toEqual([]);
    },
  );

  it("opens the exact flow on the review graph, reveals its nested root, and resets on close", async () => {
    const store = await activeReviewStore();
    const reviewExpansion = new Set(store.getState().moduleExpanded);
    expect(reviewExpansion.has(ROOT_FILE)).toBe(true);
    expect(reviewExpansion.has(ROOT_CLASS)).toBe(false);

    store.getState().selectFlowEntry(FLOW_SELECTION);

    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.flowPaneLayoutStatus).toBe("ready");
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "ghost" }));
    });
    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_METHOD, TARGET_FUNCTION]));
    expect(store.getState().moduleExpanded.has(ROOT_FILE)).toBe(true);
    expect(store.getState().moduleExpanded.has(ROOT_CLASS)).toBe(true);
    expect(store.getState().reviewSelectedId).toBeNull();
    expect(store.getState().logicSelected).toBeNull();

    const defaultPaint = paintMinimalLevel(
      store.getState().minimalRfNodes,
      store.getState().minimalRfEdges,
      store.getState().moduleSelected,
      1,
      "subgraph",
    );
    expect(defaultPaint.nodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD }));
    expect(defaultPaint.nodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "ghost" }));
    expect(defaultPaint.nodes.some((candidate) => candidate.id === UNRELATED_FUNCTION)).toBe(false);
    expect(defaultPaint.edges).toContainEqual(expect.objectContaining({
      source: ROOT_METHOD,
      target: TARGET_FUNCTION,
      style: expect.objectContaining({ opacity: 1 }),
    }));

    store.getState().selectFlowEntry(null);

    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes.some((candidate) => candidate.id === ROOT_METHOD)).toBe(false);
    });
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().moduleSelected).toEqual(new Set());
    expect(store.getState().moduleExpanded).toEqual(reviewExpansion);
    expect(store.getState().reviewSelectedId).toBeNull();
    expect(store.getState().logicSelected).toBeNull();
  });

  it("narrows the graph to one flow target and restores the whole-flow selection", async () => {
    const store = await activeReviewStore();
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => {
      expect(store.getState().flowPaneLayoutStatus).toBe("ready");
      expect(store.getState().minimalRfNodes.some((candidate) => candidate.id === ROOT_METHOD)).toBe(true);
    });

    store.getState().selectFlowPaneTarget(ROOT_METHOD);
    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "ghost" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: UNRELATED_FUNCTION, type: "ghost" }));
      expect(state.minimalRfNodes.some((candidate) => candidate.id === NEXT_FUNCTION)).toBe(false);
      expect(state.minimalRfNodes.some((candidate) => candidate.id === CALLER_FUNCTION)).toBe(false);
      expect(state.minimalRfEdges.filter((edge) => edge.source === ROOT_METHOD && edge.target === TARGET_FUNCTION)).toHaveLength(1);
      expect(state.minimalRfEdges.some((edge) =>
        edge.source === ROOT_FILE
        && edge.target === TARGET_FILE
        && (edge.data as { category?: string } | undefined)?.category === "dep"
      )).toBe(false);
    });

    store.getState().selectFlowPaneTarget(TARGET_FUNCTION);

    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: NEXT_FUNCTION, type: "ghost" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: CALLER_FUNCTION, type: "ghost" }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: ROOT_METHOD, target: TARGET_FUNCTION }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: TARGET_FUNCTION, target: NEXT_FUNCTION }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: CALLER_FUNCTION, target: TARGET_FUNCTION }));
    });
    expect(store.getState().minimalMemberIds).toEqual([ROOT_FILE]);
    expect(store.getState().moduleSelected).toEqual(new Set([TARGET_FUNCTION]));
    expect(store.getState().reviewSelectedId).toBe(TARGET_FUNCTION);
    expect(store.getState().logicSelected).toBe(TARGET_FUNCTION);

    const targetPaint = paintMinimalLevel(
      store.getState().minimalRfNodes,
      store.getState().minimalRfEdges,
      store.getState().moduleSelected,
      1,
      "node",
    );
    expect(targetPaint.nodes).toContainEqual(expect.objectContaining({ id: NEXT_FUNCTION, type: "ghost" }));
    expect(targetPaint.nodes).toContainEqual(expect.objectContaining({ id: CALLER_FUNCTION, type: "ghost" }));
    expect(targetPaint.edges).toContainEqual(expect.objectContaining({
      source: TARGET_FUNCTION,
      target: NEXT_FUNCTION,
      style: expect.objectContaining({ opacity: 1 }),
    }));
    expect(targetPaint.edges).toContainEqual(expect.objectContaining({
      source: CALLER_FUNCTION,
      target: TARGET_FUNCTION,
      style: expect.objectContaining({ opacity: 1 }),
    }));

    // A graph-pane click routes through selectModule(null): while a review flow is open it must
    // clear the one-node inspection and restore the flow-wide default, never remove all emphasis.
    store.getState().selectModule(null);

    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "ghost" }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: ROOT_METHOD, target: TARGET_FUNCTION }));
      expect(state.minimalRfNodes.some((candidate) => candidate.id === NEXT_FUNCTION)).toBe(false);
      expect(state.minimalRfNodes.some((candidate) => candidate.id === CALLER_FUNCTION)).toBe(false);
    });
    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_METHOD, TARGET_FUNCTION]));
    expect(store.getState().reviewSelectedId).toBeNull();
    expect(store.getState().logicSelected).toBeNull();
  });

  it("materializes an unchanged impacted flow root so every flow member is highlighted", async () => {
    const store = await impactedFlowReviewStore();
    store.getState().selectFlowEntry(FLOW_SELECTION);

    await vi.waitFor(() => {
      const state = store.getState();
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: ROOT_METHOD, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: TARGET_FUNCTION, type: "block" }));
      expect(state.minimalRfNodes).toContainEqual(expect.objectContaining({ id: UNRELATED_FUNCTION, type: "ghost" }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: ROOT_METHOD, target: TARGET_FUNCTION }));
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({ source: ROOT_METHOD, target: UNRELATED_FUNCTION }));
    });
    expect(store.getState().minimalMemberIds).toEqual([TARGET_FILE]);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_METHOD, TARGET_FUNCTION, UNRELATED_FUNCTION]));
    const painted = paintMinimalLevel(
      store.getState().minimalRfNodes,
      store.getState().minimalRfEdges,
      store.getState().moduleSelected,
      1,
      "subgraph",
    );
    expect(painted.nodes).toContainEqual(expect.objectContaining({ id: UNRELATED_FUNCTION, type: "ghost" }));
    expect(painted.edges).toContainEqual(expect.objectContaining({
      source: ROOT_METHOD,
      target: UNRELATED_FUNCTION,
      style: expect.objectContaining({ opacity: 1 }),
    }));
  });

  it("reprojects exact edges when switching between flows with the same expansion footprint", async () => {
    const store = await impactedFlowReviewStore();
    store.getState().selectFlowEntry({ rootId: ALT_ROOT_METHOD, blockPath: [] });
    await vi.waitFor(() => {
      expect(store.getState().minimalRfEdges).toContainEqual(expect.objectContaining({
        source: ALT_ROOT_METHOD,
        target: TARGET_FUNCTION,
      }));
    });
    const expanded = new Set(store.getState().moduleExpanded);
    const members = [...store.getState().minimalMemberIds];
    const relayout = vi.fn(store.getState().minimalRelayout);
    store.setState({ minimalRelayout: relayout });

    store.getState().selectFlowEntry({ rootId: SECOND_ALT_ROOT_METHOD, blockPath: [] });
    await vi.waitFor(() => {
      const state = store.getState();
      expect(relayout).toHaveBeenCalledTimes(1);
      expect(state.minimalLayoutStatus).toBe("ready");
      expect(state.minimalRfEdges).toContainEqual(expect.objectContaining({
        source: SECOND_ALT_ROOT_METHOD,
        target: TARGET_FUNCTION,
      }));
    });
    expect(store.getState().moduleExpanded).toEqual(expanded);
    expect(store.getState().minimalMemberIds).toEqual(members);
    expect(store.getState().moduleSelected).toEqual(new Set([SECOND_ALT_ROOT_METHOD, TARGET_FUNCTION]));
    const painted = paintMinimalLevel(
      store.getState().minimalRfNodes,
      store.getState().minimalRfEdges,
      store.getState().moduleSelected,
      1,
      "subgraph",
    );
    expect(painted.nodes.find((node) => node.id === ALT_ROOT_METHOD)?.style?.opacity).toBe(0.28);
    expect(painted.edges).toContainEqual(expect.objectContaining({
      source: SECOND_ALT_ROOT_METHOD,
      target: TARGET_FUNCTION,
      style: expect.objectContaining({ opacity: 1 }),
    }));
  });

  it("keeps ordinary graph selection intact when the explorer closes without an active flow", async () => {
    const store = await activeReviewStore();
    store.setState({
      flowExplorerOpen: true,
      moduleSelected: new Set([ROOT_FILE]),
      reviewSelectedId: ROOT_FILE,
      reviewLitNodeIds: new Set([ROOT_METHOD]),
    });

    store.getState().toggleFlowExplorer();
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE]));
    expect(store.getState().reviewSelectedId).toBe(ROOT_FILE);
    expect(store.getState().reviewLitNodeIds).toEqual(new Set([ROOT_METHOD]));
  });

  it("leaves flow review before selecting a real graph node outside that flow", async () => {
    const store = await activeReviewStore();
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));

    store.getState().selectModule(ROOT_FILE);
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().logicSelected).toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE]));
    expect(store.getState().reviewSelectedId).toBeNull();

    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    store.getState().toggleModuleSelect(TARGET_FILE);
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE, TARGET_FILE]));
  });

  it("does not carry a normal base-Map flow into a resumed PR review", async () => {
    const store = await activeReviewStore();
    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);

    // With the overlay closed this is the ordinary cross-cutting Code Flow explorer, not review
    // inspection, so it intentionally has no review baseline.
    store.getState().selectFlowEntry(FLOW_SELECTION);
    expect(store.getState().flowSelection).toEqual(FLOW_SELECTION);
    expect(store.getState().reviewFlowBaseline).toBeNull();

    await store.getState().resumePrReview();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().minimalSeedIds).toEqual([ROOT_FILE]);
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().reviewFlowBaseline).toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set());
  });

  it("preserves ordinary review selection across a soft close and resume when no flow is open", async () => {
    const store = await activeReviewStore();
    store.setState({
      moduleSelected: new Set([ROOT_FILE]),
      reviewSelectedId: ROOT_FILE,
      reviewLitNodeIds: new Set([ROOT_METHOD]),
    });
    store.getState().closeMinimalGraph();

    await store.getState().resumePrReview();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE]));
    expect(store.getState().reviewSelectedId).toBe(ROOT_FILE);
    expect(store.getState().reviewLitNodeIds).toEqual(new Set([ROOT_METHOD]));
  });

  it("restores the pre-flow graph state when the explorer or review overlay closes", async () => {
    const store = await activeReviewStore();
    const moduleExpanded = new Set(store.getState().moduleExpanded);
    const minimalBasePositions = { [ROOT_FILE]: { x: 11, y: 17, width: 210, height: 54 } };
    store.setState({
      flowExplorerOpen: true,
      moduleSelected: new Set([ROOT_FILE]),
      minimalBasePositions,
      minimalArrange: true,
      reviewSelectedId: ROOT_FILE,
      reviewLitNodeIds: new Set([ROOT_METHOD]),
    });
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    // Flow inspection is transient even if one of the still-visible graph controls changes its
    // layout curation while the split is open.
    store.setState({ minimalBasePositions: {}, minimalArrange: false });

    store.getState().toggleFlowExplorer();
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().moduleExpanded).toEqual(moduleExpanded);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE]));
    expect(store.getState().minimalBasePositions).toEqual(minimalBasePositions);
    expect(store.getState().minimalArrange).toBe(true);
    expect(store.getState().reviewSelectedId).toBe(ROOT_FILE);
    expect(store.getState().reviewLitNodeIds).toEqual(new Set([ROOT_METHOD]));

    store.setState({ flowExplorerOpen: true });
    store.getState().selectFlowEntry(FLOW_SELECTION);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().moduleExpanded).toEqual(moduleExpanded);
    expect(store.getState().moduleSelected).toEqual(new Set([ROOT_FILE]));
  });

  it("does not let an in-flight flow layout repopulate a pane that was immediately closed", async () => {
    const store = await activeReviewStore();
    store.getState().selectFlowEntry(FLOW_SELECTION);
    store.getState().selectFlowEntry(null);

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().flowPaneLayoutStatus).toBe("idle");
    expect(store.getState().flowPaneRfNodes).toEqual([]);
    expect(store.getState().flowPaneRfEdges).toEqual([]);
  });
});
