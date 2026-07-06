/**
 * Whole-system AGGREGATION for the composition view: on a big repo, laying out one card per unit
 * (Autopilot: ~12.5k) overwhelms in-browser ELK. Instead, roll every unit up to its PACKAGE and
 * draw one summary card per package — hundreds, not thousands — with couplings and IPC hops lifted
 * to package level. Double-clicking a package roots the view there, back to unit scorecards.
 *
 * Pure: (nodes, edges, metrics, couplings) → {nodes, edges}. No React, no ELK. Only the aggregated
 * whole-system view uses this; a rooted (drilled-in) view stays at unit granularity.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import type { CouplingEdge, UnitMetrics } from "@meridian/design-metrics";
import { clusterIdOf, clusterLabel } from "./compositionClusters";
import { channelSidesOf, ipcLayerFor, type CompEdgeSpec, type CompNodeSpec } from "./compositionGraph";

/** The roll-up a package summary card shows: how many units, how many smell, the worst health. */
export type PackageSummaryData = {
  packageId: string;
  label: string;
  unitCount: number;
  memberCount: number;
  smellyCount: number;
  /** Worst (max) distance-from-main-sequence across the package's units — drives the health rail. */
  worstDistance: number;
};

const PKG_CARD_WIDTH = 232;
const PKG_CARD_HEIGHT = 92;

/**
 * Build the aggregated graph: one `package` card per package that holds ≥1 surviving unit, the
 * couplings between packages (unit couplings lifted to their packages, self-loops dropped), and the
 * IPC channel cards + wires lifted the same way. `survivors` is the whole-system unit set the
 * unaggregated path already computed, so both views agree on which units count.
 */
export function aggregateByPackage(
  edges: GraphEdge[],
  metrics: Map<string, UnitMetrics>,
  couplings: CouplingEdge[],
  survivors: ReadonlySet<string>,
  nodesById: Map<string, GraphNode>,
): { nodes: CompNodeSpec[]; edges: CompEdgeSpec[] } {
  const pkgOfUnit = new Map<string, string>();
  const rollup = new Map<string, PackageSummaryData>();
  for (const metric of metrics.values()) {
    if (!survivors.has(metric.id)) {
      continue;
    }
    const pkgId = clusterIdOf(metric.id, nodesById);
    pkgOfUnit.set(metric.id, pkgId);
    const summary = rollup.get(pkgId) ?? emptySummary(pkgId, nodesById);
    summary.unitCount += 1;
    summary.memberCount += metric.members;
    summary.worstDistance = Math.max(summary.worstDistance, metric.distance);
    if (metric.smells.length > 0) {
      summary.smellyCount += 1;
    }
    rollup.set(pkgId, summary);
  }

  const nodeSpecs: CompNodeSpec[] = [...rollup.values()].map(packageCard);
  const emittedPkgs = new Set(rollup.keys());

  // Lift each unit coupling to its package pair; drop intra-package and dropped-endpoint edges.
  const edgeSpecs = new Map<string, CompEdgeSpec>();
  for (const edge of couplings) {
    const from = pkgOfUnit.get(edge.source);
    const to = pkgOfUnit.get(edge.target);
    if (!from || !to || from === to || !emittedPkgs.has(from) || !emittedPkgs.has(to)) {
      continue;
    }
    const id = `couple:${from}->${to}`;
    if (!edgeSpecs.has(id)) {
      edgeSpecs.set(id, { id, source: from, target: to, inheritanceOnly: edge.inheritanceOnly, crossBoundary: true });
    } else if (!edge.inheritanceOnly) {
      edgeSpecs.get(id)!.inheritanceOnly = false; // a real use anywhere in the pair de-flags it
    }
  }

  // IPC lifted to packages: reuse the shared channel-projection, but resolve a function endpoint to
  // its PACKAGE (not its unit) so channel wires land on the package cards.
  const ipc = ipcLayerFor(edges, (nodeId) => resolvePackage(nodeId, emittedPkgs, nodesById), channelSidesOf(edges));
  return { nodes: [...nodeSpecs, ...ipc.nodes], edges: [...edgeSpecs.values(), ...ipc.edges] };
}

function emptySummary(pkgId: string, nodesById: Map<string, GraphNode>): PackageSummaryData {
  return { packageId: pkgId, label: clusterLabel(pkgId, nodesById), unitCount: 0, memberCount: 0, smellyCount: 0, worstDistance: 0 };
}

function packageCard(data: PackageSummaryData): CompNodeSpec {
  return { id: data.packageId, type: "package", width: PKG_CARD_WIDTH, height: PKG_CARD_HEIGHT, data };
}

/** Resolve any graph node to the emitted package it rolls up to (via nearest-package ancestor). */
function resolvePackage(nodeId: string, emitted: ReadonlySet<string>, nodesById: Map<string, GraphNode>): string | null {
  const pkg = clusterIdOf(nodeId, nodesById);
  return emitted.has(pkg) ? pkg : null;
}
