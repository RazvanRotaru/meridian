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

describe("canvasActionPlacement", () => {
  it("centers each single-row footprint at its exact clearance threshold", () => {
    expect(canvasActionPlacement(798, "base")).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(916, "extract")).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(1043, "minimal")).toEqual({ position: "bottom-center", layout: "row" });
    expect(canvasActionPlacement(852, "codebase")).toEqual({ position: "bottom-center", layout: "row" });
  });

  it("moves a full row beside the control panel when centering would overlap it", () => {
    expect(canvasActionPlacement(797, "base")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(915, "extract")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(1042, "minimal")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(851, "codebase")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
  });

  it("keeps the minimal actions in one row down to the exact side-lane boundary", () => {
    expect(canvasActionPlacement(732, "minimal")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(731, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
  });

  it("stacks whole groups after a review panel narrows the graph pane", () => {
    expect(canvasActionPlacement(542, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
    expect(canvasActionPlacement(541, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 326, bottom: 181 });
    expect(canvasActionPlacement(520, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 311, bottom: 181 });
    expect(canvasActionPlacement(540, "codebase")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
    expect(canvasActionPlacement(541, "codebase")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(605, "extract")).toEqual({ position: "bottom-left", layout: "row", left: 327, bottom: 181 });
    expect(canvasActionPlacement(604, "extract")).toEqual({ position: "bottom-left", layout: "stacked", left: 327, bottom: 181 });
  });

  it("keeps the short stacked layout when the side lane disappears", () => {
    expect(canvasActionPlacement(497, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 282, bottom: 181 });
    expect(canvasActionPlacement(496, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 281, bottom: 181 });
    expect(canvasActionPlacement(400, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 185, bottom: 181 });
  });

  it("clamps a stacked bar to the canvas edge at a truly tiny width", () => {
    expect(canvasActionPlacement(150, "minimal")).toEqual({ position: "bottom-left", layout: "stacked", left: 16, bottom: 181 });
  });

  it("slides toward the bottom only when the graph itself becomes short", () => {
    expect(canvasActionPlacement(520, "minimal", 306)).toEqual({ position: "bottom-left", layout: "stacked", left: 311, bottom: 181 });
    expect(canvasActionPlacement(520, "minimal", 305)).toEqual({ position: "bottom-left", layout: "stacked", left: 311, bottom: 180 });
    expect(canvasActionPlacement(520, "minimal", 141)).toEqual({ position: "bottom-left", layout: "stacked", left: 311, bottom: 16 });
  });

  it("lifts the bar above chrome when horizontal or vertical overlap is unavoidable", () => {
    expect(panelAnchorStyle(canvasActionPlacement(330, "minimal", 600))).toMatchObject({ left: 115, bottom: 181, zIndex: 7 });
    expect(panelAnchorStyle(canvasActionPlacement(520, "minimal", 305))).toMatchObject({
      left: 311,
      bottom: 180,
      maxWidth: "calc(100% - 311px)",
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

describe("CanvasActionBar empty review sentinel", () => {
  it("cannot reset or rearrange a seed-only review into visible members", () => {
    const store = actionBarStore();
    store.setState({ minimalSeedIds: ["ts:src"], minimalMemberIds: [] });

    const markup = renderActionBar(store);
    expect(actionButtonMarkup(markup, "Rearrange extracted graph")).toContain('aria-disabled="true"');
    expect(actionButtonMarkup(markup, "Reset extracted graph")).toContain('aria-disabled="true"');
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
            CanvasActionBar as FunctionComponent<ComponentProps<typeof CanvasActionBar>>,
            { ...props, key: null },
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
