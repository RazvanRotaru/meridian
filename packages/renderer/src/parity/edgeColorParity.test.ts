/**
 * EDGE-COLOUR parity (unified-canvas phase E): the same relationship kind wears the same stroke on
 * every registry surface. Driven through the REAL chain — each spec's deriveTree → the canonical
 * `layoutModuleTree` → the shared paint (`paintMinimalLevel`, exactly what GraphSurface runs) —
 * and asserted against the one palette (`theme/mapPalette` REL_COLORS + the UI lens's RENDERS_WIRE
 * and the import golds), so a surface can never fork a wire colour silently.
 */

import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import type { ViewMode } from "../derive/edgeSelection";
import { moduleSurfaceSpec } from "../components/canvas/surfaceSpec";
import { paintMinimalLevel } from "../components/paintMinimal";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
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

/** EVERY painted wire classifies — dep wires by depKind (a KINDLESS dep is the Service lens's
 * cluster-coupling aggregate, split by frame-crossing), imports by frame-crossing, and anything
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
      // The Service lens's kindless cluster-coupling aggregate wears the SHARED cross-frame gold.
      "dep-untyped-cross": IMPORT_CROSS,
    };
    for (const [mode, byKind] of observed) {
      for (const [kind, strokes] of byKind) {
        expect(expected[kind], `surface "${mode}" painted an unpinned kind "${kind}"`).toBeDefined();
        expect([...strokes], `surface "${mode}", kind "${kind}"`).toEqual([expected[kind]]);
      }
    }
    // The typed dep kinds are actually EXERCISED everywhere (an empty map would pass vacuously)…
    for (const mode of MODULE_SURFACE_MODES) {
      for (const kind of ["calls", "instantiates", "references"]) {
        expect(observed.get(mode)!.has(kind), `surface "${mode}" never drew a "${kind}" wire`).toBe(true);
      }
    }
    // …renders is the UI lens's projection (its cyan identity), imports the folder lenses' backdrop,
    // and the Service lens's kindless coupling aggregate is exercised (not silently absent).
    expect(observed.get("ui")!.has("renders")).toBe(true);
    expect(observed.get("modules")!.has("import-cross")).toBe(true);
    expect(observed.get("modules")!.has("import-sibling")).toBe(true);
    expect(observed.get("call")!.has("dep-untyped-cross")).toBe(true);
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
});
