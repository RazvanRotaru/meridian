import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowStep, GraphArtifact, GraphNode } from "@meridian/core";
import { STATIC_LOGIC_VIEW_MODES } from "../derive/flowViewModel";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore } from "./store";

function node(id: string, kind: string, parentId: string | null, displayName = id): GraphNode {
  return { id, kind, qualifiedName: id, displayName, parentId, location: { file: id, startLine: 1 } } as GraphNode;
}

const call = (target: string): FlowStep => ({ kind: "call", label: target, target, resolution: "resolved" });

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-08T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node("ts:pkg", "package", null, "pkg"),
    node("ts:pkg/src", "package", "ts:pkg", "src"),
    node("ts:pkg/src/a.ts", "module", "ts:pkg/src", "a.ts"),
    node("ts:pkg/src/a.ts#run", "function", "ts:pkg/src/a.ts", "run"),
    node("ts:pkg/src/b.ts", "module", "ts:pkg/src", "b.ts"),
    node("ts:pkg/src/b.ts#leaf", "function", "ts:pkg/src/b.ts", "leaf"),
  ],
  edges: [],
  extensions: {
    logicFlow: {
      "ts:pkg/src/a.ts#run": [call("ts:pkg/src/b.ts#leaf")],
      "ts:pkg/src/b.ts#leaf": [{ kind: "call", label: "console.log", target: null, resolution: "unresolved" }],
    },
  } as unknown as GraphArtifact["extensions"],
};

function freshStore() {
  const index = buildGraphIndex(ARTIFACT);
  return createBlueprintStore({
    artifact: ARTIFACT,
    index,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "/api/prs",
    prOneUrl: "/api/prs/one",
    prFilesUrl: "/api/prs/files",
    prRelatedUrl: "/api/prs/related",
    prCommentsUrl: "/api/prs/comments",
    prChecksUrl: "/api/prs/checks",
    prReviewUrl: "/api/prs/review",
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("flow explorer store slice", () => {
  it("persists projection, split-opening, code-preview, and source-comment preferences without clobbering another choice", () => {
    const persisted = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => persisted.get(key) ?? null,
        setItem: (key: string, value: string) => void persisted.set(key, value),
      },
    });
    const store = freshStore();

    expect(store.getState().reviewFlowSplitView).toBe("timeline");
    expect(store.getState().reviewOpenFlowSplitOnSelect).toBe(true);
    expect(store.getState().reviewCodePreviewTrigger).toBe("hover");
    expect(store.getState().reviewHideAddedSourceCommentDiffs).toBe(false);
    store.getState().setReviewOpenFlowSplitOnSelect(false);
    expect(JSON.parse(persisted.get("meridian.prReviewPreferences") ?? "null")).toEqual({
      version: 4,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "hover",
      hideAddedSourceCommentDiffs: false,
    });
    for (const { mode } of STATIC_LOGIC_VIEW_MODES) {
      store.getState().setReviewFlowSplitView(mode);
      expect(store.getState().reviewFlowSplitView).toBe(mode);
      expect(JSON.parse(persisted.get("meridian.prReviewPreferences") ?? "null")).toEqual({
        version: 4,
        flowSplitView: mode,
        openFlowSplitOnSelect: false,
        codePreviewTrigger: "hover",
        hideAddedSourceCommentDiffs: false,
      });
      expect(freshStore().getState().reviewFlowSplitView).toBe(mode);
      expect(freshStore().getState().reviewOpenFlowSplitOnSelect).toBe(false);
      expect(freshStore().getState().reviewCodePreviewTrigger).toBe("hover");
      expect(freshStore().getState().reviewHideAddedSourceCommentDiffs).toBe(false);
    }
    store.getState().setReviewCodePreviewTrigger("click");
    expect(store.getState().reviewCodePreviewTrigger).toBe("click");
    expect(JSON.parse(persisted.get("meridian.prReviewPreferences") ?? "null")).toEqual({
      version: 4,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
      hideAddedSourceCommentDiffs: false,
    });
    expect(freshStore().getState().reviewCodePreviewTrigger).toBe("click");
    store.getState().setReviewHideAddedSourceCommentDiffs(true);
    expect(store.getState().reviewHideAddedSourceCommentDiffs).toBe(true);
    expect(JSON.parse(persisted.get("meridian.prReviewPreferences") ?? "null")).toEqual({
      version: 4,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: false,
      codePreviewTrigger: "click",
      hideAddedSourceCommentDiffs: true,
    });
    expect(freshStore().getState().reviewHideAddedSourceCommentDiffs).toBe(true);
    store.getState().setReviewOpenFlowSplitOnSelect(true);
    expect(JSON.parse(persisted.get("meridian.prReviewPreferences") ?? "null")).toEqual({
      version: 4,
      flowSplitView: "timeline",
      openFlowSplitOnSelect: true,
      codePreviewTrigger: "click",
      hideAddedSourceCommentDiffs: true,
    });
  });

  it("keeps the ordinary Code-flow execution graph when review split opening is disabled", async () => {
    const store = freshStore();
    store.getState().setReviewOpenFlowSplitOnSelect(false);

    store.getState().selectFlowEntry({ rootId: "ts:pkg/src/a.ts#run", blockPath: [] });

    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    expect(store.getState().flowPaneRfNodes.length).toBeGreaterThan(0);
  });

  it("selectFlowEntry records the selection and bulk-reveals related modules in the module map", () => {
    const store = freshStore();
    store.getState().selectFlowEntry({ rootId: "ts:pkg/src/a.ts#run", blockPath: [] });
    expect(store.getState().flowSelection).toEqual({ rootId: "ts:pkg/src/a.ts#run", blockPath: [] });
    expect(store.getState().moduleFocus).toBe("ts:pkg/src");
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:pkg/src/a.ts", "ts:pkg/src/b.ts"]));
    expect(store.getState().moduleExpanded).toEqual(new Set(["ts:pkg/src/a.ts", "ts:pkg/src/b.ts"]));
  });

  it("does not reuse or clear the main Logic view selection outside PR review", () => {
    const store = freshStore();
    store.setState({ logicSelected: "ts:pkg/src/b.ts#leaf" });
    store.getState().selectFlowEntry({ rootId: "ts:pkg/src/a.ts#run", blockPath: [] });
    store.getState().selectFlowPaneTarget("ts:pkg/src/a.ts#run");
    expect(store.getState().logicSelected).toBe("ts:pkg/src/b.ts#leaf");

    store.getState().selectFlowEntry(null);
    expect(store.getState().logicSelected).toBe("ts:pkg/src/b.ts#leaf");
  });

  it("expands a static pane occurrence in pane-owned state and resets it with the selection", async () => {
    const store = freshStore();
    const firstSelection = { rootId: "ts:pkg/src/a.ts#run", blockPath: [] };
    const occurrenceId = `${firstSelection.rootId}::0`;
    store.getState().selectFlowEntry(firstSelection);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    expect(store.getState().flowPaneRfNodes.find((node) => node.id === occurrenceId)?.data)
      .toMatchObject({ expandable: true, isExpanded: false, isContainer: false });

    store.setState({
      expandedLogic: new Set(["main-logic-occurrence"]),
      requestFlowExpansionOverrides: new Set(["request-occurrence"]),
    });
    store.getState().toggleFlowPaneExpand(occurrenceId);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));

    expect(store.getState().flowPaneExpansionOverrides).toEqual(new Set([occurrenceId]));
    expect(store.getState().expandedLogic).toEqual(new Set(["main-logic-occurrence"]));
    expect(store.getState().requestFlowExpansionOverrides).toEqual(new Set(["request-occurrence"]));
    expect(store.getState().flowPaneRfNodes.find((node) => node.id === occurrenceId)?.data)
      .toMatchObject({ isExpanded: true, isContainer: true });
    expect(store.getState().flowPaneRfNodes.some((node) => node.parentId === occurrenceId)).toBe(true);

    store.getState().selectFlowEntry({ rootId: "ts:pkg/src/b.ts#leaf", blockPath: [] });
    expect(store.getState().flowPaneExpansionOverrides).toEqual(new Set());
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    const emptyLeafId = "ts:pkg/src/b.ts#leaf::0";
    expect(store.getState().flowPaneRfNodes.find((node) => node.id === emptyLeafId)?.data)
      .toMatchObject({ expandable: false, childCount: 0 });
    store.getState().toggleFlowPaneExpand(emptyLeafId);
    expect(store.getState().flowPaneExpansionOverrides).toEqual(new Set());
    expect(store.getState().flowPaneLayoutStatus).toBe("ready");

    store.getState().selectFlowEntry(null);
    expect(store.getState().flowPaneExpansionOverrides).toEqual(new Set());
  });

  it("collapses and restores a static-pane edge without leaking state into the main Logic view", async () => {
    const store = freshStore();
    const firstSelection = { rootId: "ts:pkg/src/a.ts#run", blockPath: [] };
    store.setState({ collapsedLogicEdges: new Set(["main-logic-edge"]) });
    store.getState().selectFlowEntry(firstSelection);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));

    const collapsibleEdge = store.getState().flowPaneRfEdges.find((edge) => (
      edge.data?.collapsible === true && typeof edge.data.collapseKey === "string"
    ));
    expect(collapsibleEdge).toBeDefined();
    const collapseKey = collapsibleEdge!.data!.collapseKey!;

    store.getState().toggleFlowPaneEdgeCollapse(collapseKey);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));

    expect(store.getState().flowPaneCollapsedEdges).toEqual(new Set([collapseKey]));
    expect(store.getState().collapsedLogicEdges).toEqual(new Set(["main-logic-edge"]));
    expect(store.getState().flowPaneRfNodes).toContainEqual(expect.objectContaining({
      type: "fold",
      data: expect.objectContaining({ collapseKey }),
    }));
    expect(store.getState().flowPaneRfEdges.some((edge) => edge.data?.collapseKey === collapseKey)).toBe(false);

    // The same action restores from the synthetic fold node after the original edge is hidden.
    store.getState().toggleFlowPaneEdgeCollapse(collapseKey);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));

    expect(store.getState().flowPaneCollapsedEdges).toEqual(new Set());
    expect(store.getState().flowPaneRfNodes.some((node) => node.type === "fold")).toBe(false);
    expect(store.getState().flowPaneRfEdges.some((edge) => edge.data?.collapseKey === collapseKey)).toBe(true);
    expect(store.getState().collapsedLogicEdges).toEqual(new Set(["main-logic-edge"]));

    store.getState().toggleFlowPaneEdgeCollapse(collapseKey);
    await vi.waitFor(() => expect(store.getState().flowPaneLayoutStatus).toBe("ready"));
    expect(store.getState().flowPaneCollapsedEdges).toEqual(new Set([collapseKey]));

    store.getState().selectFlowEntry({ rootId: "ts:pkg/src/b.ts#leaf", blockPath: [] });
    expect(store.getState().flowPaneCollapsedEdges).toEqual(new Set());
    expect(store.getState().collapsedLogicEdges).toEqual(new Set(["main-logic-edge"]));
  });

  it("clears ghost inspection before relaying out a non-review flow reveal", () => {
    const store = freshStore();
    const inspectionAtRelayout: unknown[] = [];
    const moduleRelayout = vi.fn(async () => {
      inspectionAtRelayout.push(store.getState().moduleGhostInspection);
    });
    store.setState({
      moduleGhostInspection: {
        anchorIds: new Set(["ts:pkg/src/a.ts#run"]),
        visitedIds: new Set(["ts:pkg/src/b.ts#leaf"]),
      },
      moduleRelayout,
    });

    store.getState().selectFlowEntry({ rootId: "ts:pkg/src/a.ts#run", blockPath: [] });

    expect(store.getState().moduleGhostInspection).toBeNull();
    expect(moduleRelayout).toHaveBeenCalledOnce();
    expect(inspectionAtRelayout).toEqual([null]);
  });
});
