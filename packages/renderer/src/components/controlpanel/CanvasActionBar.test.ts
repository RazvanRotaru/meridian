import { createElement, type ComponentProps, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../../graph/graphIndex";
import { createBlueprintStore } from "../../state/store";
import { StoreProvider } from "../../state/StoreContext";
import { CanvasActionBar } from "./CanvasActionBar";
import { canvasActionPlacement, panelAnchorStyle } from "./canvasActionBarLayout";
import {
  SurfaceSelectionGraphProvider,
  type SurfaceSelectionGraph,
} from "../canvas/SurfaceSelectionGraphContext";

describe("canvasActionPlacement", () => {
  it("centers each single-row footprint at its exact clearance threshold", () => {
    expect(canvasActionPlacement(798, "base")).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(916, "extract")).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(1244, "minimal")).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(1304, "review-focus")).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(936, "codebase")).toEqual({ position: "bottom-center", layout: "row" });
  });

  it("accounts for the review-only neighbourhood, viewed-collapse, ghost-diff, and code-preview actions", () => {
    expect(canvasActionPlacement(1484, "review-focus", null, 180)).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(1173, "review-focus", null, 180)).toEqual({
      position: "bottom-left",
      layout: "row",
      left: 327,
      bottom: 16,
    });
    expect(canvasActionPlacement(1172, "review-focus", null, 180)).toEqual({
      position: "bottom-left",
      layout: "stacked",
      left: 327,
      bottom: 16,
    });
  });

  it("shifts a full review bar horizontally when it can share the bottom lane", () => {
    expect(canvasActionPlacement(1400, "review-focus", 700, 180, {
      bottomChromeLeft: 1100,
      shiftIntoBottomLane: true,
      canCompact: true,
    })).toEqual({
      position: "bottom-left",
      layout: "row",
      left: 254,
      bottom: 16,
      maxWidth: 830,
    });
    expect(canvasActionPlacement(1600, "review-focus", 700, 180, {
      bottomChromeLeft: 1000,
      shiftIntoBottomLane: true,
      canCompact: true,
    })).toEqual({
      position: "bottom-left",
      layout: "row",
      left: 154,
      bottom: 16,
      maxWidth: 830,
    });
  });

  it("compacts secondary actions and clamps the bar before bottom chrome instead of lifting it", () => {
    expect(canvasActionPlacement(1400, "review-focus", 700, 180, {
      bottomChromeLeft: 800,
      shiftIntoBottomLane: true,
      canCompact: true,
    })).toEqual({
      position: "bottom-left",
      layout: "row",
      left: 16,
      bottom: 16,
      maxWidth: 768,
      compact: true,
    });
    expect(canvasActionPlacement(1400, "review-focus", 700, 180, {
      bottomChromeLeft: 800,
      shiftIntoBottomLane: true,
    })).toEqual({
      position: "bottom-left",
      layout: "row",
      left: 327,
      bottom: 16,
      maxWidth: 457,
    });
    expect(canvasActionPlacement(720, "minimal", 500, 45, {
      bottomChromeLeft: 465,
      shiftIntoBottomLane: true,
      canCompact: true,
    })).toEqual({
      position: "bottom-left",
      layout: "stacked",
      left: 16,
      bottom: 16,
      maxWidth: 433,
      compact: true,
    });
    expect(canvasActionPlacement(720, "base", 500, 45, {
      bottomChromeLeft: 465,
      shiftIntoBottomLane: true,
    })).toEqual({
      position: "bottom-left",
      layout: "row",
      left: 260,
      bottom: 16,
      maxWidth: 189,
    });
  });

  it("keeps a 16px bottom inset for every width, mode, height, and chrome state", () => {
    const modes = ["base", "extract", "minimal", "review-focus", "codebase"] as const;
    const heights = [141, 403, 900];
    for (let width = 320; width <= 1800; width += 1) {
      for (const mode of modes) {
        for (const height of heights) {
          const placements = [
            canvasActionPlacement(width, mode, height, 180),
            canvasActionPlacement(width, mode, height, 180, { bottomChromeLeft: null }),
            canvasActionPlacement(width, mode, height, 180, {
              bottomChromeLeft: Math.max(96, width - 300),
              shiftIntoBottomLane: true,
              canCompact: true,
            }),
          ];
          for (const placement of placements) {
            expect(normalizedBottomInset(placement)).toBe(16);
          }
        }
      }
    }
  });

  it("bounds horizontal overflow without changing the vertical anchor", () => {
    expect(panelAnchorStyle(canvasActionPlacement(330, "minimal", 600))).toMatchObject({
      left: 16,
      bottom: 16,
      maxWidth: "calc(100% - 32px)",
      zIndex: 7,
    });
    expect(panelAnchorStyle(canvasActionPlacement(520, "minimal", 305, 0, {
      bottomChromeLeft: 300,
      canCompact: true,
    }))).toMatchObject({ bottom: 16, maxWidth: 268, zIndex: 7 });
  });
});

function normalizedBottomInset(placement: ReturnType<typeof canvasActionPlacement>): number | undefined {
  const style = panelAnchorStyle(placement);
  return placement.position === "bottom-center"
    ? style.marginBottom as number | undefined
    : style.bottom as number | undefined;
}

describe("CanvasActionBar Remove action", () => {
  it("is described and aria-disabled for canonical selections, then enabled for an added card", () => {
    const store = actionBarStore();
    store.setState({ moduleSelected: new Set([ACTION_METHOD]) });

    const disabledMarkup = renderActionBar(store);
    const disabledButton = removeButtonMarkup(disabledMarkup);
    expect(disabledButton).toContain('aria-disabled="true"');
    expect(describedText(disabledMarkup, disabledButton)).toBe("Only nodes added to this view can be removed");

    store.setState({ mapExtra: new Set([ACTION_FILE]) });
    const enabledMarkup = renderActionBar(store);
    const enabledButton = removeButtonMarkup(enabledMarkup);
    expect(enabledButton).not.toContain("aria-disabled");
    expect(describedText(enabledMarkup, enabledButton)).toBe(
      "Remove added nodes associated with the current selection from this view",
    );
  });

  it("is available for a selected promoted member in the minimal graph but not its read-only codebase view", () => {
    const store = actionBarStore();
    store.setState({
      minimalSeedIds: [ACTION_FILE],
      minimalMemberIds: [ACTION_FILE, PROMOTED_FILE],
      moduleSelected: new Set([PROMOTED_METHOD]),
    });

    const enabledMarkup = renderActionBar(store);
    const enabledButton = removeButtonMarkup(enabledMarkup);
    expect(enabledButton).not.toContain("aria-disabled");
    expect(describedText(enabledMarkup, enabledButton)).toBe(
      "Remove added nodes associated with the current selection from this view",
    );

    store.setState({ moduleSelected: new Set([ACTION_METHOD]) });
    const disabledMarkup = renderActionBar(store);
    const disabledButton = removeButtonMarkup(disabledMarkup);
    expect(disabledButton).toContain('aria-disabled="true"');
    expect(describedText(disabledMarkup, disabledButton)).toBe(
      "Select added nodes while keeping at least one member in the extracted graph",
    );

    expect(renderActionBar(store, { minimalView: "codebase" })).not.toContain(
      'aria-label="Remove added nodes in selection"',
    );
  });
});

describe("CanvasActionBar nested extraction", () => {
  it("withholds extraction while a synthetic run is in flight", () => {
    const store = actionBarStore();
    store.setState({
      minimalSeedIds: [ACTION_FILE],
      minimalMemberIds: [ACTION_FILE],
      minimalLayoutStatus: "ready",
      moduleSelected: new Set([ACTION_METHOD]),
      syntheticExecutionStatus: "running",
    });

    expect(renderActionBar(store)).not.toContain('aria-label="Extract selection (1)"');
    store.setState({ syntheticExecutionStatus: "ready" });
    expect(renderActionBar(store)).toContain('aria-label="Extract selection (1)"');
  });

  it("keeps Back in the same action slot from nested children through the root source exit", async () => {
    const store = actionBarStore();
    store.setState({
      minimalSeedIds: [ACTION_FILE],
      minimalMemberIds: [ACTION_FILE],
      minimalLayoutStatus: "ready",
      moduleSelected: new Set([ACTION_METHOD]),
    });

    const rootMarkup = renderActionBar(store);
    expect(rootMarkup).toContain('aria-label="Extract selection (1)"');
    expect(describedText(rootMarkup, actionButtonMarkup(rootMarkup, "Back to previous graph"))).toBe(
      "Return to the source graph",
    );
    const rootCodebaseMarkup = renderActionBar(store, { minimalView: "codebase" });
    expect(rootCodebaseMarkup).toContain('aria-label="Extract selection (1)"');
    expect(describedText(rootCodebaseMarkup, actionButtonMarkup(rootCodebaseMarkup, "Back to previous graph"))).toBe(
      "Return to the source graph",
    );

    store.getState().buildMinimalGraph();

    expect(store.getState().minimalGraphHistory).toHaveLength(1);
    expect(actionButtonMarkup(renderActionBar(store), "Back to previous graph")).toBeDefined();
    expect(actionButtonMarkup(renderActionBar(store, { minimalView: "codebase" }), "Back to previous graph")).toBeDefined();

    store.getState().backMinimalGraph();
    expect(store.getState().minimalGraphHistory).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.getState().minimalSeedIds).toEqual([ACTION_FILE]);
    expect(store.getState().minimalLayoutStatus).toBe("ready");
    expect(renderActionBar(store)).toContain('aria-label="Back to previous graph"');

    store.getState().backMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
    expect(renderActionBar(store)).not.toContain('aria-label="Back to previous graph"');
  });

  it("does not offer a review-container action that the current focus would reject", () => {
    const store = actionBarStore();
    store.setState({
      minimalSeedIds: [ACTION_FILE],
      minimalMemberIds: [ACTION_FILE],
      minimalLayoutStatus: "ready",
      moduleSelected: new Set(["ts:src"]),
      review: {
        context: {
          changedFiles: [{ path: "src/action.ts", status: "modified" }],
          baseRef: null,
          baseSha: null,
          headRef: null,
          reviewKey: "action-bar-review",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
      reviewFiles: [{
        path: "src/action.ts",
        status: "modified",
        moduleId: ACTION_FILE,
        isTest: false,
        units: [],
        fingerprint: "modified",
        blastRadius: 0,
        deletedImpact: null,
      }],
    });

    expect(renderActionBar(store)).toContain('aria-label="Open selected container as review subgraph"');
    expect(renderActionBar(store, { minimalView: "codebase" })).toContain(
      'aria-label="Open selected container as review subgraph"',
    );
    expect(renderActionBar(store, { minimalView: "codebase" })).not.toContain(
      'aria-label="Extract selection (1)"',
    );
    store.setState({ syntheticExecutionStatus: "running" });
    expect(renderActionBar(store)).not.toContain('aria-label="Open selected container as review subgraph"');
    store.setState({ syntheticExecutionStatus: "idle" });
    store.setState({
      reviewFocusedSubgraph: {
        rootId: "ts:src",
        label: "src",
        filePaths: ["src/action.ts"],
        moduleIds: [ACTION_FILE],
      },
    });
    expect(renderActionBar(store)).not.toContain('aria-label="Open selected container as review subgraph"');
  });
});

describe("CanvasActionBar empty review sentinel", () => {
  it("cannot reset or rearrange a seed-only review into visible members", () => {
    const store = actionBarStore();
    store.setState({ minimalSeedIds: ["ts:src"], minimalMemberIds: [] });

    const markup = renderActionBar(store);
    expect(actionButtonMarkup(markup, "Rearrange extracted graph")).toContain('aria-disabled="true"');
    expect(actionButtonMarkup(markup, "Reset extracted graph")).toContain('aria-disabled="true"');
  });
});

describe("CanvasActionBar viewed-node collapse", () => {
  it("appears only on an extracted review graph and reflects whether a viewed scope is open", () => {
    const store = actionBarStore();
    expect(renderActionBar(store)).not.toContain('aria-label="Collapse all viewed nodes"');

    store.setState({
      review: {
        context: {
          changedFiles: [{ path: "src/action.ts", status: "modified" }],
          baseRef: null,
          baseSha: null,
          headRef: null,
          reviewKey: "action-bar-collapse-viewed",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
      reviewFiles: [{
        path: "src/action.ts",
        status: "modified",
        moduleId: ACTION_FILE,
        isTest: false,
        units: [{
          nodeId: ACTION_METHOD,
          displayName: "run",
          kind: "method",
          startLine: 1,
          endLine: 1,
          depth: 0,
          isTest: false,
          fingerprint: "action-method",
        }],
        fingerprint: "action-file",
        blastRadius: 0,
        deletedImpact: null,
      }],
      minimalSeedIds: [ACTION_FILE],
      minimalMemberIds: [ACTION_FILE],
      minimalLayoutStatus: "ready",
      minimalRfNodes: [{
        id: ACTION_FILE,
        type: "file",
        position: { x: 0, y: 0 },
        data: { isContainer: true, isExpanded: false },
      }],
      reviewUnitTicks: {
        [ACTION_METHOD]: { at: "now", fingerprint: "action-method" },
      },
    });

    const disabledMarkup = renderActionBar(store);
    const disabledButton = actionButtonMarkup(disabledMarkup, "Collapse all viewed nodes");
    expect(disabledButton).toContain('aria-disabled="true"');
    expect(describedText(disabledMarkup, disabledButton)).toBe("No viewed nodes are currently expanded");

    store.setState({
      moduleExpanded: new Set([ACTION_FILE]),
      minimalRfNodes: [{
        id: ACTION_FILE,
        type: "file",
        position: { x: 0, y: 0 },
        data: { isContainer: true, isExpanded: true },
      }],
    });
    const enabledMarkup = renderActionBar(store);
    const enabledButton = actionButtonMarkup(enabledMarkup, "Collapse all viewed nodes");
    expect(enabledButton).not.toContain("aria-disabled");
    expect(describedText(enabledMarkup, enabledButton)).toBe(
      "Collapse every open container inside nodes already marked viewed",
    );
    expect(enabledMarkup.indexOf('aria-label="Collapse all viewed nodes"')).toBeGreaterThan(
      enabledMarkup.indexOf('aria-label="Collapse all"'),
    );
    expect(renderActionBar(store, { minimalView: "codebase" })).not.toContain(
      'aria-label="Collapse all viewed nodes"',
    );
  });
});

describe("CanvasActionBar selection expansion", () => {
  it("shows the action on every mode with the exact one-hop count and disables it at the frontier", () => {
    const store = actionBarStore();
    store.setState({
      review: {
        context: {
          changedFiles: [{ path: "src/action.ts", status: "modified" }],
          baseRef: null,
          baseSha: null,
          headRef: null,
          reviewKey: "action-bar-selection-expansion",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
      minimalSeedIds: [ACTION_METHOD],
      minimalMemberIds: [ACTION_FILE],
      minimalLayoutStatus: "ready",
      minimalRfNodes: [ACTION_METHOD, PROMOTED_METHOD].map((id) => ({
        id,
        type: "block",
        position: { x: 0, y: 0 },
        data: {},
      })),
      minimalRfEdges: [{ id: "action-promoted", source: ACTION_METHOD, target: PROMOTED_METHOD }],
      moduleSelected: new Set([ACTION_METHOD]),
    });

    const selectionGraph = {
      nodes: store.getState().minimalRfNodes,
      edges: store.getState().minimalRfEdges,
      ready: true,
    };
    const enabledMarkup = renderActionBar(store, {}, selectionGraph);
    const enabledButton = actionButtonMarkup(enabledMarkup, "Expand selection by one level");
    expect(enabledButton).not.toContain("aria-disabled");
    expect(describedText(enabledMarkup, enabledButton)).toBe("Add 1 visible one-hop neighbour to the selection");

    store.getState().expandModuleSelectionByOneHop(selectionGraph.nodes, selectionGraph.edges);
    const disabledMarkup = renderActionBar(store, {}, selectionGraph);
    const disabledButton = actionButtonMarkup(disabledMarkup, "Expand selection by one level");
    expect(disabledButton).toContain('aria-disabled="true"');
    expect(describedText(disabledMarkup, disabledButton)).toBe(
      "The selection already includes every visible one-hop neighbour",
    );

    store.setState({ review: null });
    expect(renderActionBar(store, {}, selectionGraph)).toContain('aria-label="Expand selection by one level"');
    expect(renderActionBar(store, { minimalView: "codebase" }, selectionGraph)).toContain(
      'aria-label="Expand selection by one level"',
    );
  });
});

describe("CanvasActionBar ghost visibility", () => {
  it("exposes the extracted graph's paint-only ghost toggle as a pressed control", () => {
    const store = actionBarStore();
    store.setState({ minimalSeedIds: [ACTION_FILE], minimalMemberIds: [ACTION_FILE] });

    const shownMarkup = renderActionBar(store, {
      ghostNodesVisible: true,
      hasGhostNodes: true,
      onToggleGhostNodes: () => undefined,
    });
    const shownButton = actionButtonMarkup(shownMarkup, "Show ghost nodes");
    expect(shownButton).toContain('aria-pressed="true"');
    expect(describedText(shownMarkup, shownButton)).toBe("Hide ghost nodes and their connections");

    const hiddenMarkup = renderActionBar(store, {
      ghostNodesVisible: false,
      hasGhostNodes: true,
      onToggleGhostNodes: () => undefined,
    });
    const hiddenButton = actionButtonMarkup(hiddenMarkup, "Show ghost nodes");
    expect(hiddenButton).toContain('aria-pressed="false"');
    expect(describedText(hiddenMarkup, hiddenButton)).toBe("Show ghost nodes and their connections");
  });
});

describe("CanvasActionBar PR ghost visibility", () => {
  it("surfaces a selective ghost projection on the review graph only", () => {
    const store = actionBarStore();
    expect(renderActionBar(store)).not.toContain('aria-label="Filter unrelated ghost nodes"');

    store.setState({
      review: {
        context: {
          changedFiles: [{ path: "src/action.ts", status: "modified" }],
          baseRef: null,
          baseSha: null,
          headRef: null,
          reviewKey: "action-bar-diff-only",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
    });
    expect(renderActionBar(store)).not.toContain('aria-label="Filter unrelated ghost nodes"');

    store.setState({
      minimalSeedIds: [ACTION_FILE],
      minimalMemberIds: [ACTION_FILE],
    });

    const fullContextMarkup = renderActionBar(store, {
      hasGhostNodes: true,
      reviewGhostDiffOnly: false,
      onToggleReviewGhostDiffOnly: () => undefined,
    });
    const fullContextButton = actionButtonMarkup(fullContextMarkup, "Filter unrelated ghost nodes");
    expect(fullContextButton).toContain('aria-pressed="false"');
    expect(describedText(fullContextMarkup, fullContextButton)).toBe(
      "Hide ghost nodes not modified by this PR unless they are part of the minimal graph",
    );
    expect(fullContextMarkup.match(/aria-label="Filter unrelated ghost nodes"/g)).toHaveLength(1);

    const diffOnlyMarkup = renderActionBar(store, {
      hasGhostNodes: true,
      reviewGhostDiffOnly: true,
      onToggleReviewGhostDiffOnly: () => undefined,
    });
    const diffOnlyButton = actionButtonMarkup(diffOnlyMarkup, "Filter unrelated ghost nodes");
    expect(diffOnlyButton).toContain('aria-pressed="true"');
    expect(describedText(diffOnlyMarkup, diffOnlyButton)).toBe("Show all ghost nodes");
    expect(diffOnlyMarkup.match(/aria-label="Filter unrelated ghost nodes"/g)).toHaveLength(1);
    expect(renderActionBar(store, {
      minimalView: "codebase",
      hasGhostNodes: true,
      onToggleReviewGhostDiffOnly: () => undefined,
    })).not.toContain(
      'aria-label="Filter unrelated ghost nodes"',
    );
  });

  it("disables the selective filter when the extracted graph has no ghosts", () => {
    const store = actionBarStore();
    store.setState({
      minimalSeedIds: [ACTION_FILE],
      minimalMemberIds: [ACTION_FILE],
      review: {
        context: {
          changedFiles: [{ path: "src/action.ts", status: "modified" }],
          baseRef: null,
          baseSha: null,
          headRef: null,
          reviewKey: "action-bar-no-ghosts",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
    });

    const markup = renderActionBar(store, {
      hasGhostNodes: false,
      onToggleReviewGhostDiffOnly: () => undefined,
    });
    const button = actionButtonMarkup(markup, "Filter unrelated ghost nodes");
    expect(button).toContain('aria-disabled="true"');
    expect(describedText(markup, button)).toBe("No ghost nodes in this extracted graph");
  });
});

describe("CanvasActionBar code-preview visibility", () => {
  it("places one accessible enable/disable action in each review surface's right-side group", () => {
    const store = actionBarStore();
    expect(renderActionBar(store)).not.toContain('aria-label="Code previews"');

    store.setState({
      review: {
        context: {
          changedFiles: [{ path: "src/action.ts", status: "modified" }],
          baseRef: null,
          baseSha: null,
          headRef: null,
          reviewKey: "action-bar-code-preview",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
    });
    expect(renderActionBar(store)).not.toContain('aria-label="Code previews"');

    store.setState({
      minimalSeedIds: [ACTION_FILE],
      minimalMemberIds: [ACTION_FILE],
    });

    const graphMarkup = renderActionBar(store);
    const enabledButton = actionButtonMarkup(graphMarkup, "Code previews");
    expect(enabledButton).toContain('aria-pressed="true"');
    expect(describedText(graphMarkup, enabledButton)).toBe(
      "Disable Control/Command-hover code previews; use the node header View source button instead",
    );
    expect(graphMarkup.match(/aria-label="Code previews"/g)).toHaveLength(1);
    expect(graphMarkup.indexOf('aria-label="Code previews"')).toBeGreaterThan(
      graphMarkup.indexOf('aria-label="Extracted graph actions"'),
    );

    store.setState({ reviewCodePreviewEnabled: false });
    const codebaseMarkup = renderActionBar(store, { minimalView: "codebase" });
    const disabledButton = actionButtonMarkup(codebaseMarkup, "Code previews");
    expect(disabledButton).toContain('aria-pressed="false"');
    expect(describedText(codebaseMarkup, disabledButton)).toBe(
      "Enable code previews while holding Control or Command over a node",
    );
    expect(codebaseMarkup.match(/aria-label="Code previews"/g)).toHaveLength(1);
    expect(codebaseMarkup.indexOf('aria-label="Code previews"')).toBeGreaterThan(
      codebaseMarkup.indexOf('aria-label="Codebase view actions"'),
    );
  });
});

describe("CanvasActionBar highway visibility", () => {
  it("exposes the extracted graph's highway toggle as a pressed control", () => {
    const store = actionBarStore();
    store.setState({ minimalSeedIds: [ACTION_FILE], minimalMemberIds: [ACTION_FILE] });

    const shownMarkup = renderActionBar(store);
    const shownButton = actionButtonMarkup(shownMarkup, "Highways");
    expect(shownButton).toContain('aria-pressed="true"');
    expect(describedText(shownMarkup, shownButton)).toBe("Disable highways and draw node links individually");

    store.setState({ showHighways: false });
    const hiddenMarkup = renderActionBar(store);
    const hiddenButton = actionButtonMarkup(hiddenMarkup, "Highways");
    expect(hiddenButton).toContain('aria-pressed="false"');
    expect(describedText(hiddenMarkup, hiddenButton)).toBe("Enable highways for dense edge traffic");
  });

  it("uses the disabled review default without changing the ordinary Map preference", () => {
    const store = actionBarStore();
    store.setState({
      minimalSeedIds: [ACTION_FILE],
      minimalMemberIds: [ACTION_FILE],
      review: {
        context: {
          changedFiles: [{ path: "src/action.ts", status: "modified" }],
          baseRef: null,
          baseSha: null,
          headRef: null,
          reviewKey: "action-bar-highways",
          warnings: [],
        },
        rows: [],
        flows: {},
      },
    });

    const hiddenMarkup = renderActionBar(store);
    const hiddenButton = actionButtonMarkup(hiddenMarkup, "Highways");
    expect(hiddenButton).toContain('aria-pressed="false"');
    expect(store.getState().showHighways).toBe(true);
    expect(store.getState().reviewShowHighways).toBe(false);

    store.getState().toggleHighways();

    const shownMarkup = renderActionBar(store);
    const shownButton = actionButtonMarkup(shownMarkup, "Highways");
    expect(shownButton).toContain('aria-pressed="true"');
    expect(store.getState().showHighways).toBe(true);
    expect(store.getState().reviewShowHighways).toBe(true);
  });

  it("stays out of base, extraction-entry, and codebase-context action modes", () => {
    const store = actionBarStore();
    expect(renderActionBar(store)).not.toContain('aria-label="Highways"');

    store.setState({ moduleSelected: new Set([ACTION_METHOD]) });
    expect(renderActionBar(store)).not.toContain('aria-label="Highways"');

    store.setState({ minimalSeedIds: [ACTION_FILE], minimalMemberIds: [ACTION_FILE] });
    expect(renderActionBar(store, { minimalView: "codebase" })).not.toContain('aria-label="Highways"');
  });
});

describe("CanvasActionBar edge filters", () => {
  it("exposes the extracted graph's canonical edge filters as a dialog disclosure", () => {
    const store = actionBarStore();
    store.setState({ minimalSeedIds: [ACTION_FILE], minimalMemberIds: [ACTION_FILE] });

    const markup = renderActionBar(store, { relationKinds: ["calls", "imports"] });
    const button = actionButtonMarkup(markup, "Filter edge types");
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).toMatch(/aria-controls="[^"]+"/);
    expect(button).not.toContain("aria-disabled");
    expect(describedText(markup, button)).toBe("Choose which edge types are shown");
  });

  it("explains when the extracted graph has no filterable edge kinds", () => {
    const store = actionBarStore();
    store.setState({ minimalSeedIds: [ACTION_FILE], minimalMemberIds: [ACTION_FILE] });

    const markup = renderActionBar(store, { relationKinds: [] });
    const button = actionButtonMarkup(markup, "Filter edge types");
    expect(button).toContain('aria-disabled="true"');
    expect(describedText(markup, button)).toBe("No filterable edge types in this extracted graph");
  });
});

const ACTION_FILE = "ts:src/action.ts";
const ACTION_METHOD = `${ACTION_FILE}#Action.run`;
const PROMOTED_FILE = "ts:src/promoted.ts";
const PROMOTED_METHOD = `${PROMOTED_FILE}#Promoted.run`;

function actionNode(id: string, kind: string, parentId?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file: "src/action.ts", startLine: 1 },
  };
}

function actionBarStore() {
  const artifact: GraphArtifact = {
    schemaVersion: "1.0.0",
    generatedAt: "2026-07-12T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: [
      actionNode("ts:src", "package"),
      actionNode(ACTION_FILE, "module", "ts:src"),
      actionNode(`${ACTION_FILE}#Action`, "class", ACTION_FILE),
      actionNode(ACTION_METHOD, "method", `${ACTION_FILE}#Action`),
      actionNode(PROMOTED_FILE, "module", "ts:src"),
      actionNode(`${PROMOTED_FILE}#Promoted`, "class", PROMOTED_FILE),
      actionNode(PROMOTED_METHOD, "method", `${PROMOTED_FILE}#Promoted`),
    ],
    edges: [],
  };
  return createBlueprintStore({
    artifact,
    index: buildGraphIndex(artifact),
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

function renderActionBar(
  store: ReturnType<typeof actionBarStore>,
  props: ComponentProps<typeof CanvasActionBar> = {},
  selectionGraph: SurfaceSelectionGraph = { nodes: [], edges: [], ready: true },
): string {
  // Zustand's server snapshot is normally the store's boot state. For this static component test,
  // make the explicitly prepared current state the hydration snapshot for the duration of render.
  const getInitialState = store.getInitialState;
  store.getInitialState = store.getState;
  try {
    return renderToStaticMarkup(createElement(
      StoreProvider,
      {
        store,
        children: createElement(
          ReactFlowProvider,
          null,
          createElement(
            SurfaceSelectionGraphProvider,
            {
              value: selectionGraph,
              children: createElement(
                CanvasActionBar as FunctionComponent<ComponentProps<typeof CanvasActionBar>>,
                { ...props, key: null },
              ),
            },
          ),
        ),
      },
    ));
  } finally {
    store.getInitialState = getInitialState;
  }
}

function removeButtonMarkup(markup: string): string {
  return actionButtonMarkup(markup, "Remove added nodes in selection");
}

function actionButtonMarkup(markup: string, label: string): string {
  const button = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
  expect(button).toBeDefined();
  return button!;
}

function describedText(markup: string, button: string): string {
  const id = button.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(id).toBeDefined();
  const descriptionStart = markup.indexOf(`id="${id}"`);
  expect(descriptionStart).toBeGreaterThanOrEqual(0);
  const descriptionEnd = markup.indexOf("</span>", descriptionStart);
  expect(descriptionEnd).toBeGreaterThan(descriptionStart);
  const description = markup.slice(descriptionStart, descriptionEnd);
  return description.slice(description.indexOf(">") + 1);
}
