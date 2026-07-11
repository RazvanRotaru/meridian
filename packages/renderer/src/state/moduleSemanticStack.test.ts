import type { GraphArtifact, GraphNode } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore } from "./store";

function node(
  id: string,
  kind: string,
  parentId: string | null,
  displayName: string,
  tags?: string[],
): GraphNode {
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
const OTHER = "ts:packages/other";
const SRC = "ts:packages/app/src";
const FEATURE = "ts:packages/app/src/feature";
const SHARED = "ts:packages/app/src/shared";
const FEATURE_A = "ts:packages/app/src/feature/a.ts";
const FEATURE_B = "ts:packages/app/src/feature/b.ts";
const SHARED_FILE = "ts:packages/app/src/shared/shared.ts";
const OTHER_FILE = "ts:packages/other/index.ts";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-11T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(ROOT, "package", null, "packages"),
    node(APP, "package", ROOT, "app", ["npm-package"]),
    node(OTHER, "package", ROOT, "other", ["npm-package"]),
    node(SRC, "package", APP, "src"),
    node(FEATURE, "package", SRC, "feature"),
    node(SHARED, "package", SRC, "shared"),
    node(FEATURE_A, "module", FEATURE, "a.ts"),
    node(FEATURE_B, "module", FEATURE, "b.ts"),
    node(SHARED_FILE, "module", SHARED, "shared.ts"),
    node(OTHER_FILE, "module", OTHER, "index.ts"),
  ],
  edges: [],
};

describe("module semantic stack integration", () => {
  it("lays and exposes every valid ancestor without changing the current focus", async () => {
    const index = buildGraphIndex(ARTIFACT);
    const store = createBlueprintStore({
      artifact: ARTIFACT,
      index,
      provider: null,
      hasOverlay: false,
      sourceUrl: null,
      prsUrl: "/api/prs",
      prFilesUrl: "/api/prs/files",
      prReviewUrl: "/api/prs/review",
      prOneUrl: "/api/prs/one",
      prRelatedUrl: "/api/prs/related",
      prCommentsUrl: "/api/prs/comments",
      prChecksUrl: "/api/prs/checks",
    });
    store.setState({ viewMode: "modules", moduleFocus: FEATURE });

    await store.getState().moduleRelayout();

    const state = store.getState();
    expect(state.moduleFocus).toBe(FEATURE);
    expect(state.moduleEffectiveFocus).toBe(FEATURE);
    expect(state.moduleSemanticLayers).toEqual([
      { depth: 1, focus: SRC, effectiveFocus: SRC, anchorId: FEATURE, label: "feature" },
      { depth: 2, focus: ROOT, effectiveFocus: ROOT, anchorId: APP, label: "app" },
    ]);
    expect(new Set(state.moduleRfNodes.map((entry) => entry.id)).size).toBe(state.moduleRfNodes.length);
    expect(state.moduleRfNodes.find((entry) => entry.id === FEATURE_A)?.data.semanticDepth).toBe(0);
    expect(state.moduleRfNodes.find((entry) => entry.id === FEATURE)?.data).toMatchObject({
      semanticDepth: 1,
      semanticRole: "anchor",
    });
    expect(state.moduleRfNodes.find((entry) => entry.id === APP)?.data).toMatchObject({
      semanticDepth: 2,
      semanticRole: "anchor",
    });
    expect(state.moduleRfNodes.find((entry) => entry.id === OTHER)?.data).toMatchObject({
      semanticDepth: 2,
      semanticRole: "context",
    });
  });

  it("commits each parent from the mounted stack exactly once without relayout or depth reset", async () => {
    const index = buildGraphIndex(ARTIFACT);
    const store = createBlueprintStore({
      artifact: ARTIFACT,
      index,
      provider: null,
      hasOverlay: false,
      sourceUrl: null,
      prsUrl: "/api/prs",
      prFilesUrl: "/api/prs/files",
      prReviewUrl: "/api/prs/review",
      prOneUrl: "/api/prs/one",
      prRelatedUrl: "/api/prs/related",
      prCommentsUrl: "/api/prs/comments",
      prChecksUrl: "/api/prs/checks",
    });
    store.setState({
      viewMode: "modules",
      moduleFocus: FEATURE,
      moduleSelected: new Set([FEATURE_A]),
      moduleExpanded: new Set([FEATURE_A]),
      mapExtra: new Set([SHARED_FILE]),
    });
    await store.getState().moduleRelayout();

    const initial = store.getState();
    const parentNode = initial.moduleRfNodes.find((entry) => entry.id === FEATURE);
    const outerNode = initial.moduleRfNodes.find((entry) => entry.id === APP);
    const parentPosition = parentNode?.position;

    // Never promote stale mounted metadata while an explicit focus/expansion relayout is replacing
    // the scene; the ready graph will publish its own transition callback after it lands.
    store.setState({ moduleLayoutStatus: "laying-out" });
    store.getState().commitModuleSemanticParent(1);
    expect(store.getState().moduleFocus).toBe(FEATURE);
    store.setState({ moduleLayoutStatus: "ready" });

    // A stale/nonexistent threshold cannot mutate the mounted stack.
    expect(store.getState().commitModuleSemanticParent(3)).toBe(false);
    expect(store.getState().moduleFocus).toBe(FEATURE);
    expect(store.getState().moduleRfNodes).toBe(initial.moduleRfNodes);

    expect(store.getState().commitModuleSemanticParent(1)).toBe(true);
    const parent = store.getState();
    expect(parent.moduleFocus).toBe(SRC);
    expect(parent.moduleEffectiveFocus).toBe(SRC);
    expect(parent.moduleSemanticLayers).toEqual([
      { depth: 2, focus: ROOT, effectiveFocus: ROOT, anchorId: APP, label: "app" },
    ]);
    expect(parent.moduleRfNodes.every((entry) => Number(entry.data.semanticDepth) >= 1)).toBe(true);
    expect(parent.moduleRfEdges.every((entry) => Number(entry.data?.semanticDepth) >= 1)).toBe(true);
    expect(parent.moduleRfNodes.find((entry) => entry.id === FEATURE)).toBe(parentNode);
    expect(parent.moduleRfNodes.find((entry) => entry.id === FEATURE)?.position).toBe(parentPosition);
    expect(parent.moduleSelected.size).toBe(0);
    expect(parent.moduleExpanded.size).toBe(0);
    expect(parent.mapExtra.size).toBe(0);

    // Zooming back over the consumed threshold cannot reconstruct its discarded detail layer.
    const committedNodes = parent.moduleRfNodes;
    expect(store.getState().commitModuleSemanticParent(1)).toBe(false);
    expect(store.getState().moduleRfNodes).toBe(committedNodes);

    // The same in-place operation remains available for the next absolute depth.
    expect(store.getState().commitModuleSemanticParent(2)).toBe(true);
    const overview = store.getState();
    expect(overview.moduleFocus).toBe(ROOT);
    expect(overview.moduleEffectiveFocus).toBe(ROOT);
    expect(overview.moduleSemanticLayers).toEqual([]);
    expect(overview.moduleRfNodes.every((entry) => entry.data.semanticDepth === 2)).toBe(true);
    expect(overview.moduleRfNodes.find((entry) => entry.id === APP)).toBe(outerNode);
  });

  it("atomically commits the canonical depth reached by a coarse outward zoom", async () => {
    const index = buildGraphIndex(ARTIFACT);
    const store = createBlueprintStore({
      artifact: ARTIFACT,
      index,
      provider: null,
      hasOverlay: false,
      sourceUrl: null,
      prsUrl: "/api/prs",
      prFilesUrl: "/api/prs/files",
      prReviewUrl: "/api/prs/review",
      prOneUrl: "/api/prs/one",
      prRelatedUrl: "/api/prs/related",
      prCommentsUrl: "/api/prs/comments",
      prChecksUrl: "/api/prs/checks",
    });
    store.setState({ viewMode: "modules", moduleFocus: FEATURE });
    await store.getState().moduleRelayout();

    expect(store.getState().commitModuleSemanticParent(2)).toBe(true);
    const overview = store.getState();
    expect(overview.moduleFocus).toBe(ROOT);
    expect(overview.moduleEffectiveFocus).toBe(ROOT);
    expect(overview.moduleSemanticLayers).toEqual([]);
    expect(overview.moduleRfNodes.every((entry) => entry.data.semanticDepth === 2)).toBe(true);
  });
});
