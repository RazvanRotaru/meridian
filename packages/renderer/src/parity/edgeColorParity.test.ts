/**
 * EDGE-COLOUR parity (unified-canvas phase E): the same relationship kind wears the same stroke on
 * every registry surface. Driven through the REAL chain — each spec's deriveTree → the canonical
 * `layoutModuleTree` → the shared paint (`paintMinimalLevel`, exactly what GraphSurface runs) —
 * and asserted against the one palette (`theme/mapPalette` REL_COLORS + the UI lens's RENDERS_WIRE
 * and the import golds), so a surface can never fork a wire colour silently.
 *
 * A second case runs the wire-legibility passes GraphSurface applies AFTER the paint — salience
 * fade → cycle fusion → pair-ribbon fold — and asserts those aggregates (a fused cycle, a folded
 * ribbon's member strands) keep the same pinned colours on every surface, so the newer wire work
 * can't recolour a strand or fork a lens either.
 */

import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import type { ViewMode } from "../derive/edgeSelection";
import { moduleSurfaceSpec } from "../components/canvas/surfaceSpec";
import { paintMinimalLevel } from "../components/paintMinimal";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import { fuseCycles, CYCLE_EDGE_TYPE } from "../layout/cycleFusion";
import { foldPairRibbons, RIBBON_EDGE_TYPE } from "../layout/parallelWires";
import { fadeFaintWires } from "../layout/wireSalience";
import { IMPORT_CROSS, IMPORT_SIBLING, REL_COLORS } from "../theme/mapPalette";
import { RENDERS_WIRE } from "../theme/edgeColors";
import {
  MODULE_SURFACE_MODES,
  type Arrangement,
  deriveFor,
  cachesFor,
  freshIndex,
  ALPHA, A_FILE, APP_PKG, B_FILE, BETA, BETA_PKG, CORE, ORDER, PAY, PAY_FILE, STORE_FILE, SVC_ALPHA, SVC_BETA, UI_PKG,
} from "./surfaceFixture";

const INDEX = freshIndex();
const CACHES = cachesFor(INDEX);

// Deep-expanded states so typed dep wires (calls / instantiates / references), imports, and — on
// the UI lens — renders wires are all on canvas at once.
const DRAWN_DEEP: Record<string, Arrangement> = {
  modules: { focus: APP_PKG, expanded: [CORE, BETA_PKG, A_FILE, STORE_FILE, B_FILE, PAY_FILE, ALPHA, ORDER, BETA, PAY] },
  ui: { focus: APP_PKG, expanded: [CORE, BETA_PKG, UI_PKG, A_FILE, STORE_FILE, B_FILE, PAY_FILE, ALPHA, ORDER, BETA, PAY] },
  call: { focus: null, expanded: [SVC_ALPHA, SVC_BETA] },
};

type EdgeData = { category?: string; depKind?: string; crossFrame?: boolean };
const strokeOf = (edge: Edge): string => String((edge.style as { stroke?: string } | undefined)?.stroke);

/** EVERY painted wire classifies — dep wires by exact depKind, imports by frame-crossing, and anything
 * else keeps its raw category so a new wire class FAILS the pin check instead of escaping it. */
function wireClassOf(data: EdgeData): string {
  if (data.category === "dep") {
    return data.depKind ?? (data.crossFrame === true ? "dep-untyped-cross" : "dep-untyped-sibling");
  }
  if (data.category === "import") {
    return data.crossFrame === true ? "import-cross" : "import-sibling";
  }
  return `unclassified:${String(data.category)}`;
}

/** Classify one PIPELINE edge into its (colour-class, stroke) pairs. A folded ribbon expands into
 * its member strands (folding must never recolour a strand); a fused cycle keeps its kind, pinned
 * like a plain wire of that kind; a leaf classifies by `wireClassOf`. */
function classifyEdge(edge: Edge): Array<[string, string]> {
  if (edge.type === RIBBON_EDGE_TYPE) {
    const members = (edge.data as { members?: Edge[] } | undefined)?.members ?? [];
    return members.map((strand) => [wireClassOf((strand.data ?? {}) as EdgeData), strokeOf(strand)]);
  }
  if (edge.type === CYCLE_EDGE_TYPE) {
    return [[`cycle:${String((edge.data as { depKind?: string } | undefined)?.depKind)}`, strokeOf(edge)]];
  }
  return [[wireClassOf((edge.data ?? {}) as EdgeData), strokeOf(edge)]];
}

/** Run the surface's derived level through the REAL layout + paint chain and collect every
 * painted wire class's stroke(s) — no edge is exempt from classification. */
async function paintedStrokes(mode: ViewMode): Promise<Map<string, Set<string>>> {
  const tree = deriveFor(moduleSurfaceSpec(mode)!, INDEX, CACHES, DRAWN_DEEP[mode]);
  const laid = await layoutModuleTree(tree.nodes, tree.edges);
  const painted = paintMinimalLevel(laid.nodes, laid.edges, new Set<string>(), 2, "reach");
  const byKind = new Map<string, Set<string>>();
  for (const edge of painted.edges) {
    const kind = wireClassOf((edge.data ?? {}) as EdgeData);
    const strokes = byKind.get(kind) ?? new Set<string>();
    strokes.add(strokeOf(edge));
    byKind.set(kind, strokes);
  }
  return byKind;
}

describe("EDGE COLOURS — one palette, every surface", () => {
  it("paints each relationship kind with the palette colour on every surface it appears on", async () => {
    const observed = new Map<string, Map<string, Set<string>>>();
    for (const mode of MODULE_SURFACE_MODES) {
      observed.set(mode, await paintedStrokes(mode));
    }
    const expected: Record<string, string> = {
      calls: REL_COLORS.calls,
      instantiates: REL_COLORS.instantiates,
      references: REL_COLORS.references,
      renders: RENDERS_WIRE,
      "import-cross": IMPORT_CROSS,
      "import-sibling": IMPORT_SIBLING,
    };
    for (const [mode, byKind] of observed) {
      for (const [kind, strokes] of byKind) {
        expect(expected[kind], `surface "${mode}" painted an unpinned kind "${kind}"`).toBeDefined();
        expect([...strokes], `surface "${mode}", kind "${kind}"`).toEqual([expected[kind]]);
      }
    }
    // Every shared kind is exercised on more than one surface. The Service overview is now an
    // architectural projection: collapsed semantic/Unassigned parents legitimately hide a pair
    // that remains drawn in Map/UI, so parity is “same kind, same colour wherever present.”
    for (const kind of ["calls", "instantiates", "references"]) {
      const surfaceCount = [...observed.values()].filter((kinds) => kinds.has(kind)).length;
      expect(surfaceCount, `"${kind}" was not exercised across surfaces`).toBeGreaterThanOrEqual(2);
    }
    // …renders is the UI lens's projection (its cyan identity), imports the folder lenses' backdrop,
    // and the Service lens preserves exact relationship kinds (no untyped aggregate).
    expect(observed.get("ui")!.has("renders")).toBe(true);
    expect(observed.get("modules")!.has("import-cross")).toBe(true);
    expect(observed.get("modules")!.has("import-sibling")).toBe(true);
    expect(observed.get("call")!.has("calls")).toBe(true);
    expect(observed.get("call")!.size).toBeGreaterThan(0);
    // Cross-surface equality: any kind two surfaces both draw wears the identical stroke.
    for (const [modeA, kindsA] of observed) {
      for (const [modeB, kindsB] of observed) {
        for (const [kind, strokes] of kindsA) {
          if (kindsB.has(kind)) {
            expect([...kindsB.get(kind)!], `${kind} differs between ${modeA} and ${modeB}`).toEqual([...strokes]);
          }
        }
      }
    }
  });

  // GraphSurface runs three more passes AFTER paintMinimalLevel (highways off): salience fade
  // (opacity only) → cycle fusion → pair-ribbon fold. They must not recolour a wire, and no surface
  // may fork the result — the same one-palette contract as above, one pipeline layer deeper.
  it("cycle fusion + ribbon folding keep every strand on its palette colour, on every surface", async () => {
    const observed = new Map<string, Map<string, Set<string>>>();
    let ribbons = 0;
    for (const mode of MODULE_SURFACE_MODES) {
      const tree = deriveFor(moduleSurfaceSpec(mode)!, INDEX, CACHES, DRAWN_DEEP[mode]);
      const laid = await layoutModuleTree(tree.nodes, tree.edges);
      const painted = paintMinimalLevel(laid.nodes, laid.edges, new Set<string>(), 2, "reach");
      // The exact GraphSurface highways-off edge pipeline.
      const folded = foldPairRibbons(fuseCycles(fadeFaintWires(painted.edges)));
      ribbons += folded.filter((edge) => edge.type === RIBBON_EDGE_TYPE).length;
      const byKind = new Map<string, Set<string>>();
      for (const edge of folded) {
        for (const [kind, stroke] of classifyEdge(edge)) {
          const strokes = byKind.get(kind) ?? new Set<string>();
          strokes.add(stroke);
          byKind.set(kind, strokes);
        }
      }
      observed.set(mode, byKind);
    }
    const expected: Record<string, string> = {
      calls: REL_COLORS.calls,
      instantiates: REL_COLORS.instantiates,
      references: REL_COLORS.references,
      renders: RENDERS_WIRE,
      "import-cross": IMPORT_CROSS,
      "import-sibling": IMPORT_SIBLING,
      // A fused cycle keeps its kind's colour — same pin as the plain wire it folds.
      "cycle:calls": REL_COLORS.calls,
      "cycle:instantiates": REL_COLORS.instantiates,
      "cycle:references": REL_COLORS.references,
    };
    for (const [mode, byKind] of observed) {
      for (const [kind, strokes] of byKind) {
        expect(expected[kind], `surface "${mode}" painted an unpinned kind "${kind}" through the fold/fuse passes`).toBeDefined();
        expect([...strokes], `surface "${mode}", kind "${kind}"`).toEqual([expected[kind]]);
      }
    }
    // The ribbon fold is exercised in both code-oriented projections. Service's collapsed
    // architectural parents may aggregate that pair away before paint.
    expect(ribbons, "no ribbon folded — the fold pass is untested").toBeGreaterThanOrEqual(2);
    // Cross-surface: any class two surfaces both draw wears the identical stroke.
    for (const [modeA, kindsA] of observed) {
      for (const [modeB, kindsB] of observed) {
        for (const [kind, strokes] of kindsA) {
          if (kindsB.has(kind)) {
            expect([...kindsB.get(kind)!], `${kind} differs between ${modeA} and ${modeB}`).toEqual([...strokes]);
          }
        }
      }
    }
    // Cycle-fusion colour preservation. The shared fixture has no mutual same-kind pair by design —
    // its one cross-cluster `calls` edge is load-bearing for surfaceParity's ghost/coupling facts,
    // and reversing it perturbs them — so fuse a REAL painted `calls` strand with its mirror and
    // assert the fused cycle keeps the kind's palette colour.
    const mods = deriveFor(moduleSurfaceSpec("modules")!, INDEX, CACHES, DRAWN_DEEP.modules);
    const laidMods = await layoutModuleTree(mods.nodes, mods.edges);
    const paintedMods = paintMinimalLevel(laidMods.nodes, laidMods.edges, new Set<string>(), 2, "reach");
    const callsLeaf = paintedMods.edges.find((edge) => wireClassOf((edge.data ?? {}) as EdgeData) === "calls");
    expect(callsLeaf, "fixture drew no plain calls wire to fuse").toBeDefined();
    const mirror: Edge = { ...callsLeaf!, id: `${callsLeaf!.id}:mirror`, source: callsLeaf!.target, target: callsLeaf!.source };
    const fused = fuseCycles([callsLeaf!, mirror]).find((edge) => edge.type === CYCLE_EDGE_TYPE);
    expect(fused, "fuseCycles did not fuse a mutual same-kind pair").toBeDefined();
    expect(strokeOf(fused!)).toBe(REL_COLORS.calls);
  });
});
