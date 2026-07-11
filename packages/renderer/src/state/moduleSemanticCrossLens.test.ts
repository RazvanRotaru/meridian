import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { describe, expect, it, vi } from "vitest";
import { frameIdOf } from "../derive/serviceClusterEdges";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, type BlueprintStore } from "./store";

function node(id: string, kind: string, parentId: string | null, displayName: string, tags?: string[]): GraphNode {
  return {
    id,
    kind,
    parentId,
    displayName,
    qualifiedName: id,
    tags,
    location: { file: "fixture.ts", startLine: 1 },
  } as GraphNode;
}

const ROOT = "ts:packages";
const APP = "ts:packages/app";
const SRC = "ts:packages/app/src";
const UI = "ts:packages/app/src/ui";
const APP_FILE = "ts:packages/app/src/ui/App.tsx";
const APP_COMPONENT = `${APP_FILE}#App`;
const BUTTON_FILE = "ts:packages/app/src/ui/Button.tsx";
const BUTTON_COMPONENT = `${BUTTON_FILE}#Button`;
const ALPHA_FILE = "ts:packages/app/src/alpha.ts";
const ALPHA = `${ALPHA_FILE}#AlphaService`;
const ALPHA_RUN = `${ALPHA}.run`;
const BETA_FILE = "ts:packages/app/src/beta.ts";
const BETA = `${BETA_FILE}#BetaService`;
const BETA_RUN = `${BETA}.run`;
const GAMMA_FILE = "ts:packages/app/src/gamma.ts";
const GAMMA = `${GAMMA_FILE}#GammaService`;
const GAMMA_RUN = `${GAMMA}.run`;

const EDGES: GraphEdge[] = [
  { id: "render", source: APP_COMPONENT, target: BUTTON_COMPONENT, kind: "renders", resolution: "resolved" },
  { id: "import", source: APP_FILE, target: BUTTON_FILE, kind: "imports", resolution: "resolved" },
  { id: "alpha-beta", source: ALPHA_RUN, target: BETA_RUN, kind: "calls", resolution: "resolved" },
  { id: "beta-gamma", source: BETA_RUN, target: GAMMA_RUN, kind: "calls", resolution: "resolved" },
] as GraphEdge[];

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-11T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "semantic-cross-lens", root: ".", language: "typescript" },
  nodes: [
    node(ROOT, "package", null, "packages"),
    node(APP, "package", ROOT, "app", ["npm-package"]),
    node(SRC, "package", APP, "src"),
    node(UI, "package", SRC, "ui"),
    node(APP_FILE, "module", UI, "App.tsx"),
    node(APP_COMPONENT, "function", APP_FILE, "App"),
    node(BUTTON_FILE, "module", UI, "Button.tsx"),
    node(BUTTON_COMPONENT, "function", BUTTON_FILE, "Button"),
    node(ALPHA_FILE, "module", SRC, "alpha.ts"),
    node(ALPHA, "class", ALPHA_FILE, "AlphaService"),
    node(ALPHA_RUN, "method", ALPHA, "run"),
    node(BETA_FILE, "module", SRC, "beta.ts"),
    node(BETA, "class", BETA_FILE, "BetaService"),
    node(BETA_RUN, "method", BETA, "run"),
    node(GAMMA_FILE, "module", SRC, "gamma.ts"),
    node(GAMMA, "class", GAMMA_FILE, "GammaService"),
    node(GAMMA_RUN, "method", GAMMA, "run"),
  ],
  edges: EDGES,
};

function freshStore(): BlueprintStore {
  const index = buildGraphIndex(ARTIFACT);
  return createBlueprintStore({
    artifact: ARTIFACT,
    index,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "",
    prFilesUrl: "",
    prReviewUrl: "",
    prOneUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
  });
}

describe("semantic parents across module-family lenses", () => {
  it("commits a focused Service frame into its localized parent graph without relayout", async () => {
    const store = freshStore();
    const alphaFrame = frameIdOf(ALPHA);
    store.setState({ viewMode: "call", moduleFocus: alphaFrame, serviceScope: null });
    await store.getState().moduleRelayout();

    const focused = store.getState();
    expect(focused.moduleSemanticLayers[0]).toMatchObject({ depth: 1, focus: null, anchorId: alphaFrame });
    const parentAnchor = focused.moduleRfNodes.find(
      (entry) => entry.id === alphaFrame && entry.data.semanticDepth === 1,
    );
    expect(parentAnchor).toBeDefined();
    expect(
      focused.moduleRfNodes.some(
        (entry) => entry.id === frameIdOf(GAMMA) && entry.data.semanticDepth === 1,
      ),
    ).toBe(false);

    const relayout = vi.fn(async () => {});
    store.setState({ moduleRelayout: relayout });
    expect(store.getState().commitModuleSemanticParent(1)).toBe(true);

    const parent = store.getState();
    expect(relayout).not.toHaveBeenCalled();
    expect(parent.moduleLayoutStatus).toBe("ready");
    expect(parent.moduleFocus).toBeNull();
    expect(parent.moduleEffectiveFocus).toBeNull();
    expect(parent.moduleSemanticLayers).toEqual([]);
    expect(parent.moduleRfNodes.find((entry) => entry.id === alphaFrame)).toBe(parentAnchor);
    expect(parent.moduleRfNodes.every((entry) => Number(entry.data.semanticDepth) >= 1)).toBe(true);
    expect(new Set(parent.serviceScope?.leadIds)).toEqual(new Set([ALPHA, BETA]));
    expect(parent.serviceScope?.label).toBe("AlphaService (+1)");
  });

  it("commits a focused UI containment graph into its canonical parent", async () => {
    const store = freshStore();
    store.setState({ viewMode: "ui", moduleFocus: APP_FILE });
    await store.getState().moduleRelayout();

    const focused = store.getState();
    expect(focused.moduleSemanticLayers[0]).toMatchObject({ depth: 1, focus: UI, anchorId: APP_FILE });
    const parentAnchor = focused.moduleRfNodes.find(
      (entry) => entry.id === APP_FILE && entry.data.semanticDepth === 1,
    );
    expect(parentAnchor).toBeDefined();

    const relayout = vi.fn(async () => {});
    store.setState({ moduleRelayout: relayout });
    expect(store.getState().commitModuleSemanticParent(1)).toBe(true);

    const parent = store.getState();
    expect(relayout).not.toHaveBeenCalled();
    expect(parent.viewMode).toBe("ui");
    expect(parent.moduleFocus).toBe(UI);
    expect(parent.moduleEffectiveFocus).toBe(UI);
    expect(parent.moduleRfNodes.find((entry) => entry.id === APP_FILE)).toBe(parentAnchor);
    expect(parent.moduleRfNodes.every((entry) => Number(entry.data.semanticDepth) >= 1)).toBe(true);
  });

  it("clears the outgoing mounted scene synchronously when switching lenses", async () => {
    const store = freshStore();
    store.setState({ viewMode: "modules", moduleFocus: UI, moduleSelected: new Set([ALPHA]) });
    await store.getState().moduleRelayout();

    const outgoing = store.getState();
    expect(outgoing.moduleRfNodes.length).toBeGreaterThan(0);
    expect(outgoing.moduleRfEdges.length).toBeGreaterThan(0);
    expect(outgoing.moduleSemanticLayers.length).toBeGreaterThan(0);

    store.getState().setViewMode("call");
    const switching = store.getState();
    expect(switching.viewMode).toBe("call");
    expect(switching.moduleRfNodes).toEqual([]);
    expect(switching.moduleRfEdges).toEqual([]);
    expect(switching.moduleSemanticLayers).toEqual([]);
  });

  it("carries a Map selection into a localized Service scope", () => {
    const store = freshStore();
    store.setState({ viewMode: "modules", moduleSelected: new Set([ALPHA_RUN]) });

    store.getState().setViewMode("call");
    const state = store.getState();
    expect(state.viewMode).toBe("call");
    expect(state.moduleFocus).toBeNull();
    expect(state.moduleSelected).toEqual(new Set([ALPHA_RUN]));
    expect(state.moduleExpanded.has(frameIdOf(ALPHA))).toBe(true);
    expect(new Set(state.serviceScope?.leadIds)).toEqual(new Set([ALPHA, BETA]));
    expect(state.serviceScope?.label).toBe("AlphaService (+1)");
  });
});
