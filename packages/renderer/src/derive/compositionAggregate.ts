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
import { clusterLabel, groupUnderRoot } from "./compositionClusters";
import type { CompEdgeSpec, CompNodeSpec } from "./compositionGraph";

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
  rootId: string | null,
): { nodes: CompNodeSpec[]; edges: CompEdgeSpec[] } {
  const pkgOfUnit = new Map<string, string>();
  const rollup = new Map<string, PackageSummaryData>();
  for (const metric of metrics.values()) {
    if (!survivors.has(metric.id)) {
      continue;
    }
    const pkgId = groupUnderRoot(metric.id, rootId, nodesById);
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

  // IPC at the overview altitude COLLAPSES to package→package wires: 400+ channel cards would both
  // freeze the canvas and drown the signal. Each channel's sender packages × handler packages become
  // one gold edge per pair; the individual channel cards return when you drill into a package.
  for (const edge of ipcPackageEdges(edges, emittedPkgs, nodesById, rootId)) {
    edgeSpecs.set(edge.id, edge);
  }
  return { nodes: nodeSpecs, edges: [...edgeSpecs.values()] };
}

/** Collapse every channel into direct sender-package → handler-package IPC edges (deduped). */
function ipcPackageEdges(
  edges: GraphEdge[],
  emitted: ReadonlySet<string>,
  nodesById: Map<string, GraphNode>,
  rootId: string | null,
): CompEdgeSpec[] {
  const sendersByChannel = new Map<string, Set<string>>();
  const handlersByChannel = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "sends" && edge.kind !== "handles") {
      continue;
    }
    const channelId = edge.kind === "sends" ? edge.target : edge.source;
    const pkg = resolvePackage(edge.kind === "sends" ? edge.source : edge.target, emitted, nodesById, rootId);
    if (!pkg) {
      continue;
    }
    const map = edge.kind === "sends" ? sendersByChannel : handlersByChannel;
    (map.get(channelId) ?? map.set(channelId, new Set()).get(channelId)!).add(pkg);
  }
  const out = new Map<string, CompEdgeSpec>();
  for (const [channelId, senders] of sendersByChannel) {
    for (const from of senders) {
      for (const to of handlersByChannel.get(channelId) ?? []) {
        if (from === to) {
          continue; // an intra-package channel is drill-down detail, not an overview wire.
        }
        const id = `ipc:${from}->${to}`;
        out.set(id, { id, source: from, target: to, inheritanceOnly: false, crossBoundary: true, ipc: true });
      }
    }
  }
  return [...out.values()];
}

function emptySummary(pkgId: string, nodesById: Map<string, GraphNode>): PackageSummaryData {
  return { packageId: pkgId, label: clusterLabel(pkgId, nodesById), unitCount: 0, memberCount: 0, smellyCount: 0, worstDistance: 0 };
}

function packageCard(data: PackageSummaryData): CompNodeSpec {
  return { id: data.packageId, type: "package", width: PKG_CARD_WIDTH, height: PKG_CARD_HEIGHT, data };
}

/** Resolve any graph node to the emitted group card it rolls up to (one level below the root). */
function resolvePackage(nodeId: string, emitted: ReadonlySet<string>, nodesById: Map<string, GraphNode>, rootId: string | null): string | null {
  const pkg = groupUnderRoot(nodeId, rootId, nodesById);
  return emitted.has(pkg) ? pkg : null;
}
