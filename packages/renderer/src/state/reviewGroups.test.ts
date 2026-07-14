/**
 * The change-groups review slice: a PR that is really N independent changes partitions into N
 * groups at review time, and selecting a group ISOLATES the minimal overlay to its modules — a pure
 * seed/member swap through the existing machinery, never a dim. Fixture: a.ts → b.ts are one
 * connected change, c.ts an unrelated one; all three files arrive in a single PR.
 */

import { describe, expect, it, vi } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, type StoreDependencies } from "./store";
import type { PrSummary } from "./prTypes";

function node(id: string, kind: string, file: string, parentId?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine: 1, endLine: 30 },
  };
}

function pr(number: number): PrSummary {
  return {
    number,
    title: `PR ${number}`,
    body: null,
    author: "octo",
    headRef: "feature",
    headSha: null,
    baseRef: "main",
    updatedAt: "2026-07-10T00:00:00.000Z",
    draft: false,
    state: "open",
    url: `https://github.com/o/r/pull/${number}`,
  };
}

const PACKAGE_ID = "ts:src";
const FS_ID = "ts:src/fs";
const FILE_A = "ts:src/a.ts";
const FILE_B = "ts:src/b.ts";
const FILE_C = "ts:src/c.ts";
const FN_A = `${FILE_A}#fnA`;
const FN_B = `${FILE_B}#fnB`;
const FN_C = `${FILE_C}#fnC`;
const DELETED_CLASS_C = `${FILE_C}#LegacyService`;
const DELETED_METHOD_C = `${DELETED_CLASS_C}.removed`;

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-10T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(PACKAGE_ID, "package", "src"),
    node(FS_ID, "package", "src/fs", PACKAGE_ID),
    node(FILE_A, "module", "src/a.ts", FS_ID),
    node(FILE_B, "module", "src/b.ts", FS_ID),
    node(FILE_C, "module", "packages/c.ts", PACKAGE_ID),
    node(FN_A, "function", "src/a.ts", FILE_A),
    node(FN_B, "function", "src/b.ts", FILE_B),
    node(FN_C, "function", "packages/c.ts", FILE_C),
  ],
  edges: [
    { id: `imports@${FILE_A}|${FILE_B}`, source: FILE_A, target: FILE_B, kind: "imports", resolution: "resolved", weight: 1 },
  ],
  extensions: {
    logicFlow: {
      [FN_A]: [{ kind: "call", label: "fnB", target: FN_B, resolution: "resolved" }],
      [FN_C]: [],
    },
  },
} as unknown as GraphArtifact;

function reviewedStore(files: Array<{ path: string }>, extra?: Partial<StoreDependencies>) {
  const store = createBlueprintStore({
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "/api/prs?id=artifact-1",
    prOneUrl: "/api/prs/one?id=artifact-1",
    prFilesUrl: "/api/prs/files?id=artifact-1",
    prRelatedUrl: "/api/prs/related?id=artifact-1",
    prCommentsUrl: "/api/prs/comments?id=artifact-1",
    prChecksUrl: "/api/prs/checks?id=artifact-1",
    prReviewUrl: "/api/prs/review?id=artifact-1",
    ...extra,
  });
  store.setState({
    viewMode: "prs",
    prSelected: 5,
    prsList: { open: [pr(5)], closed: null },
    prFiles: files.map((file) => ({ path: file.path, status: "modified" as const, additions: 1, deletions: 0 })),
  });
  void store.getState().reviewPrInGraph();
  return store;
}

function attachDeletedNestedUnit(store: ReturnType<typeof reviewedStore>, sourceSide: "base" | undefined = "base") {
  const state = store.getState();
  const artifact: GraphArtifact = {
    ...state.artifact,
    nodes: [
      ...state.artifact.nodes,
      node(DELETED_CLASS_C, "class", "packages/c.ts", FILE_C),
      node(DELETED_METHOD_C, "method", "packages/c.ts", DELETED_CLASS_C),
    ],
  };
  store.setState({
    artifact,
    index: buildGraphIndex(artifact),
    reviewFiles: state.reviewFiles.map((file) => file.path === "packages/c.ts"
      ? {
          ...file,
          units: [{
            nodeId: DELETED_METHOD_C,
            displayName: "removed",
            kind: "method",
            startLine: 8,
            endLine: 12,
            sourceSide,
            depth: 1,
            isTest: false,
            fingerprint: "8:12|base:8-12",
          }],
        }
      : file),
    reviewBaseNodeIds: new Set([DELETED_CLASS_C, DELETED_METHOD_C]),
    reviewDeletedNodeIds: new Set([DELETED_METHOD_C]),
  });
}

const MIXED_PR = [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "packages/c.ts" }];

describe("change groups in PR review", () => {
  it("partitions the reviewed PR into disjoint groups and starts on All", () => {
    const store = reviewedStore(MIXED_PR);
    const groups = store.getState().reviewGroups;
    expect(groups?.groups.map((group) => group.files)).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["packages/c.ts"],
    ]);
    expect(store.getState().reviewActiveGroupId).toBeNull();
    expect(store.getState().reviewAllSeedIds).toEqual([FILE_A, FILE_B, FILE_C]);
    expect(store.getState().minimalSeedIds).toEqual([FILE_A, FILE_B, FILE_C]);
  });

  it("assigns each affected flow to the group of the files it touches", () => {
    const store = reviewedStore(MIXED_PR);
    const [connected, isolated] = store.getState().reviewGroups!.groups;
    expect(connected.flowIds).toEqual([FN_A]);
    expect(isolated.flowIds).toEqual([FN_C]);
    expect(store.getState().reviewGroups!.crossGroupFlowIds).toEqual([]);
  });

  it("selecting a group isolates the minimal overlay to its modules only", () => {
    const store = reviewedStore(MIXED_PR);
    const isolated = store.getState().reviewGroups!.groups[1];
    // Group isolation owns its declaration-level expansion too; this simulates switching from a
    // full-review rollup where the isolated file path was deliberately absent.
    store.setState({ moduleExpanded: new Set() });
    store.getState().selectReviewGroup(isolated.id);
    expect(store.getState().reviewActiveGroupId).toBe(isolated.id);
    expect(store.getState().minimalSeedIds).toEqual([FILE_C]);
    expect(store.getState().minimalMemberIds).toEqual([FILE_C]);
    expect(store.getState().moduleExpanded).toEqual(new Set([PACKAGE_ID, FILE_C]));
    expect(store.getState().reviewSelectedId).toBeNull();
  });

  it("keeps a nested deleted unit visible when selecting its change group", () => {
    const store = reviewedStore(MIXED_PR);
    attachDeletedNestedUnit(store);
    const isolated = store.getState().reviewGroups!.groups[1];
    store.setState({ moduleExpanded: new Set() });

    store.getState().selectReviewGroup(isolated.id);

    expect(store.getState().minimalSeedIds).toEqual([FILE_C]);
    expect(store.getState().moduleExpanded).toEqual(new Set([PACKAGE_ID, FILE_C, DELETED_CLASS_C]));
  });

  it("selecting All restores the full review seed set", () => {
    const store = reviewedStore(MIXED_PR);
    store.getState().selectReviewGroup(store.getState().reviewGroups!.groups[1].id);
    store.getState().selectReviewGroup(null);
    expect(store.getState().reviewActiveGroupId).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual([FILE_A, FILE_B, FILE_C]);
  });

  it("narrows the active review to a segment-safe path prefix and clears it losslessly", () => {
    const store = reviewedStore(MIXED_PR);

    store.getState().selectReviewPathScope("./src/");
    expect(store.getState().reviewPathScope).toBe("src");
    expect(store.getState().minimalSeedIds).toEqual([FILE_A, FILE_B]);
    expect(store.getState().minimalMemberIds).toEqual([FILE_A, FILE_B]);

    store.getState().selectReviewPathScope(null);
    expect(store.getState().reviewPathScope).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual([FILE_A, FILE_B, FILE_C]);
  });

  it("keeps legacy base-id units visible when narrowing to their path", () => {
    const store = reviewedStore(MIXED_PR);
    // Older in-memory rows may omit sourceSide; comparison/deleted membership remains authoritative.
    attachDeletedNestedUnit(store, undefined);
    store.setState({ moduleExpanded: new Set() });

    store.getState().selectReviewPathScope("packages");

    expect(store.getState().minimalSeedIds).toEqual([FILE_C]);
    expect(store.getState().moduleExpanded).toEqual(new Set([PACKAGE_ID, FILE_C, DELETED_CLASS_C]));
  });

  it("resumes the same change group and path scope instead of rebuilding the full PR graph", async () => {
    const store = reviewedStore(MIXED_PR);
    const connected = store.getState().reviewGroups!.groups[0];
    store.getState().selectReviewGroup(connected.id);
    store.getState().selectReviewPathScope("src");

    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().reviewActiveGroupId).toBe(connected.id);
    expect(store.getState().reviewPathScope).toBe("src");

    await store.getState().resumePrReview();

    expect(store.getState().reviewActiveGroupId).toBe(connected.id);
    expect(store.getState().reviewPathScope).toBe("src");
    expect(store.getState().minimalSeedIds).toEqual([FILE_A, FILE_B]);
    expect(store.getState().minimalMemberIds).toEqual([FILE_A, FILE_B]);
  });

  it("opens a container as an exact-file child graph and restores the outer PR graph verbatim", () => {
    const store = reviewedStore(MIXED_PR);
    const outerNodes = [{ id: "outer", position: { x: 12, y: 34 }, data: {} }];
    const outerEdges = [{ id: "outer-edge", source: FILE_A, target: FILE_B }];
    const outerExpanded = new Set([PACKAGE_ID, FS_ID]);
    store.setState({
      minimalLayoutStatus: "ready",
      minimalRfNodes: outerNodes,
      minimalRfEdges: outerEdges,
      minimalArrange: true,
      moduleSelected: new Set([FS_ID]),
      moduleExpanded: outerExpanded,
      reviewSelectedId: FN_A,
      reviewLitNodeIds: new Set([FN_A, FN_B]),
    });

    store.getState().openReviewSubgraph(FS_ID);

    expect(store.getState().reviewFocusedSubgraph).toMatchObject({
      rootId: FS_ID,
      filePaths: ["src/a.ts", "src/b.ts"],
      moduleIds: [FILE_A, FILE_B],
    });
    expect(store.getState().minimalSeedIds).toEqual([FILE_A, FILE_B]);
    expect(store.getState().minimalMemberIds).toEqual([FILE_A, FILE_B]);
    expect(store.getState().minimalRollups).toEqual({});
    expect(store.getState().moduleExpanded).toEqual(new Set([PACKAGE_ID]));
    expect(store.getState().moduleSelected).toEqual(new Set());

    store.getState().selectFlowEntry({ rootId: FN_A, blockPath: [] });
    expect(store.getState().flowSelection?.rootId).toBe(FN_A);
    expect(store.getState().reviewFlowBaseline).not.toBeNull();

    store.getState().closeReviewSubgraph();

    expect(store.getState().reviewFocusedSubgraph).toBeNull();
    expect(store.getState().flowSelection).toBeNull();
    expect(store.getState().reviewFlowBaseline).toBeNull();
    expect(store.getState().flowPaneRfNodes).toEqual([]);
    expect(store.getState().flowPaneRfEdges).toEqual([]);
    expect(store.getState().minimalRfNodes).toBe(outerNodes);
    expect(store.getState().minimalRfEdges).toBe(outerEdges);
    expect(store.getState().minimalArrange).toBe(true);
    expect(store.getState().moduleSelected).toEqual(new Set([FS_ID]));
    expect(store.getState().moduleExpanded).toEqual(outerExpanded);
    expect(store.getState().reviewSelectedId).toBe(FN_A);
    expect(store.getState().reviewLitNodeIds).toEqual(new Set([FN_A, FN_B]));
  });

  it("lays out an exact-file child graph across columns on its first open", async () => {
    const store = reviewedStore(MIXED_PR);
    await vi.waitFor(() => expect(store.getState().minimalLayoutStatus).toBe("ready"));

    store.getState().openReviewSubgraph(FS_ID);
    await vi.waitFor(() => {
      expect(store.getState().reviewFocusedSubgraph?.rootId).toBe(FS_ID);
      expect(store.getState().minimalLayoutStatus).toBe("ready");
    });

    const nodes = store.getState().minimalRfNodes;
    const a = nodes.find((node) => node.id === FILE_A)!;
    const b = nodes.find((node) => node.id === FILE_B)!;
    const widthA = Number((a.style as { width?: number } | undefined)?.width ?? 0);
    const widthB = Number((b.style as { width?: number } | undefined)?.width ?? 0);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.position.x + widthA <= b.position.x || b.position.x + widthB <= a.position.x).toBe(true);
    // Automatic canonical layout is a baseline, not a user-triggered Rearrange mutation.
    expect(store.getState().minimalArrange).toBe(false);
  });

  it("does not focus a container outside the active change group", () => {
    const store = reviewedStore(MIXED_PR);
    const isolated = store.getState().reviewGroups!.groups.find((group) => group.files.includes("packages/c.ts"))!;
    store.getState().selectReviewGroup(isolated.id);
    store.setState({ minimalLayoutStatus: "ready" });

    store.getState().openReviewSubgraph(FS_ID);

    expect(store.getState().reviewFocusedSubgraph).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual([FILE_C]);
  });

  it("does not let an unmatched path close and strand the review overlay", () => {
    const store = reviewedStore(MIXED_PR);
    const seeds = store.getState().minimalSeedIds;

    store.getState().selectReviewPathScope("src/aria/application");

    expect(store.getState().reviewPathScope).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual(seeds);
  });

  it("selecting a change group replaces an active path filter", () => {
    const store = reviewedStore(MIXED_PR);
    const isolated = store.getState().reviewGroups!.groups[1];
    store.getState().selectReviewPathScope("src");

    store.getState().selectReviewGroup(isolated.id);

    expect(store.getState().reviewPathScope).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual([FILE_C]);
  });

  it("an unknown group id falls back to All rather than stranding the reader", () => {
    const store = reviewedStore(MIXED_PR);
    store.getState().selectReviewGroup(store.getState().reviewGroups!.groups[0].id);
    store.getState().selectReviewGroup("no-such-group");
    expect(store.getState().reviewActiveGroupId).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual([FILE_A, FILE_B, FILE_C]);
  });

  it("a coherent single-component PR still yields one connectivity group", () => {
    const store = reviewedStore([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
    expect(store.getState().reviewGroups?.groups).toHaveLength(1);
  });

  it("does not let a manual Map extraction replace an active PR review", () => {
    const store = reviewedStore(MIXED_PR);
    const review = store.getState().review;
    const groups = store.getState().reviewGroups;
    const seeds = store.getState().minimalSeedIds;
    store.setState({ moduleSelected: new Set([FILE_A]) });
    store.getState().buildMinimalGraph();

    expect(store.getState().prReviewed).toBe(5);
    expect(store.getState().review).toBe(review);
    expect(store.getState().reviewGroups).toBe(groups);
    expect(store.getState().reviewActiveGroupId).toBeNull();
    expect(store.getState().reviewPathScope).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual(seeds);
  });
});
