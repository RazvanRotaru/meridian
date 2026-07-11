/**
 * The ONE shared fixture graph the cross-lens parity suite runs every surface against (unified
 * canvas phase E). Shaped so each registry surface has substance:
 *
 *   - TWO service clusters (AlphaService owning OrderStore; BetaService owning PayStore) — the
 *     Service lens's frames — plus the ui folder's synthetic component cluster;
 *   - ONE folder with two files (`app/core`: a.ts + store.ts) — the Map's containment level;
 *   - a component RENDERING another (App → Widget) — the UI lens's projection;
 *   - deps to OFF-LEVEL/unclustered targets (Alpha.run → Beta.run across folders; the App
 *     component calling into Alpha) — the ghost tier's raw material;
 *   - a TEST-TAGGED file (`app/tests/a.test.ts`) — the hidden-tests path;
 *   - a logic flow on Alpha.run — the expandable flow-block every surface charts alike.
 *
 * Also home to the parity helpers: the registry-driven mode list, per-spec tree derivation, and
 * the HONESTY checker (every coupling fact touching the canvas is represented — wire, frame wire,
 * or ghost — never silently dropped).
 */

import type { GraphArtifact, GraphEdge, GraphNode, LogicFlows } from "@meridian/core";
import { buildGraphIndex, type GraphIndex } from "../graph/graphIndex";
import { buildModuleGraph } from "../derive/moduleGraph";
import { buildBlockDeps } from "../derive/blockDeps";
import { clusteringFor } from "../derive/serviceClusteringCache";
import { frameIdOf } from "../derive/serviceClusterEdges";
import type { ModuleTree } from "../derive/moduleTree";
import type { ViewMode } from "../derive/edgeSelection";
import { moduleSurfaceSpec, type SurfaceCaches, type SurfaceSpec } from "../components/canvas/surfaceSpec";
import { createBlueprintStore, type BlueprintStore } from "../state/store";

export const APP_PKG = "ts:app";
export const CORE = "ts:app/core"; // the folder with two files
export const A_FILE = "ts:app/core/a.ts";
export const ALPHA = "ts:app/core/a.ts#AlphaService";
export const ALPHA_RUN = `${ALPHA}.run`;
export const STORE_FILE = "ts:app/core/store.ts";
export const ORDER = "ts:app/core/store.ts#OrderStore";
export const ORDER_LOAD = `${ORDER}.load`;
export const BETA_PKG = "ts:app/beta";
export const B_FILE = "ts:app/beta/b.ts";
export const BETA = "ts:app/beta/b.ts#BetaService";
export const BETA_RUN = `${BETA}.run`;
export const PAY_FILE = "ts:app/beta/pay.ts";
export const PAY = "ts:app/beta/pay.ts#PayStore";
export const PAY_CHARGE = `${PAY}.charge`;
export const UI_PKG = "ts:app/ui";
export const APP_FILE = "ts:app/ui/App.tsx";
export const APP_FN = "ts:app/ui/App.tsx#App";
export const WIDGET_FILE = "ts:app/ui/Widget.tsx";
export const WIDGET_FN = "ts:app/ui/Widget.tsx#Widget";
export const TESTS_PKG = "ts:app/tests";
export const TEST_FILE = "ts:app/tests/a.test.ts";

export const SVC_ALPHA = frameIdOf(ALPHA);
export const SVC_BETA = frameIdOf(BETA);

function node(id: string, kind: string, parentId: string | null, displayName: string, file: string, tags?: string[]): GraphNode {
  return { id, kind, qualifiedName: id, displayName, parentId, location: { file, startLine: 1 }, ...(tags ? { tags } : {}) } as GraphNode;
}

function edge(kind: string, source: string, target: string): GraphEdge {
  return { id: `${kind}:${source}->${target}`, source, target, kind, resolution: "resolved" } as GraphEdge;
}

const NODES: GraphNode[] = [
  node(APP_PKG, "package", null, "app", "app"),
  node(CORE, "package", APP_PKG, "core", "app/core"),
  node(A_FILE, "module", CORE, "a.ts", "app/core/a.ts"),
  node(ALPHA, "class", A_FILE, "AlphaService", "app/core/a.ts"),
  node(ALPHA_RUN, "method", ALPHA, "run", "app/core/a.ts"),
  node(STORE_FILE, "module", CORE, "store.ts", "app/core/store.ts"),
  node(ORDER, "class", STORE_FILE, "OrderStore", "app/core/store.ts"),
  node(ORDER_LOAD, "method", ORDER, "load", "app/core/store.ts"),
  node(BETA_PKG, "package", APP_PKG, "beta", "app/beta"),
  node(B_FILE, "module", BETA_PKG, "b.ts", "app/beta/b.ts"),
  node(BETA, "class", B_FILE, "BetaService", "app/beta/b.ts"),
  node(BETA_RUN, "method", BETA, "run", "app/beta/b.ts"),
  node(PAY_FILE, "module", BETA_PKG, "pay.ts", "app/beta/pay.ts"),
  node(PAY, "class", PAY_FILE, "PayStore", "app/beta/pay.ts"),
  node(PAY_CHARGE, "method", PAY, "charge", "app/beta/pay.ts"),
  node(UI_PKG, "package", APP_PKG, "ui", "app/ui"),
  node(APP_FILE, "module", UI_PKG, "App.tsx", "app/ui/App.tsx"),
  node(APP_FN, "function", APP_FILE, "App", "app/ui/App.tsx"),
  node(WIDGET_FILE, "module", UI_PKG, "Widget.tsx", "app/ui/Widget.tsx"),
  node(WIDGET_FN, "function", WIDGET_FILE, "Widget", "app/ui/Widget.tsx"),
  node(TESTS_PKG, "package", APP_PKG, "tests", "app/tests"),
  node(TEST_FILE, "module", TESTS_PKG, "a.test.ts", "app/tests/a.test.ts", ["test"]),
];

/** The coupling facts (the honest-representation checker's ground truth) — see COUPLING_FACTS. */
const COUPLING_EDGES: GraphEdge[] = [
  edge("calls", ALPHA_RUN, BETA_RUN), // the cross-folder, cross-cluster fact every ghost case uses
  edge("calls", ALPHA_RUN, ORDER_LOAD),
  edge("instantiates", ALPHA_RUN, ORDER),
  edge("references", ALPHA_RUN, ORDER),
  edge("calls", BETA_RUN, PAY_CHARGE),
  edge("calls", APP_FN, ALPHA_RUN), // a component calling into a service (off the render tree)
];

const EDGES: GraphEdge[] = [
  edge("imports", A_FILE, STORE_FILE), // sibling import (same folder)
  edge("imports", A_FILE, B_FILE), // cross-folder import
  edge("imports", B_FILE, PAY_FILE),
  edge("imports", APP_FILE, WIDGET_FILE),
  edge("imports", TEST_FILE, A_FILE),
  edge("renders", APP_FN, WIDGET_FN), // the component tree (the UI lens's projection)
  ...COUPLING_EDGES,
];

/** Alpha.run's charted logic — the flow-BLOCK container every surface expands the same way. */
export const FLOWS: LogicFlows = {
  [ALPHA_RUN]: [
    { kind: "call", label: "load", target: ORDER_LOAD, resolution: "resolved" },
    { kind: "call", label: "audit", target: null, resolution: "unresolved" },
  ],
} as unknown as LogicFlows;

export const ARTIFACT = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-10T00:00:00.000Z",
  generator: { name: "parity-fixture", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: NODES,
  edges: EDGES,
  extensions: { logicFlow: FLOWS },
} as unknown as GraphArtifact;

export function freshIndex(): GraphIndex {
  return buildGraphIndex(ARTIFACT);
}

export function cachesFor(index: GraphIndex): SurfaceCaches {
  return { graph: buildModuleGraph(index), deps: buildBlockDeps(index), flows: FLOWS };
}

export function freshStore(): BlueprintStore {
  const index = freshIndex();
  return createBlueprintStore({ artifact: ARTIFACT, index, provider: null, hasOverlay: false, sourceUrl: null, prsUrl: "", prFilesUrl: "", prReviewUrl: "" });
}

/** Every ViewMode — exhaustive BY TYPE: a lens added to the `ViewMode` union fails typecheck here
 * until it joins this record, and through the registry filter below, the parity table. */
const EVERY_VIEW_MODE: Record<ViewMode, true> = { call: true, ui: true, logic: true, modules: true, prs: true };
export const ALL_VIEW_MODES = Object.keys(EVERY_VIEW_MODE) as readonly ViewMode[];

/** The registry's module surfaces (the parity table's rows), in registry order. */
export const MODULE_SURFACE_MODES: readonly ViewMode[] = ALL_VIEW_MODES.filter((mode) => moduleSurfaceSpec(mode) !== null);

/** A surface's canvas state for one parity case: the shared focus slot + expansion set. */
export interface Arrangement {
  focus: string | null;
  expanded: readonly string[];
}

export function deriveFor(spec: SurfaceSpec, index: GraphIndex, caches: SurfaceCaches, arrangement: Arrangement): ModuleTree {
  // `showCommons: true` mirrors the store default; on this small fixture no hub reaches the
  // demotion bar, so the parity trees are identical either way.
  return spec.deriveTree(
    { index, moduleFocus: arrangement.focus, moduleExpanded: new Set(arrangement.expanded), serviceScope: null, showCommons: true },
    caches,
  );
}

export const ghostIdsOf = (tree: ModuleTree): string[] => tree.nodes.filter((n) => n.kind === "ghost").map((n) => n.id).sort();

/** The drawn representatives of a REAL node id on a derived tree: every drawn ancestor-or-self
 * (ghost cards included — their ids are real artifact ids) plus the drawn `svc:` frame of any
 * cluster an ancestor belongs to. Empty == the id is entirely off this canvas. */
function representativesOf(id: string, tree: ModuleTree, index: GraphIndex): Set<string> {
  const drawn = new Set(tree.nodes.map((n) => n.id));
  const reps = new Set<string>();
  const { leadOf } = clusteringFor(index);
  for (const ancestor of index.ancestorsOf(id)) {
    if (drawn.has(ancestor.id)) {
      reps.add(ancestor.id);
    }
    const lead = leadOf.get(ancestor.id);
    if (lead !== undefined && drawn.has(frameIdOf(lead))) {
      reps.add(frameIdOf(lead));
    }
  }
  return reps;
}

/**
 * The honest invariant behind every surface's ghost suppression: a coupling fact with at least one
 * drawn endpoint is REPRESENTED on the canvas — as a wire between drawn cards, a cluster frame
 * wire, a wire into a ghost card, or internally (both ends inside one drawn card) — never silently
 * dropped. Returns the facts that are NOT represented (so a failure names them).
 */
export function unrepresentedFacts(tree: ModuleTree, index: GraphIndex): string[] {
  const missing: string[] = [];
  for (const fact of COUPLING_EDGES) {
    const sources = representativesOf(fact.source, tree, index);
    const targets = representativesOf(fact.target, tree, index);
    if (sources.size === 0 || targets.size === 0) {
      continue; // entirely off-canvas on one side — nothing to anchor, nothing owed.
    }
    const internal = [...sources].some((id) => targets.has(id));
    const wired = tree.edges.some((e) => sources.has(e.source) && targets.has(e.target));
    if (!internal && !wired) {
      missing.push(`${fact.kind}: ${fact.source} -> ${fact.target}`);
    }
  }
  return missing;
}
