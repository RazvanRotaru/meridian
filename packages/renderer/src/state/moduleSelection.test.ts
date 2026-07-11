/**
 * Module-map multi-selection semantics: plain click (selectModule) REPLACES the selection,
 * ctrl/cmd+click (toggleModuleSelect) flips one node's membership, zooming to a new level clears,
 * and hiding tests strands test-code ids OUT of the set without touching production picks.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore, type BlueprintStore } from "./store";

function node(id: string, kind: string, file: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } };
}

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-07T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [
    node("ts:src", "package", "src"),
    node("ts:src/a.ts", "module", "src/a.ts", "ts:src"),
    node("ts:src/b.ts", "module", "src/b.ts", "ts:src"),
    node("ts:src/a.test.ts", "module", "src/a.test.ts", "ts:src"),
  ],
  edges: [],
};

function freshStore(): BlueprintStore {
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

describe("module-map selection set", () => {
  it("starts empty", () => {
    expect(freshStore().getState().moduleSelected.size).toBe(0);
  });

  it("selectModule replaces the whole selection; null clears it", () => {
    const store = freshStore();
    store.getState().selectModule("ts:src/a.ts");
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/a.ts"]));
    store.getState().selectModule("ts:src/b.ts");
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/b.ts"]));
    store.getState().selectModule(null);
    expect(store.getState().moduleSelected.size).toBe(0);
  });

  it("toggleModuleSelect adds and removes single nodes without touching the rest", () => {
    const store = freshStore();
    store.getState().toggleModuleSelect("ts:src/a.ts");
    store.getState().toggleModuleSelect("ts:src/b.ts");
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/a.ts", "ts:src/b.ts"]));
    store.getState().toggleModuleSelect("ts:src/a.ts");
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/b.ts"]));
  });

  it("zooming to another level clears the selection", () => {
    const store = freshStore();
    store.getState().toggleModuleSelect("ts:src/a.ts");
    store.getState().setModuleFocus("ts:src");
    expect(store.getState().moduleSelected.size).toBe(0);
  });

  it("hiding tests strands test ids out of the selection but keeps production picks", () => {
    const store = freshStore();
    store.getState().toggleShowTests(); // tests are hidden by default — reveal them so a test id is pickable
    store.getState().toggleModuleSelect("ts:src/a.ts");
    store.getState().toggleModuleSelect("ts:src/a.test.ts");
    store.getState().toggleShowTests(); // hide again — the test id is stranded out of the selection
    expect(store.getState().moduleSelected).toEqual(new Set(["ts:src/a.ts"]));
  });
});

describe("minimal-graph overlay (extract selection)", () => {
  function withBuiltGraph(): BlueprintStore {
    const store = freshStore();
    store.getState().toggleModuleSelect("ts:src/a.ts");
    store.getState().toggleModuleSelect("ts:src/b.ts");
    store.getState().buildMinimalGraph();
    return store;
  }

  it("buildMinimalGraph extracts the selection verbatim as members and origin", () => {
    const store = withBuiltGraph();
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
  });

  it("promoteMinimalGhost adds a member without touching the origin", () => {
    const store = withBuiltGraph();
    store.getState().promoteMinimalGhost("ts:src/a.test.ts");
    expect(store.getState().minimalMemberIds).toContain("ts:src/a.test.ts");
    expect(store.getState().minimalSeedIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
    // Promoting an existing member is a no-op.
    store.getState().promoteMinimalGhost("ts:src/a.ts");
    expect(store.getState().minimalMemberIds.filter((id) => id === "ts:src/a.ts")).toHaveLength(1);
  });

  it("demoteMinimalMember removes a member but never empties the set", () => {
    const store = withBuiltGraph();
    store.getState().demoteMinimalMember("ts:src/b.ts");
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts"]);
    // The last member can't be removed.
    store.getState().demoteMinimalMember("ts:src/a.ts");
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts"]);
  });

  it("resetMinimalGraph restores the working set to the origin", () => {
    const store = withBuiltGraph();
    store.getState().promoteMinimalGhost("ts:src/a.test.ts");
    store.getState().demoteMinimalMember("ts:src/b.ts");
    store.getState().resetMinimalGraph();
    expect(store.getState().minimalMemberIds).toEqual(["ts:src/a.ts", "ts:src/b.ts"]);
  });

  it("a fresh build resets any prior curation", () => {
    const store = withBuiltGraph();
    store.getState().promoteMinimalGhost("ts:src/a.test.ts");
    store.getState().buildMinimalGraph();
    expect(store.getState().minimalMemberIds).toEqual(store.getState().minimalSeedIds);
  });

  it("closeMinimalGraph clears the overlay but keeps the selection for a rebuild", () => {
    const store = withBuiltGraph();
    store.getState().closeMinimalGraph();
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
    expect(store.getState().moduleSelected.size).toBe(2);
  });

  it("leaving the Map lens closes the overlay (it never lingers behind another tab)", () => {
    const store = withBuiltGraph();
    store.getState().promoteMinimalGhost("ts:src/a.test.ts");
    store.getState().setViewMode("logic");
    expect(store.getState().minimalSeedIds).toEqual([]);
    expect(store.getState().minimalMemberIds).toEqual([]);
  });
});
