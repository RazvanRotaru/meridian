import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { frameIdOf } from "../derive/serviceClusterEdges";
import { createBlueprintStore, type BlueprintState, type BlueprintStore } from "./store";
import { decodeNavState } from "./urlState";
import { structuralState } from "./urlSync";

function node(id: string, kind: string, parentId?: string, displayName?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: displayName ?? id,
    parentId: parentId ?? null,
    location: { file: "f.ts", startLine: 1 },
  } as GraphNode;
}

// Three single-class service clusters coupled in a chain Alpha → Beta → Gamma, so the 1-hop scope
// differs by where you stand: from Alpha it is {Alpha, Beta}; from Beta (couplings count in EITHER
// direction) it is all three.
const ALPHA = "ts:app/a.ts#AlphaService";
const BETA = "ts:app/b.ts#BetaService";
const GAMMA = "ts:app/c.ts#GammaService";

const NODES: GraphNode[] = [
  node("ts:app", "package", undefined, "app"),
  node("ts:app/a.ts", "module", "ts:app", "a.ts"),
  node(ALPHA, "class", "ts:app/a.ts", "AlphaService"),
  node(`${ALPHA}.run`, "method", ALPHA, "run"),
  node("ts:app/b.ts", "module", "ts:app", "b.ts"),
  node(BETA, "class", "ts:app/b.ts", "BetaService"),
  node(`${BETA}.run`, "method", BETA, "run"),
  node("ts:app/c.ts", "module", "ts:app", "c.ts"),
  node(GAMMA, "class", "ts:app/c.ts", "GammaService"),
  node(`${GAMMA}.run`, "method", GAMMA, "run"),
];

const EDGES: GraphEdge[] = [
  { id: "e1", source: `${ALPHA}.run`, target: `${BETA}.run`, kind: "calls", resolution: "resolved" },
  { id: "e2", source: `${BETA}.run`, target: `${GAMMA}.run`, kind: "calls", resolution: "resolved" },
] as GraphEdge[];

const ARTIFACT = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-10T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: NODES,
  edges: EDGES,
} as GraphArtifact;

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
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
}

describe("openServiceScope", () => {
  it("scopes to the owning cluster + 1-hop, enters the call lens, and opens the owning frame", () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${ALPHA}.run`]) });
    store.getState().openServiceScope();
    const state = store.getState();
    expect(state.viewMode).toBe("call");
    expect(state.serviceScope).not.toBeNull();
    expect(new Set(state.serviceScope!.leadIds)).toEqual(new Set([ALPHA, BETA]));
    expect(state.serviceScope!.label).toBe("AlphaService (+1)");
    expect(state.moduleExpanded.has(frameIdOf(ALPHA))).toBe(true);
    expect(state.moduleSelected).toEqual(new Set([`${ALPHA}.run`]));
    expect(state.moduleFocus).toBeNull();
  });

  it("scopes from a FILE anchor through its contained unit's cluster, keeping the file selected", () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set(["ts:app/a.ts"]) });
    store.getState().openServiceScope();
    const state = store.getState();
    expect(state.viewMode).toBe("call");
    expect(new Set(state.serviceScope!.leadIds)).toEqual(new Set([ALPHA, BETA]));
    expect(state.moduleExpanded.has(frameIdOf(ALPHA))).toBe(true);
    expect(state.moduleSelected).toEqual(new Set(["ts:app/a.ts"]));
  });

  it("scopes from a selected svc: cluster frame via its lead unit", () => {
    const store = freshStore();
    store.setState({ viewMode: "call", moduleSelected: new Set([frameIdOf(ALPHA)]) });
    store.getState().openServiceScope();
    const state = store.getState();
    expect(new Set(state.serviceScope!.leadIds)).toEqual(new Set([ALPHA, BETA]));
    expect(state.moduleExpanded.has(frameIdOf(ALPHA))).toBe(true);
    expect(state.moduleSelected).toEqual(new Set([ALPHA]));
  });

  it("counts couplings in EITHER direction: scoping from Beta pulls in Alpha (caller) and Gamma (callee)", () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${BETA}.run`]) });
    store.getState().openServiceScope();
    expect(new Set(store.getState().serviceScope!.leadIds)).toEqual(new Set([ALPHA, BETA, GAMMA]));
    expect(store.getState().serviceScope!.label).toBe("BetaService (+2)");
  });

  it("is a no-op when nothing anchored resolves to a cluster", () => {
    const store = freshStore();
    store.getState().openServiceScope();
    expect(store.getState().serviceScope).toBeNull();
    expect(store.getState().viewMode).toBe("modules");
  });

  it("re-scoping from WITHIN the call lens unions the reader's open frames with the reveal's", () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${GAMMA}.run`]) });
    store.getState().openServiceScope(); // now in the call lens with Gamma's frame open.
    expect(store.getState().moduleExpanded.has(frameIdOf(GAMMA))).toBe(true);
    store.setState({ moduleSelected: new Set([`${ALPHA}.run`]) });
    store.getState().openServiceScope();
    const state = store.getState();
    // The new reveal's frame is open AND the previously open frame survived (plain union).
    expect(state.moduleExpanded.has(frameIdOf(ALPHA))).toBe(true);
    expect(state.moduleExpanded.has(frameIdOf(GAMMA))).toBe(true);
    expect(new Set(state.serviceScope!.leadIds)).toEqual(new Set([ALPHA, BETA]));
  });

  it("scoping from ANOTHER lens replaces the expansion (lens-switch semantics)", () => {
    const store = freshStore();
    store.setState({ viewMode: "modules", moduleExpanded: new Set(["ts:app/c.ts"]), moduleSelected: new Set([`${ALPHA}.run`]) });
    store.getState().openServiceScope();
    const state = store.getState();
    expect(state.moduleExpanded.has(frameIdOf(ALPHA))).toBe(true);
    expect(state.moduleExpanded.has("ts:app/c.ts")).toBe(false);
  });
});

describe("clearServiceScope / setViewMode", () => {
  it("clearServiceScope restores the full lens and is a no-op when already unscoped", () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${ALPHA}.run`]) });
    store.getState().openServiceScope();
    store.getState().clearServiceScope();
    expect(store.getState().serviceScope).toBeNull();
    expect(store.getState().viewMode).toBe("call");
    store.getState().clearServiceScope();
    expect(store.getState().serviceScope).toBeNull();
  });

  it("leaving the call lens through setViewMode clears the scope", () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${ALPHA}.run`]) });
    store.getState().openServiceScope();
    store.getState().setViewMode("modules");
    expect(store.getState().serviceScope).toBeNull();
    expect(store.getState().viewMode).toBe("modules");
  });

  it("re-clicking the ACTIVE Service tab clears a live scope (the escape hatch)", () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${ALPHA}.run`]) });
    store.getState().openServiceScope();
    expect(store.getState().serviceScope).not.toBeNull();
    store.getState().setViewMode("call"); // same mode — previously a pure no-op that kept the scope.
    expect(store.getState().serviceScope).toBeNull();
    expect(store.getState().viewMode).toBe("call");
  });

  it("openLogicFlow clears the scope (every lens entry runs the shared transition)", () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${ALPHA}.run`]) });
    store.getState().openServiceScope();
    store.getState().openLogicFlow(`${ALPHA}.run`);
    expect(store.getState().serviceScope).toBeNull();
    expect(store.getState().viewMode).toBe("logic");
  });

  it("openComposition re-enters the call lens WITHOUT resurrecting a cleared scope", () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${ALPHA}.run`]) });
    store.getState().openServiceScope();
    store.getState().openLogicFlow(`${ALPHA}.run`);
    store.getState().openComposition(ALPHA); // back into "call" — must land unscoped.
    expect(store.getState().viewMode).toBe("call");
    expect(store.getState().serviceScope).toBeNull();
  });
});

describe("history restores (urlSync structuralState)", () => {
  it("always resets the scope — it is session-only, so no history entry may carry one", () => {
    const restored = structuralState(decodeNavState(new URLSearchParams("")));
    expect(restored).toHaveProperty("serviceScope", null);
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${ALPHA}.run`]) });
    store.getState().openServiceScope();
    store.setState(structuralState(decodeNavState(new URLSearchParams("view=call"))) as Partial<BlueprintState>);
    expect(store.getState().serviceScope).toBeNull();
  });
});
