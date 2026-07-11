/**
 * The ELK-options IDENTITY lock (unified-canvas phase E, "make sure those elk options are never
 * used again"): every layout pass reachable from a SurfaceSpec — the spec's deriveTree through the
 * canonical `layoutModuleTree`, and the store's `moduleRelayout` on each registry surface — hands
 * ELK the ONE canonical root-options object, `CANVAS_ROOT_ELK_OPTIONS`, BY OBJECT IDENTITY. A
 * forked near-copy (the bug that dropped `elk.aspectRatio` and collapsed the UI lens into a single
 * column) can never come back silently: the spy below fails on any non-identical root options, and
 * the source scan pins WHICH files may even spell an `"elk.algorithm"` literal.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CANVAS_ROOT_ELK_OPTIONS } from "../layout/elkCanvasOptions";
import { runElkLayout } from "../layout/elkLayout";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import { moduleSurfaceSpec } from "../components/canvas/surfaceSpec";
import {
  MODULE_SURFACE_MODES,
  type Arrangement,
  deriveFor,
  cachesFor,
  freshIndex,
  freshStore,
  A_FILE, ALPHA, CORE, SVC_ALPHA,
} from "./surfaceFixture";

// Wrap the one ELK entry point so every layout pass in this suite records the ROOT graph it was
// handed — layoutModuleTree and the store's moduleRelayout import this same module.
vi.mock("../layout/elkLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../layout/elkLayout")>();
  return { ...actual, runElkLayout: vi.fn(actual.runElkLayout) };
});

const INDEX = freshIndex();
const CACHES = cachesFor(INDEX);

const ARRANGEMENTS: Record<string, Arrangement> = {
  modules: { focus: CORE, expanded: [A_FILE, ALPHA] },
  ui: { focus: null, expanded: [] },
  call: { focus: SVC_ALPHA, expanded: [] },
};

describe("ELK identity — one canonical root-options object for every surface", () => {
  it("every spec's layout path and every store relayout passes CANVAS_ROOT_ELK_OPTIONS by identity", async () => {
    const spy = vi.mocked(runElkLayout);
    spy.mockClear();
    // The direct path: each registry spec's derived tree through the canonical layout.
    for (const mode of MODULE_SURFACE_MODES) {
      await layoutModuleTree(...treeArgs(mode));
    }
    // The store path: moduleRelayout on each registry surface (the app's actual relayout route).
    for (const mode of MODULE_SURFACE_MODES) {
      const store = freshStore();
      store.setState({ viewMode: mode });
      await store.getState().moduleRelayout();
    }
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(MODULE_SURFACE_MODES.length * 2);
    for (const [graph] of spy.mock.calls) {
      // toBe — the REFERENCE, not a value copy: a derived/spread near-copy must fail here.
      expect(graph.layoutOptions).toBe(CANVAS_ROOT_ELK_OPTIONS);
    }
  });

  it("the canonical options carry the component-packing knob whose loss caused the column bug", () => {
    expect(CANVAS_ROOT_ELK_OPTIONS["elk.aspectRatio"]).toBe("1.6");
    expect(CANVAS_ROOT_ELK_OPTIONS["elk.hierarchyHandling"]).toBe("INCLUDE_CHILDREN");
  });
});

function treeArgs(mode: string): [Parameters<typeof layoutModuleTree>[0], Parameters<typeof layoutModuleTree>[1]] {
  const tree = deriveFor(moduleSurfaceSpec(mode as never)!, INDEX, CACHES, ARRANGEMENTS[mode]);
  return [tree.nodes, tree.edges];
}

describe("ELK root-option literals — the source scan", () => {
  // The ONLY production modules allowed to spell an "elk.algorithm" literal. The canvas surfaces
  // (Map / Service / UI / minimal overlay's per-file nesting) all import CANVAS_ROOT_ELK_OPTIONS;
  // the remaining four are standalone NON-canvas passes with deliberately different options:
  //   - layout/logicElk.ts        the Logic lens's own render (out of unification scope, PR #116)
  //   - layout/compositionElk.ts  the composition scorecards (Toolbar side surface)
  //   - layout/minimalArrange.ts  the overlay's "Re-arrange": a fresh flat pass, wider layers
  //   - layout/minimalReflow.ts   the overlay's expansion reflow: INTERACTIVE, position-seeded
  // This list may only ever SHRINK. Adding a file here to ship a new root config is the exact
  // regression this test exists to block — derive from elkCanvasOptions.ts instead.
  const ALLOWED = [
    "layout/compositionElk.ts",
    "layout/elkCanvasOptions.ts",
    "layout/logicElk.ts",
    "layout/minimalArrange.ts",
    "layout/minimalReflow.ts",
  ];

  it('pins every "elk.algorithm" literal to the known standalone passes + the one canon', () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const needle = `"elk${".algorithm"}"`; // split so this test file can never match its own scan
    const offenders: string[] = [];
    for (const entry of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
        continue;
      }
      const path = join(entry.parentPath, entry.name);
      if (readFileSync(path, "utf8").includes(needle)) {
        offenders.push(relative(srcRoot, path));
      }
    }
    expect(offenders.sort()).toEqual(ALLOWED);
  });
});
