import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, type BlueprintStore } from "./store";

function node(id: string, kind: string, parentId?: string, displayName?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: displayName ?? id,
    parentId: parentId ?? null,
    location: { file: "f.ts", startLine: 1 },
  };
}

const FILE_ID = "ts:pkg/src/svc.ts";
const UNIT_ID = `${FILE_ID}#OrderService`;
const METHOD_ID = `${UNIT_ID}.place`;
const HELPER_ID = `${FILE_ID}#helper`;

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-08T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node("ts:pkg", "package", undefined, "pkg"),
    node("ts:pkg/src", "package", "ts:pkg", "src"),
    node(FILE_ID, "module", "ts:pkg/src", "svc.ts"),
    node(UNIT_ID, "class", FILE_ID, "OrderService"),
    node(METHOD_ID, "method", UNIT_ID, "place"),
    node(HELPER_ID, "function", FILE_ID, "helper"),
  ],
  edges: [],
  extensions: {
    logicFlow: {
      [METHOD_ID]: [{ kind: "call", label: "charge", target: null, resolution: "unresolved" }],
      [HELPER_ID]: [{ kind: "call", label: "audit", target: null, resolution: "unresolved" }],
    },
  },
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
    prOneUrl: "",
    prFilesUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
}

describe("expandAll / collapseAll — Map surface", () => {
  it("expandAll scoped to a selected file opens that file's child cards one level", () => {
    const store = freshStore();
    store.setState({
      viewMode: "modules",
      moduleFocus: "ts:pkg",
      moduleExpanded: new Set([FILE_ID]),
      moduleSelected: new Set([FILE_ID]),
    });
    store.getState().expandAll();
    expect(store.getState().moduleExpanded).toEqual(new Set([FILE_ID, UNIT_ID, HELPER_ID]));
  });

  it("collapseAll scoped to a selected file fully collapses that file's subtree", () => {
    const store = freshStore();
    store.setState({
      viewMode: "modules",
      moduleFocus: "ts:pkg",
      moduleExpanded: new Set([FILE_ID, UNIT_ID, HELPER_ID]),
      moduleSelected: new Set([FILE_ID]),
    });
    store.getState().collapseAll();
    // Every open container within the file (the file, its unit, its helper) closes in one click.
    expect(store.getState().moduleExpanded).toEqual(new Set());
  });

  it("expandAll with no selection opens the current level (root container)", () => {
    const store = freshStore();
    store.setState({ viewMode: "modules", moduleFocus: "ts:pkg", moduleExpanded: new Set(), moduleSelected: new Set() });
    store.getState().expandAll();
    // The frontier at focus ts:pkg is the svc.ts file card; opening the level reveals it.
    expect(store.getState().moduleExpanded.has(FILE_ID)).toBe(true);
  });
});

describe("expandAll / collapseAll — UI lens (the shared module surface since phase C)", () => {
  it("expandAll from a clean graph opens the root package one level", () => {
    const store = freshStore();
    store.setState({ viewMode: "ui", moduleFocus: null, moduleExpanded: new Set(), moduleSelected: new Set() });
    store.getState().expandAll();
    expect(store.getState().moduleExpanded.has("ts:pkg")).toBe(true);
  });

  it("collapseAll fully collapses every open container", () => {
    const store = freshStore();
    store.setState({ viewMode: "ui", moduleFocus: null, moduleExpanded: new Set(["ts:pkg", "ts:pkg/src"]), moduleSelected: new Set() });
    store.getState().collapseAll();
    expect(store.getState().moduleExpanded).toEqual(new Set());
  });
});

describe("expandAll / collapseAll — Logic-flow graph", () => {
  it("expandAll toggles every collapsed expandable node open", () => {
    const store = freshStore();
    store.setState({
      viewMode: "logic",
      logicRfNodes: [
        { id: "call-1", type: "block", position: { x: 0, y: 0 }, data: { expandable: true, isExpanded: false, isContainer: false } },
      ] as never,
      expandedLogic: new Set(),
    });
    store.getState().expandAll();
    expect(store.getState().expandedLogic).toEqual(new Set(["call-1"]));
  });

  it("collapseAll toggles an expanded node closed", () => {
    const store = freshStore();
    store.setState({
      viewMode: "logic",
      logicRfNodes: [
        { id: "call-1", type: "block", position: { x: 0, y: 0 }, data: { expandable: true, isExpanded: true, isContainer: true } },
      ] as never,
      expandedLogic: new Set(),
    });
    store.getState().collapseAll();
    expect(store.getState().expandedLogic).toEqual(new Set(["call-1"]));
  });

  it("collapseAll closes a whole open chain, including a default-expanded loop nested in an override-opened call", () => {
    // `call-1` (default-collapsed) was opened via an override in expandedLogic; it reveals `loop-1`
    // (default-expanded, open WITHOUT being in the set). A single collapse must force BOTH closed —
    // the multi-level regression: closing only the deepest left the call open with a stale override.
    const store = freshStore();
    store.setState({
      viewMode: "logic",
      logicRfNodes: [
        { id: "call-1", type: "block", position: { x: 0, y: 0 }, data: { expandable: true, isExpanded: true, isContainer: true } },
        { id: "loop-1", type: "loop", parentId: "call-1", position: { x: 0, y: 0 }, data: { expandable: true, isExpanded: true, isContainer: true } },
      ] as never,
      expandedLogic: new Set(["call-1"]),
    });
    store.getState().collapseAll();
    // call-1: override removed → default-collapsed → closed. loop-1: added as an override →
    // default-expanded flipped → closed. Both are now collapsed.
    expect(store.getState().expandedLogic).toEqual(new Set(["loop-1"]));
  });
});
