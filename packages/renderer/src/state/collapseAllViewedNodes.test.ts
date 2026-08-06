import type { GraphArtifact, GraphNode } from "@meridian/core";
import type { Node as RfNode } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import { collapsibleViewedNodeCount, createBlueprintStore } from "./store";

const ROOT = "ts:src";
const DONE_FILE = "ts:src/done.ts";
const DONE_CLASS = `${DONE_FILE}#Done`;
const DONE_METHOD = `${DONE_CLASS}.run`;
const DONE_STEP = `step:${DONE_METHOD}:0`;
const TODO_FILE = "ts:src/todo.ts";
const TODO_METHOD = `${TODO_FILE}#todo`;
const STALE_FILE = "ts:src/stale.ts";
const STALE_METHOD = `${STALE_FILE}#stale`;
const HIDDEN_EXPANSION = "ts:covered-map/hidden.ts";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-08-05T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(ROOT, "package"),
    node(DONE_FILE, "module", ROOT),
    node(DONE_CLASS, "class", DONE_FILE),
    node(DONE_METHOD, "method", DONE_CLASS),
    node(TODO_FILE, "module", ROOT),
    node(TODO_METHOD, "function", TODO_FILE),
    node(STALE_FILE, "module", ROOT),
    node(STALE_METHOD, "function", STALE_FILE),
  ],
  edges: [],
};

describe("collapseAllViewedNodes", () => {
  it("fully closes done scopes while preserving todo, stale, hidden, selection, and progress state", () => {
    const store = reviewStore();
    const relayout = vi.fn(async () => undefined);
    const expanded = new Set([
      DONE_FILE,
      DONE_CLASS,
      DONE_METHOD,
      DONE_STEP,
      TODO_FILE,
      STALE_FILE,
      HIDDEN_EXPANSION,
    ]);
    const selection = new Set([TODO_FILE]);
    store.setState({
      minimalRelayout: relayout,
      moduleExpanded: expanded,
      moduleSelected: selection,
      minimalRfNodes: [
        rfNode(DONE_FILE, null, { isContainer: true }),
        rfNode(DONE_CLASS, DONE_FILE, { isContainer: true }),
        rfNode(DONE_METHOD, DONE_CLASS, { expandable: true }),
        rfNode(DONE_STEP, DONE_METHOD, { isContainer: true }),
        rfNode(TODO_FILE, null, { isContainer: true }),
        rfNode(STALE_FILE, null, { isContainer: true }),
      ],
    });
    const progressBefore = {
      unitTicks: store.getState().reviewUnitTicks,
      fileTicks: store.getState().reviewFileTicks,
      githubStates: store.getState().reviewFileViewedStates,
    };

    expect(collapsibleViewedNodeCount(store.getState())).toBe(4);
    store.getState().collapseAllViewedNodes();

    expect(store.getState().moduleExpanded).toEqual(new Set([TODO_FILE, STALE_FILE, HIDDEN_EXPANSION]));
    expect(store.getState().moduleSelected).toBe(selection);
    expect(store.getState().reviewUnitTicks).toBe(progressBefore.unitTicks);
    expect(store.getState().reviewFileTicks).toBe(progressBefore.fileTicks);
    expect(store.getState().reviewFileViewedStates).toBe(progressBefore.githubStates);
    expect(relayout).toHaveBeenCalledOnce();
    expect(relayout).toHaveBeenCalledWith({ label: "Collapsing viewed nodes…" });
  });

  it("is a no-op when no done scope is open or the codebase presentation owns the canvas", () => {
    const store = reviewStore();
    const relayout = vi.fn(async () => undefined);
    const expanded = new Set([TODO_FILE, HIDDEN_EXPANSION]);
    store.setState({
      minimalRelayout: relayout,
      moduleExpanded: expanded,
      minimalRfNodes: [rfNode(TODO_FILE, null, { isContainer: true })],
    });

    expect(collapsibleViewedNodeCount(store.getState())).toBe(0);
    store.getState().collapseAllViewedNodes();
    expect(store.getState().moduleExpanded).toBe(expanded);
    expect(relayout).not.toHaveBeenCalled();

    store.setState({
      minimalView: "codebase",
      moduleExpanded: new Set([DONE_FILE]),
      minimalRfNodes: [rfNode(DONE_FILE, null, { isContainer: true })],
    });
    expect(collapsibleViewedNodeCount(store.getState())).toBe(0);
    store.getState().collapseAllViewedNodes();
    expect(store.getState().moduleExpanded).toEqual(new Set([DONE_FILE]));
    expect(relayout).not.toHaveBeenCalled();
  });

  it("collapses a review rollup only after every represented file is done", () => {
    const store = reviewStore();
    const relayout = vi.fn(async () => undefined);
    store.setState({
      minimalRelayout: relayout,
      minimalRollups: { [ROOT]: [DONE_FILE, TODO_FILE] },
      moduleExpanded: new Set([ROOT]),
      minimalRfNodes: [rfNode(ROOT, null, { isContainer: true })],
    });

    expect(collapsibleViewedNodeCount(store.getState())).toBe(0);
    store.setState({
      reviewUnitTicks: {
        ...store.getState().reviewUnitTicks,
        [TODO_METHOD]: { at: "now", fingerprint: "todo-method" },
      },
    });
    expect(collapsibleViewedNodeCount(store.getState())).toBe(1);

    store.getState().collapseAllViewedNodes();
    expect(store.getState().moduleExpanded).toEqual(new Set());
    expect(relayout).toHaveBeenCalledOnce();
  });
});

function reviewStore() {
  const index = buildGraphIndex(ARTIFACT);
  const store = createBlueprintStore({
    artifact: ARTIFACT,
    index,
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "",
    prOneUrl: "",
    prFilesUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
  store.setState({
    review: {
      context: {
        changedFiles: [],
        baseRef: null,
        baseSha: null,
        headRef: null,
        reviewKey: "collapse-all-viewed",
        warnings: [],
      },
      rows: [],
      flows: {},
    },
    reviewFiles: [
      reviewFile("src/done.ts", DONE_FILE, DONE_METHOD, "done-method"),
      reviewFile("src/todo.ts", TODO_FILE, TODO_METHOD, "todo-method"),
      reviewFile("src/stale.ts", STALE_FILE, STALE_METHOD, "stale-method"),
    ],
    reviewUnitTicks: {
      [DONE_METHOD]: { at: "now", fingerprint: "done-method" },
      [STALE_METHOD]: { at: "now", fingerprint: "older-stale-method" },
    },
    minimalSeedIds: [DONE_FILE, TODO_FILE, STALE_FILE],
    minimalMemberIds: [DONE_FILE, TODO_FILE, STALE_FILE],
    minimalLayoutStatus: "ready",
  });
  return store;
}

function node(id: string, kind: string, parentId?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId: parentId ?? null,
    location: { file: id, startLine: 1 },
  };
}

function reviewFile(path: string, moduleId: string, nodeId: string, fingerprint: string) {
  return {
    path,
    status: "modified" as const,
    moduleId,
    isTest: false,
    units: [{
      nodeId,
      displayName: nodeId,
      kind: "function",
      startLine: 1,
      endLine: 2,
      depth: 0,
      isTest: false,
      fingerprint,
    }],
    fingerprint: `${fingerprint}-file`,
    blastRadius: 0,
    deletedImpact: null,
  };
}

function rfNode(
  id: string,
  parentId: string | null,
  data: { isContainer?: boolean; expandable?: boolean },
): RfNode {
  return {
    id,
    type: "block",
    ...(parentId === null ? {} : { parentId }),
    position: { x: 0, y: 0 },
    data,
  };
}
