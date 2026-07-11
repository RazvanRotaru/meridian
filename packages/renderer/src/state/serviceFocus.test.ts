/**
 * Phase-B Service-lens parity: cluster-frame FOCUS (the containment zoom), ghost REVEAL that opens
 * frames (never a folder focus), and minimal-graph seeds that decompose a selected `svc:` frame
 * into its cluster members' home files.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { frameIdOf } from "../derive/serviceClusterEdges";
import { moduleSurfaceSpec } from "../components/canvas/surfaceSpec";
import { createBlueprintStore, type BlueprintStore } from "./store";

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

// The chain Alpha → Beta → Gamma, with a helper store OWNED by Alpha's cluster so at least one
// cluster is multi-member (frame decomposition and force-expanded zoom need members to show).
const ALPHA = "ts:app/a.ts#AlphaService";
const ORDER = "ts:app/store.ts#OrderStore";
const BETA = "ts:app/b.ts#BetaService";
const GAMMA = "ts:app/c.ts#GammaService";

const NODES: GraphNode[] = [
  node("ts:app", "package", undefined, "app"),
  node("ts:app/a.ts", "module", "ts:app", "a.ts"),
  node(ALPHA, "class", "ts:app/a.ts", "AlphaService"),
  node(`${ALPHA}.run`, "method", ALPHA, "run"),
  node("ts:app/store.ts", "module", "ts:app", "store.ts"),
  node(ORDER, "class", "ts:app/store.ts", "OrderStore"),
  node(`${ORDER}.load`, "method", ORDER, "load"),
  node("ts:app/b.ts", "module", "ts:app", "b.ts"),
  node(BETA, "class", "ts:app/b.ts", "BetaService"),
  node(`${BETA}.run`, "method", BETA, "run"),
  node("ts:app/c.ts", "module", "ts:app", "c.ts"),
  node(GAMMA, "class", "ts:app/c.ts", "GammaService"),
  node(`${GAMMA}.run`, "method", GAMMA, "run"),
  // A folder with NO clustered units: the genuinely-unclustered anchor (a folder anchor with
  // clustered units decomposes to them since the folder-group ghost reveal).
  node("ts:lib", "package", undefined, "lib"),
  node("ts:lib/util.ts", "module", "ts:lib", "util.ts"),
];

const EDGES: GraphEdge[] = [
  { id: "e1", source: `${ALPHA}.run`, target: `${BETA}.run`, kind: "calls", resolution: "resolved" },
  { id: "e2", source: `${ALPHA}.run`, target: `${ORDER}.load`, kind: "calls", resolution: "resolved" },
  { id: "e3", source: `${BETA}.run`, target: `${GAMMA}.run`, kind: "calls", resolution: "resolved" },
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

describe("Service cluster focus (the containment dive)", () => {
  it("diving into a svc: frame zooms the lens to that ONE cluster, members drawn, ghosts for the rest", async () => {
    const store = freshStore();
    store.setState({ viewMode: "call" });
    store.getState().setModuleFocus(frameIdOf(ALPHA));
    await store.getState().moduleRelayout();
    const state = store.getState();
    expect(state.moduleFocus).toBe(frameIdOf(ALPHA));
    expect(state.moduleEffectiveFocus).toBe(frameIdOf(ALPHA));
    const ids = new Set(state.moduleRfNodes.map((n) => n.id));
    expect(ids.has(frameIdOf(ALPHA))).toBe(true);
    expect(ids.has(ALPHA)).toBe(true);
    expect(ids.has(ORDER)).toBe(true);
    expect(ids.has(frameIdOf(BETA))).toBe(false);
    // The off-zoom callee appears as a banded ghost card (kept OUT of ELK, still on the canvas).
    const ghost = state.moduleRfNodes.find((n) => n.id === BETA);
    expect(ghost?.type).toBe("ghost");
  });

  it("clearing the focus (the All-services crumb) restores the full lens", async () => {
    const store = freshStore();
    store.setState({ viewMode: "call", moduleFocus: frameIdOf(ALPHA) });
    store.getState().setModuleFocus(null);
    await store.getState().moduleRelayout();
    expect(store.getState().moduleEffectiveFocus).toBeNull();
    expect(store.getState().moduleRfNodes.some((n) => n.id === frameIdOf(BETA))).toBe(true);
  });

  it("focus composes with the scoped sub-view (zoom INSIDE the scope; the scope survives the dive)", async () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${ALPHA}.run`]) });
    store.getState().openServiceScope();
    expect(store.getState().serviceScope).not.toBeNull();
    store.getState().setModuleFocus(frameIdOf(ALPHA));
    await store.getState().moduleRelayout();
    const state = store.getState();
    expect(state.serviceScope).not.toBeNull();
    expect(state.moduleEffectiveFocus).toBe(frameIdOf(ALPHA));
    expect(state.moduleRfNodes.some((n) => n.id === frameIdOf(BETA))).toBe(false);
  });

  it("the lens-carry into the Service lens never dives (moduleFocus lands null)", () => {
    const store = freshStore();
    store.setState({ viewMode: "modules", moduleSelected: new Set([ALPHA]) });
    store.getState().setViewMode("call");
    expect(store.getState().moduleFocus).toBeNull();
    expect(store.getState().moduleSelected.has(ALPHA)).toBe(true);
  });

  it("leaving a FOCUSED Service lens carries the cluster's lead to the Map — never the svc: pseudo-id", () => {
    const store = freshStore();
    store.setState({ viewMode: "call", moduleFocus: frameIdOf(ALPHA), moduleEffectiveFocus: frameIdOf(ALPHA) });
    store.getState().setViewMode("modules");
    // The carry reveals the lead: the Map focuses its home DIRECTORY (mapRevealStateForMany's
    // common-package focus), with the lead itself selected — never the svc: pseudo-id.
    expect(store.getState().moduleFocus).toBe("ts:app");
    expect(store.getState().moduleSelected.has(ALPHA)).toBe(true);
  });
});

describe("revealServiceGhost (ghost double-click on the Service lens)", () => {
  it("opens the owning svc: frame IN PLACE (union), selects the node, and never sets a focus", () => {
    const store = freshStore();
    store.setState({ viewMode: "call", moduleExpanded: new Set(["keep-me"]) });
    store.getState().revealServiceGhost(ORDER);
    const state = store.getState();
    expect(state.moduleFocus).toBeNull();
    expect(state.moduleExpanded.has(frameIdOf(ALPHA))).toBe(true);
    expect(state.moduleExpanded.has("keep-me")).toBe(true);
    expect(state.moduleSelected).toEqual(new Set([ORDER]));
  });

  it("keeps a live zoom when the ghost lives INSIDE the focused cluster", () => {
    const store = freshStore();
    store.setState({ viewMode: "call", moduleFocus: frameIdOf(ALPHA) });
    store.getState().revealServiceGhost(ORDER);
    expect(store.getState().moduleFocus).toBe(frameIdOf(ALPHA));
    expect(store.getState().moduleSelected).toEqual(new Set([ORDER]));
  });

  it("clears a FOREIGN zoom so the opened frame is actually on canvas", () => {
    const store = freshStore();
    store.setState({ viewMode: "call", moduleFocus: frameIdOf(BETA) });
    store.getState().revealServiceGhost(ORDER);
    expect(store.getState().moduleFocus).toBeNull();
    expect(store.getState().moduleExpanded.has(frameIdOf(ALPHA))).toBe(true);
  });

  it("widens a live scope by the ghost's owning lead (the frame must draw to be openable)", () => {
    const store = freshStore();
    store.setState({ moduleSelected: new Set([`${GAMMA}.run`]) });
    store.getState().openServiceScope();
    const before = store.getState().serviceScope!;
    expect(new Set(before.leadIds)).toEqual(new Set([BETA, GAMMA]));
    expect(before.label).toBe("GammaService (+1)");
    store.getState().revealServiceGhost(ALPHA);
    const after = store.getState().serviceScope!;
    expect(new Set(after.leadIds)).toEqual(new Set([ALPHA, BETA, GAMMA]));
    // The trail keeps naming the ORIGINAL owner, but the "(+K)" recounts the widened set.
    expect(after.label).toBe("GammaService (+2)");
  });

  it("an unclustered ghost is a best-effort select only (no expansion, no focus change)", () => {
    const store = freshStore();
    store.setState({ viewMode: "call", moduleExpanded: new Set(["keep-me"]) });
    store.getState().revealServiceGhost("ts:lib");
    const state = store.getState();
    expect(state.moduleSelected).toEqual(new Set(["ts:lib"]));
    expect(state.moduleExpanded).toEqual(new Set(["keep-me"]));
    expect(state.moduleFocus).toBeNull();
  });
});

describe("minimal-graph seeds from svc: frames", () => {
  it("a selected frame decomposes into its cluster members' HOME FILES (the overlay draws file boxes, never bare units)", () => {
    const store = freshStore();
    store.setState({ viewMode: "call", moduleSelected: new Set([frameIdOf(ALPHA)]) });
    store.getState().buildMinimalGraph();
    expect(new Set(store.getState().minimalSeedIds)).toEqual(new Set(["ts:app/a.ts", "ts:app/store.ts"]));
    expect(store.getState().minimalMemberIds).toHaveLength(2);
  });

  it("a mixed frame + unit selection seeds the union of home files, deduped", () => {
    const store = freshStore();
    store.setState({ viewMode: "call", moduleSelected: new Set([frameIdOf(ALPHA), GAMMA]) });
    store.getState().buildMinimalGraph();
    expect(new Set(store.getState().minimalSeedIds)).toEqual(new Set(["ts:app/a.ts", "ts:app/store.ts", "ts:app/c.ts"]));
    expect(store.getState().minimalSeedIds).toHaveLength(3);
  });

  it("a frame plus one of its OWN members dedupes (the member's home file seeds once)", () => {
    const store = freshStore();
    store.setState({ viewMode: "call", moduleSelected: new Set([frameIdOf(ALPHA), ORDER]) });
    store.getState().buildMinimalGraph();
    expect(store.getState().minimalSeedIds).toHaveLength(2);
    expect(new Set(store.getState().minimalSeedIds)).toEqual(new Set(["ts:app/a.ts", "ts:app/store.ts"]));
  });

  it("an unknown svc: frame contributes nothing; a unit lands on its home file, module ids pass through", () => {
    const index = buildGraphIndex(ARTIFACT);
    const spec = moduleSurfaceSpec("call")!;
    expect(spec.minimalSeeds(["svc:ts:app/z.ts#NopeService"], index)).toEqual([]);
    expect(spec.minimalSeeds([ALPHA, "ts:app/a.ts"], index)).toEqual(["ts:app/a.ts"]);
    expect(spec.minimalSeeds(["ts:app", "ts:app/c.ts"], index)).toEqual(["ts:app", "ts:app/c.ts"]);
  });

  it("the Map's seeds stay identity (no decomposition on the folder lens)", () => {
    const index = buildGraphIndex(ARTIFACT);
    const spec = moduleSurfaceSpec("modules")!;
    expect(spec.minimalSeeds(["ts:app/a.ts", "ts:app"], index)).toEqual(["ts:app/a.ts", "ts:app"]);
  });
});

describe("the Service surface's focus model (breadcrumb contract)", () => {
  it("names its root 'All services' and crumbs a focused cluster by display name", () => {
    const index = buildGraphIndex(ARTIFACT);
    const focus = moduleSurfaceSpec("call")!.focus;
    expect(focus.rootLabel).toBe("All services");
    expect(focus.crumbs(null, index)).toEqual([]);
    expect(focus.crumbs(frameIdOf(ALPHA), index)).toEqual([{ id: frameIdOf(ALPHA), label: "AlphaService" }]);
  });

  it("the Map keeps its containment trail (Repository root, package/dir crumbs)", () => {
    const index = buildGraphIndex(ARTIFACT);
    const focus = moduleSurfaceSpec("modules")!.focus;
    expect(focus.rootLabel).toBe("Repository");
    expect(focus.crumbs("ts:app", index)).toEqual([{ id: "ts:app", label: "app" }]);
  });

  it("only svc: frames dive on the Service lens; folders and files keep expand/select", () => {
    const service = moduleSurfaceSpec("call")!.focus;
    expect(service.divable("package", frameIdOf(ALPHA))).toBe(true);
    expect(service.divable("package", "ts:app")).toBe(false);
    expect(service.divable("file", "ts:app/a.ts")).toBe(false);
    const map = moduleSurfaceSpec("modules")!.focus;
    expect(map.divable("package", "ts:app")).toBe(true);
    expect(map.divable("file", "ts:app/a.ts")).toBe(true);
    expect(map.divable("unit", ALPHA)).toBe(false);
  });
});
