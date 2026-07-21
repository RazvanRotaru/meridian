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

  it("accounts for the review-only neighbourhood action in row and stacked placement", () => {
    expect(canvasActionPlacement(1349, "review-focus", null, 45)).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(1038, "review-focus", null, 45)).toEqual({
      position: "bottom-left",
      layout: "row",
      left: 327,
      bottom: 181,
    });
    expect(canvasActionPlacement(1037, "review-focus", null, 45)).toEqual({
      position: "bottom-left",
      layout: "stacked",
      left: 327,
      bottom: 181,
    });
  });

  it("moves a full row beside the control panel when centering would overlap it", () => {
    expect(canvasActionPlacement(797, "base")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(915, "extract")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(1243, "minimal")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(1303, "review-focus")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(935, "codebase")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
  });

  it("keeps the minimal actions in one row down to the exact side-lane boundary", () => {
    expect(canvasActionPlacement(933, "minimal")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(932, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
    expect(canvasActionPlacement(993, "review-focus")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(992, "review-focus")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
  });

  it("stacks whole groups after a review panel narrows the graph pane", () => {
    expect(canvasActionPlacement(542, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 126, bottom: 181 });
    expect(canvasActionPlacement(541, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 125, bottom: 181 });
    expect(canvasActionPlacement(520, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 104, bottom: 181 });
    expect(canvasActionPlacement(624, "codebase")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
    expect(canvasActionPlacement(625, "codebase")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(605, "extract")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(604, "extract")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
  });

  it("keeps the short stacked layout when the side lane disappears", () => {
    expect(canvasActionPlacement(497, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 81, bottom: 181 });
    expect(canvasActionPlacement(496, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 80, bottom: 181 });
    expect(canvasActionPlacement(400, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 16, bottom: 181 });
  });

  it("clamps a stacked bar to the canvas edge at a truly tiny width", () => {
    expect(canvasActionPlacement(150, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 16, bottom: 181 });
  });

  it("slides toward the bottom only when the graph itself becomes short", () => {
    expect(canvasActionPlacement(520, "minimal", 306)).toEqual({ position: "bottom-left", layout: "stacked", left: 104, bottom: 181 });
    expect(canvasActionPlacement(520, "minimal", 305)).toEqual({ position: "bottom-left", layout: "stacked", left: 104, bottom: 180 });
    expect(canvasActionPlacement(520, "minimal", 141)).toEqual({ position: "bottom-left", layout: "stacked", left: 104, bottom: 16 });
  });

  it("lifts the bar above chrome when horizontal or vertical overlap is unavoidable", () => {
    expect(panelAnchorStyle(canvasActionPlacement(330, "minimal", 600))).toMatchObject({ left: 16, bottom: 181, zIndex: 7 });
    expect(panelAnchorStyle(canvasActionPlacement(520, "minimal", 305))).toMatchObject({
      left: 104,
      bottom: 180,
      maxWidth: "calc(100% - 104px)",
      zIndex: 7,
    });
  });
});

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
