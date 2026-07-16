import { describe, expect, it, vi } from "vitest";
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

const PRIVATE_ARTIFACT: GraphArtifact = {
  ...ARTIFACT,
  nodes: ARTIFACT.nodes.map((candidate) =>
    candidate.id === METHOD_ID ? { ...candidate, tags: ["private"] } : candidate),
};

function freshStore(artifact: GraphArtifact = ARTIFACT): BlueprintStore {
  const index = buildGraphIndex(artifact);
  return createBlueprintStore({
    artifact,
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
}

describe("module-map expansion actions", () => {
  it("expandModuleChildren accepts a file id and expands direct unit cards", () => {
    const store = freshStore();
    store.setState({ moduleFocus: "ts:pkg", moduleExpanded: new Set([FILE_ID]) });
    store.getState().expandModuleChildren(FILE_ID);
    expect(store.getState().moduleExpanded).toEqual(new Set([FILE_ID, UNIT_ID, HELPER_ID]));
  });

  it("expandModuleChildren accepts a unit id", () => {
    const store = freshStore();
    store.setState({ moduleFocus: "ts:pkg", moduleExpanded: new Set([FILE_ID, UNIT_ID]) });
    store.getState().expandModuleChildren(UNIT_ID);
    expect(store.getState().moduleExpanded).toEqual(new Set([FILE_ID, UNIT_ID, METHOD_ID]));
  });

  it("revealModule expands the owning file and unit for hidden member definitions", () => {
    const store = freshStore();
    store.setState({ showPrivate: false });
    store.getState().revealModule(METHOD_ID);
    expect(store.getState().moduleExpanded).toEqual(new Set([FILE_ID, UNIT_ID]));
    expect(store.getState().moduleSelected).toEqual(new Set([METHOD_ID]));
    expect(store.getState().showPrivate).toBe(false);
  });

  it("revealModule exposes an explicitly requested private member", () => {
    const store = freshStore(PRIVATE_ARTIFACT);
    store.setState({ showPrivate: false, moduleRelayout: vi.fn(async () => {}) });

    store.getState().revealModule(METHOD_ID);

    expect(store.getState().showPrivate).toBe(true);
    expect(store.getState().moduleExpanded).toEqual(new Set([FILE_ID, UNIT_ID]));
    expect(store.getState().moduleSelected).toEqual(new Set([METHOD_ID]));
  });

  it("reveals a private palette pick through its owning Service card", () => {
    const store = freshStore(PRIVATE_ARTIFACT);
    const moduleRelayout = vi.fn(async () => {});
    store.setState({ viewMode: "call", showPrivate: false, moduleRelayout });

    store.getState().revealInView(METHOD_ID);

    expect(store.getState().showPrivate).toBe(true);
    expect(store.getState().mapExtra).toEqual(new Set([UNIT_ID]));
    expect(store.getState().moduleSelected).toEqual(new Set([UNIT_ID]));
    expect(moduleRelayout).toHaveBeenCalledOnce();
  });

  it("exposes an added private pick without relayout when its owning card is already pinned", () => {
    const store = freshStore(PRIVATE_ARTIFACT);
    const moduleRelayout = vi.fn(async () => {});
    store.setState({ viewMode: "modules", showPrivate: false, moduleRelayout });

    store.getState().addToView(METHOD_ID);
    expect(store.getState().showPrivate).toBe(true);
    expect(store.getState().mapExtra).toEqual(new Set([UNIT_ID]));
    expect(moduleRelayout).toHaveBeenCalledOnce();

    store.setState({ showPrivate: false });
    moduleRelayout.mockClear();
    store.getState().addToView(METHOD_ID);

    expect(store.getState().showPrivate).toBe(true);
    expect(store.getState().mapExtra).toEqual(new Set([UNIT_ID]));
    expect(moduleRelayout).not.toHaveBeenCalled();
  });

  it.each([
    { viewMode: "modules", lens: "Map" },
    { viewMode: "call", lens: "Service" },
    { viewMode: "ui", lens: "UI" },
  ] as const)("keeps the command-palette + working on the plain $lens lens", ({ viewMode }) => {
    const store = freshStore();
    const moduleRelayout = vi.fn(async () => {});
    store.setState({ viewMode, moduleRelayout });

    store.getState().addToView(METHOD_ID);

    expect(store.getState().mapExtra).toEqual(new Set([UNIT_ID]));
    expect(store.getState().minimalMemberIds).toEqual([]);
    expect(moduleRelayout).toHaveBeenCalledOnce();
  });
});
