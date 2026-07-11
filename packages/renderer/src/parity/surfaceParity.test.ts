/**
 * The cross-lens PARITY suite (unified-canvas phase E) — the one test suite this project wants:
 * table-driven over the module-surface REGISTRY (Map / Service / UI, read off `moduleSurfaceSpec`,
 * never a hardcoded copy), one shared fixture graph, one capability per describe block:
 *
 *   GHOSTS          the same off-canvas coupling ghosts with the SAME real node ids on every
 *                   surface; no ghost when the fact is drawn; and the honest invariant — every
 *                   coupling fact touching the canvas is represented, never silently dropped.
 *   EXPAND/COLLAPSE the same container toggle = the same `moduleExpanded` delta, and the same
 *                   children charted, on every surface that draws the container.
 *   FOCUS           `spec.focus.dive` lands the same effectiveFocus/breadcrumb contract per
 *                   surface; clearing restores the root.
 *   MINIMAL SEEDS   the same selection seeds the overlay onto the same HOME FILES everywhere
 *                   (`svc:` frames decomposed on the Service lens).
 *   PROMOTION       the ghost "+" pins the same home file into `mapExtra` on every surface.
 *
 * Edge-colour parity and the ELK-options identity lock live beside this file (parity/ siblings).
 */

import { describe, expect, it } from "vitest";
import type { ViewMode } from "../derive/edgeSelection";
import { activeModuleSurfaceSpec, moduleSurfaceSpec, MINIMAL_OVERLAY_HIGHWAYS } from "../components/canvas/surfaceSpec";
import {
  ALL_VIEW_MODES,
  MODULE_SURFACE_MODES,
  type Arrangement,
  deriveFor,
  cachesFor,
  freshIndex,
  freshStore,
  ghostIdsOf,
  unrepresentedFacts,
  ALPHA, ALPHA_RUN, APP_FILE, APP_FN, APP_PKG, A_FILE, BETA, BETA_PKG, B_FILE, CORE, ORDER, STORE_FILE, SVC_ALPHA,
} from "./surfaceFixture";
import { homeFileOf } from "../derive/serviceClusterEdges";

const INDEX = freshIndex();
const CACHES = cachesFor(INDEX);
const spec = (mode: ViewMode) => moduleSurfaceSpec(mode)!;

/** Per-surface canvas states for one capability. A registry surface MISSING here fails loudly:
 * a new lens must join the parity table before it ships. */
function perSurface<T>(table: Partial<Record<ViewMode, T>>): (mode: ViewMode) => T {
  return (mode) => {
    const entry = table[mode];
    if (entry === undefined) {
      throw new Error(`surface "${mode}" has no parity-table entry — every registry surface must be covered`);
    }
    return entry;
  };
}

describe("the surface registry (the parity table's row source)", () => {
  it("registers exactly the three module lenses; logic/prs render their own surfaces", () => {
    expect([...MODULE_SURFACE_MODES].sort()).toEqual(["call", "modules", "ui"]);
    expect(ALL_VIEW_MODES.filter((mode) => moduleSurfaceSpec(mode) === null).sort()).toEqual(["logic", "prs"]);
  });

  it("module-family actions fall back to the Map off the module lenses; the overlay spools only", () => {
    expect(activeModuleSurfaceSpec("logic")).toBe(moduleSurfaceSpec("modules"));
    expect(MINIMAL_OVERLAY_HIGHWAYS).toEqual({ bundling: false, routing: false, spooling: true });
    for (const mode of MODULE_SURFACE_MODES) {
      expect(spec(mode).highways).toEqual({ bundling: true, routing: true, spooling: true });
    }
  });
});

describe("GHOSTS — the same off-canvas facts chart as the same ghost cards on every surface", () => {
  // The same two facts leave each surface's canvas: Alpha.run -> Beta.run (dependency) and
  // App -> Alpha.run (caller). Each surface makes them off-canvas its own way — the Map and the
  // UI lens by folder focus, the Service lens by the cluster zoom.
  const offCanvas = perSurface<Arrangement>({
    modules: { focus: CORE, expanded: [] },
    ui: { focus: CORE, expanded: [] },
    call: { focus: SVC_ALPHA, expanded: [] },
  });
  // And each surface draws them its own way: files on the folder lenses, frames on the Service lens.
  const allDrawn = perSurface<Arrangement>({
    modules: { focus: APP_PKG, expanded: [CORE, BETA_PKG] },
    ui: { focus: APP_PKG, expanded: [CORE, BETA_PKG] },
    call: { focus: null, expanded: [] },
  });

  it.each([...MODULE_SURFACE_MODES])("%s: the off-canvas dep and caller ghost with the SAME real node ids", (mode) => {
    const tree = deriveFor(spec(mode), INDEX, CACHES, offCanvas(mode));
    expect(ghostIdsOf(tree)).toEqual([APP_FN, BETA].sort());
    const ghostEdges = tree.edges.filter((e) => e.ghost === true);
    expect(ghostEdges.length).toBeGreaterThan(0);
    expect(ghostEdges.every((edge) => edge.outsideView === true)).toBe(true);
    // The dependency ghosts as the wire's TARGET; the caller ghosts as a SOURCE — on every surface.
    expect(ghostEdges.some((e) => e.target === BETA)).toBe(true);
    expect(ghostEdges.some((e) => e.source === APP_FN)).toBe(true);
    // Ghost cards are always detached (root-level) and their ids are REAL artifact ids.
    for (const ghost of tree.nodes.filter((n) => n.kind === "ghost")) {
      expect(ghost.parentId).toBeNull();
      expect(INDEX.nodesById.has(ghost.id)).toBe(true);
    }
  });

  it.each([...MODULE_SURFACE_MODES])("%s: no ghost when the facts are drawn (wires/frame wires instead)", (mode) => {
    const tree = deriveFor(spec(mode), INDEX, CACHES, allDrawn(mode));
    expect(ghostIdsOf(tree)).toEqual([]);
    expect(tree.edges.every((edge) => edge.outsideView === false)).toBe(true);
  });

  it.each([...MODULE_SURFACE_MODES])("%s: every coupling fact touching the canvas is represented — never dropped", (mode) => {
    for (const arrangement of [offCanvas(mode), allDrawn(mode)]) {
      expect(unrepresentedFacts(deriveFor(spec(mode), INDEX, CACHES, arrangement), INDEX)).toEqual([]);
    }
  });
});

describe("EXPAND/COLLAPSE — the same container id toggles the same delta and charts the same children", () => {
  // Alpha.run is a flow-block container on EVERY surface (the shared codeWalk charts its steps).
  const base = perSurface<Arrangement>({
    modules: { focus: CORE, expanded: [A_FILE, ALPHA] },
    ui: { focus: CORE, expanded: [A_FILE, ALPHA] },
    call: { focus: SVC_ALPHA, expanded: [] },
  });

  it.each([...MODULE_SURFACE_MODES])("%s: toggling Alpha.run's flow block", (mode) => {
    const store = freshStore();
    const arrangement = base(mode);
    store.setState({ viewMode: mode, moduleFocus: arrangement.focus, moduleExpanded: new Set(arrangement.expanded) });
    // The container is drawn (collapsed) before the toggle.
    const before = deriveFor(spec(mode), INDEX, CACHES, arrangement);
    const block = before.nodes.find((n) => n.id === ALPHA_RUN);
    expect(block?.isContainer).toBe(true);
    expect(block?.isExpanded).toBe(false);
    // The SAME store action produces the SAME moduleExpanded delta on every surface…
    store.getState().toggleModuleExpand(ALPHA_RUN);
    const added = [...store.getState().moduleExpanded].filter((id) => !arrangement.expanded.includes(id));
    expect(added).toEqual([ALPHA_RUN]);
    // …and the derived tree charts the SAME children under it.
    const after = deriveFor(spec(mode), INDEX, CACHES, { ...arrangement, expanded: [...store.getState().moduleExpanded] });
    expect(after.nodes.find((n) => n.id === ALPHA_RUN)?.isExpanded).toBe(true);
    expect(after.nodes.filter((n) => n.parentId === ALPHA_RUN).map((n) => n.id)).toEqual([`step:${ALPHA_RUN}:0`, `step:${ALPHA_RUN}:1`]);
    // Toggling back restores the exact prior set.
    store.getState().toggleModuleExpand(ALPHA_RUN);
    expect(store.getState().moduleExpanded).toEqual(new Set(arrangement.expanded));
  });
});

describe("FOCUS — spec.focus.dive lands effectiveFocus + crumbs; clearing restores the root", () => {
  const dive = perSurface<{ id: string; nodeType: string; rootLabel: string; trail: string[] }>({
    modules: { id: CORE, nodeType: "package", rootLabel: "Repository", trail: ["app", "core"] },
    ui: { id: CORE, nodeType: "package", rootLabel: "UI", trail: ["app", "core"] },
    call: { id: SVC_ALPHA, nodeType: "package", rootLabel: "All services", trail: ["AlphaService"] },
  });

  it.each([...MODULE_SURFACE_MODES])("%s: dive, crumb trail, and clear", async (mode) => {
    const store = freshStore();
    store.setState({ viewMode: mode });
    const surface = spec(mode);
    const target = dive(mode);
    expect(surface.focus.rootLabel).toBe(target.rootLabel);
    expect(surface.focus.divable(target.nodeType, target.id)).toBe(true);
    expect(surface.focus.dive).not.toBeNull();
    surface.focus.dive!(store.getState(), target.id);
    await store.getState().moduleRelayout();
    const effective = store.getState().moduleEffectiveFocus;
    expect(effective).toBe(target.id);
    // The WHOLE trail, not endpoints — a junk middle segment must fail, on any surface.
    const crumbs = surface.focus.crumbs(effective, store.getState().index);
    expect(crumbs.map((crumb) => crumb.label)).toEqual(target.trail);
    // Clearing the focus (the breadcrumb's root segment) restores the surface's root level.
    store.getState().setModuleFocus(null);
    await store.getState().moduleRelayout();
    expect(store.getState().moduleEffectiveFocus).toBeNull();
    expect(surface.focus.crumbs(null, store.getState().index)).toEqual([]);
  });

  it.each([...MODULE_SURFACE_MODES])("%s: a ghost card is never divable (it reveals through the spec instead)", (mode) => {
    expect(spec(mode).focus.divable("ghost", BETA)).toBe(false);
  });
});

describe("MINIMAL SEEDS — the same selection lands the overlay on the same home files", () => {
  it.each([...MODULE_SURFACE_MODES])("%s: a FILE selection seeds itself verbatim", (mode) => {
    expect(spec(mode).minimalSeeds([A_FILE], INDEX)).toEqual([A_FILE]);
  });

  it("a UNIT selection resolves to the SAME home file on every surface", () => {
    for (const mode of MODULE_SURFACE_MODES) {
      const seeds = spec(mode).minimalSeeds([ALPHA], INDEX);
      // The Map extracts the unit verbatim (its overlay draws the unit's card); the Service and UI
      // lenses land on the home file directly — but every surface's seeds RESOLVE to the same file.
      expect([...new Set(seeds.map((id) => homeFileOf(id, INDEX)))]).toEqual([A_FILE]);
    }
  });

  it("a svc: frame on the Service lens decomposes to its cluster members' home files", () => {
    expect(spec("call").minimalSeeds([SVC_ALPHA], INDEX).sort()).toEqual([A_FILE, STORE_FILE].sort());
    // …which is exactly where the same units seed from the UI lens — same files, any lens.
    expect(spec("ui").minimalSeeds([ALPHA, ORDER], INDEX).sort()).toEqual([A_FILE, STORE_FILE].sort());
  });
});

describe("PROMOTION — the ghost '+' pins the same home file into mapExtra on every surface", () => {
  it.each([...MODULE_SURFACE_MODES])("%s: pinning the dep ghost and the caller ghost", (mode) => {
    const store = freshStore();
    store.setState({ viewMode: mode });
    store.getState().promoteGhost(BETA);
    expect([...store.getState().mapExtra]).toEqual([B_FILE]);
    store.getState().promoteGhost(APP_FN);
    expect([...store.getState().mapExtra].sort()).toEqual([APP_FILE, B_FILE].sort());
    // Pinning the same ghost twice is a no-op — the pin set never duplicates.
    store.getState().promoteGhost(BETA);
    expect(store.getState().mapExtra.size).toBe(2);
  });

  it("off the module surfaces the gesture is refused outright — never a stray pin", () => {
    for (const mode of ALL_VIEW_MODES.filter((m) => !MODULE_SURFACE_MODES.includes(m))) {
      const store = freshStore();
      store.setState({ viewMode: mode });
      store.getState().promoteGhost(BETA);
      expect(store.getState().mapExtra.size, `mode "${mode}"`).toBe(0);
    }
  });
});
