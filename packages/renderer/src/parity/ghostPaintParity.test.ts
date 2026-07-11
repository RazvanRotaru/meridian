/**
 * Selection-driven GHOST parity at the shared canvas boundary. Each registry surface and the
 * minimal overlay derive and lay out their own graph shape, but GraphSurface paints every one
 * through `paintMinimalLevel`: no selection must prune the whole off-view ring, and selecting the
 * same dependency anchor must reveal the same incident real ghost ids.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { moduleSurfaceSpec } from "../components/canvas/surfaceSpec";
import { paintMinimalLevel } from "../components/paintMinimal";
import { layoutModuleTree } from "../layout/moduleLevelLayout";
import { deriveMinimalGraphLayout } from "../state/deriveMinimalGraphLayout";
import {
  MODULE_SURFACE_MODES,
  type Arrangement,
  deriveFor,
  cachesFor,
  freshIndex,
  A_FILE,
  APP_FN,
  BETA,
  CORE,
  STORE_FILE,
  SVC_ALPHA,
} from "./surfaceFixture";

const INDEX = freshIndex();
const CACHES = cachesFor(INDEX);

const OFF_CANVAS: Record<string, Arrangement> = {
  modules: { focus: CORE, expanded: [] },
  ui: { focus: CORE, expanded: [] },
  call: { focus: SVC_ALPHA, expanded: [] },
};

type LaidSurface = { label: string; nodes: Node[]; edges: Edge[] };

const isGhostEdge = (edge: Edge): boolean => (edge.data as { ghost?: boolean } | undefined)?.ghost === true;
const ghostIds = (nodes: Node[]): string[] => nodes.filter((node) => node.type === "ghost").map((node) => node.id).sort();

async function laidSurfaces(): Promise<LaidSurface[]> {
  const registry = await Promise.all(
    MODULE_SURFACE_MODES.map(async (mode) => {
      const tree = deriveFor(moduleSurfaceSpec(mode)!, INDEX, CACHES, OFF_CANVAS[mode]);
      return { label: mode, ...(await layoutModuleTree(tree.nodes, tree.edges)) };
    }),
  );
  // Match the CORE-focused lenses' drawn member frontier. Keeping store.ts in the member set makes
  // Alpha→Order an on-view member wire, leaving the same two truly off-view facts on every row:
  // App→Alpha (caller ghost) and Alpha→Beta (dependency ghost).
  const minimal = await deriveMinimalGraphLayout(
    INDEX,
    CACHES.graph,
    new Set([A_FILE, STORE_FILE]),
    new Set([A_FILE, STORE_FILE]),
    {
      [A_FILE]: { x: 0, y: 0, width: 210, height: 54 },
      [STORE_FILE]: { x: 400, y: 0, width: 210, height: 54 },
    },
    { moduleExpanded: new Set(), blockDeps: CACHES.deps, flows: CACHES.flows },
  );
  return [...registry, { label: "minimal", ...minimal }];
}

it("Map, Service, UI, and Minimal share selection-driven ghost pruning and reveal", async () => {
  const revealedBySurface = new Map<string, string[]>();
  for (const laid of await laidSurfaces()) {
    const rawGhosts = new Set(ghostIds(laid.nodes));
    expect([...rawGhosts], `${laid.label}: fixture did not derive the shared ghost ring`).toEqual([APP_FN, BETA].sort());

    const atRest = paintMinimalLevel(laid.nodes, laid.edges, new Set(), 1, "reach");
    expect(ghostIds(atRest.nodes), `${laid.label}: ghosts remained visible without a selection`).toEqual([]);
    expect(atRest.edges.filter(isGhostEdge), `${laid.label}: ghost wires remained visible without a selection`).toEqual([]);

    const betaWire = laid.edges.find((edge) => isGhostEdge(edge) && edge.target === BETA);
    expect(betaWire, `${laid.label}: missing Alpha→Beta ghost wire`).toBeDefined();
    const anchor = betaWire!.source;
    const incidentGhosts = new Set<string>();
    for (const edge of laid.edges.filter(isGhostEdge)) {
      if (edge.source === anchor && rawGhosts.has(edge.target)) incidentGhosts.add(edge.target);
      if (edge.target === anchor && rawGhosts.has(edge.source)) incidentGhosts.add(edge.source);
    }

    const selected = paintMinimalLevel(laid.nodes, laid.edges, new Set([anchor]), 1, "reach");
    const revealed = ghostIds(selected.nodes);
    expect(revealed, `${laid.label}: selection did not reveal exactly its incident ghosts`).toEqual([...incidentGhosts].sort());
    expect(revealed, `${laid.label}: dependency ghost was not revealed`).toContain(BETA);
    expect(selected.edges.filter(isGhostEdge).every((edge) => edge.source === anchor || edge.target === anchor), `${laid.label}: unrelated ghost wire survived`).toBe(true);
    revealedBySurface.set(laid.label, revealed);
  }

  const outcomes = [...revealedBySurface.values()].map((ids) => ids.join("\0"));
  expect(new Set(outcomes).size, `surface outcomes diverged: ${JSON.stringify(Object.fromEntries(revealedBySurface))}`).toBe(1);
});

it("the Map and Minimal mounts delegate React Flow and paint to GraphSurface", () => {
  for (const component of ["ModuleMapView.tsx", "MinimalGraphView.tsx"]) {
    const source = readFileSync(fileURLToPath(new URL(`../components/${component}`, import.meta.url)), "utf8");
    expect(source, `${component}: missing the shared surface import`).toMatch(
      /import\s*\{[^}]*\bGraphSurface\b[^}]*\}\s*from "\.\/canvas\/GraphSurface";/s,
    );
    expect(source, `${component}: does not mount the shared surface`).toContain("<GraphSurface");
    expect(source, `${component}: runs the shared painter directly`).not.toMatch(/\bpaintMinimalLevel\s*\(/);
    expect(source, `${component}: mounts ReactFlow directly`).not.toMatch(/<ReactFlow(?:\s|>)/);
    const xyflowImports = source.match(/^import .* from "@xyflow\/react";$/gm) ?? [];
    expect(xyflowImports.every((statement) => statement.startsWith("import type ")), `${component}: has a runtime React Flow import`).toBe(true);
  }
});
