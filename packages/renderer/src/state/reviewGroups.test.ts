/**
 * The change-groups review slice: a PR that is really N independent changes partitions into N
 * groups at review time, and selecting a group ISOLATES the minimal overlay to its modules — a pure
 * seed/member swap through the existing machinery, never a dim. Fixture: a.ts → b.ts are one
 * connected change, c.ts an unrelated one; all three files arrive in a single PR.
 */

import { describe, expect, it } from "vitest";
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
    author: "octo",
    headRef: "feature",
    baseRef: "main",
    updatedAt: "2026-07-10T00:00:00.000Z",
    draft: false,
    state: "open",
    url: `https://github.com/o/r/pull/${number}`,
  };
}

const PACKAGE_ID = "ts:src";
const FILE_A = "ts:src/a.ts";
const FILE_B = "ts:src/b.ts";
const FILE_C = "ts:src/c.ts";
const FN_A = `${FILE_A}#fnA`;
const FN_B = `${FILE_B}#fnB`;
const FN_C = `${FILE_C}#fnC`;

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-10T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node(PACKAGE_ID, "package", "src"),
    node(FILE_A, "module", "src/a.ts", PACKAGE_ID),
    node(FILE_B, "module", "src/b.ts", PACKAGE_ID),
    node(FILE_C, "module", "src/c.ts", PACKAGE_ID),
    node(FN_A, "function", "src/a.ts", FILE_A),
    node(FN_B, "function", "src/b.ts", FILE_B),
    node(FN_C, "function", "src/c.ts", FILE_C),
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
    prFilesUrl: "/api/prs/files?id=artifact-1",
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

const MIXED_PR = [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }];

describe("change groups in PR review", () => {
  it("partitions the reviewed PR into disjoint groups and starts on All", () => {
    const store = reviewedStore(MIXED_PR);
    const groups = store.getState().reviewGroups;
    expect(groups?.groups.map((group) => group.files)).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["src/c.ts"],
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
    store.getState().selectReviewGroup(isolated.id);
    expect(store.getState().reviewActiveGroupId).toBe(isolated.id);
    expect(store.getState().minimalSeedIds).toEqual([FILE_C]);
    expect(store.getState().minimalMemberIds).toEqual([FILE_C]);
    expect(store.getState().reviewSelectedId).toBeNull();
  });

  it("selecting All restores the full review seed set", () => {
    const store = reviewedStore(MIXED_PR);
    store.getState().selectReviewGroup(store.getState().reviewGroups!.groups[1].id);
    store.getState().selectReviewGroup(null);
    expect(store.getState().reviewActiveGroupId).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual([FILE_A, FILE_B, FILE_C]);
  });

  it("an unknown group id falls back to All rather than stranding the reader", () => {
    const store = reviewedStore(MIXED_PR);
    store.getState().selectReviewGroup(store.getState().reviewGroups!.groups[0].id);
    store.getState().selectReviewGroup("no-such-group");
    expect(store.getState().reviewActiveGroupId).toBeNull();
    expect(store.getState().minimalSeedIds).toEqual([FILE_A, FILE_B, FILE_C]);
  });

  it("a coherent single-component PR yields one group — the strip-hidden precondition", () => {
    const store = reviewedStore([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
    expect(store.getState().reviewGroups?.groups).toHaveLength(1);
  });

  it("a manual Map extraction supersedes the review and drops its groups", () => {
    const store = reviewedStore(MIXED_PR);
    store.setState({ moduleSelected: new Set([FILE_A]) });
    store.getState().buildMinimalGraph();
    expect(store.getState().reviewGroups).toBeNull();
    expect(store.getState().reviewActiveGroupId).toBeNull();
    expect(store.getState().reviewAllSeedIds).toEqual([]);
  });
});
