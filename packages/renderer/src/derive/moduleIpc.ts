/**
 * The Map lens's IPC layer. A `sends` half and a `handles` half meet on an `ipc:` channel — the JOIN
 * is the relationship worth drawing. Collapse every channel into direct sender→handler edges at their
 * REAL endpoints (deduped per ordered pair), so `liftEdges` can fold them onto the drawn level exactly
 * like the import and dependency graphs: senders/handlers inside a collapsed frame lift to that frame,
 * an intra-box channel self-loops away. Mirrors the Service-composition overview's IPC collapse.
 * Pure; no React, no ELK.
 */

import type { GraphEdge } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { liftEdges } from "./liftEdges";
import type { ModuleTreeEdge } from "./moduleTreeTypes";
import { graphEdgeCrossesPackage } from "./packageBoundary";

/** Sender→handler edges (real function ids) for every channel, deduped per ordered pair. */
export function buildIpcEdges(edges: GraphEdge[]): GraphEdge[] {
  const sendersByChannel = new Map<string, Set<string>>();
  const handlersByChannel = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "sends" && edge.kind !== "handles") {
      continue;
    }
    const channel = edge.kind === "sends" ? edge.target : edge.source;
    const fn = edge.kind === "sends" ? edge.source : edge.target;
    const map = edge.kind === "sends" ? sendersByChannel : handlersByChannel;
    (map.get(channel) ?? map.set(channel, new Set<string>()).get(channel)!).add(fn);
  }
  const byPair = new Map<string, GraphEdge>();
  for (const [channel, senders] of sendersByChannel) {
    for (const from of senders) {
      for (const to of handlersByChannel.get(channel) ?? []) {
        if (from === to) {
          continue; // an intra-unit channel is drill-down detail, not an overview wire
        }
        const id = `ipc:${from}->${to}`;
        if (!byPair.has(id)) {
          byPair.set(id, { id, source: from, target: to, kind: "ipc", resolution: "resolved" });
        }
      }
    }
  }
  return [...byPair.values()];
}

/** IPC wires folded onto the visible frontier, as level edges — magenta, never gold or ghost. */
export function ipcTreeEdges(index: GraphIndex, visibleIds: ReadonlySet<string>): ModuleTreeEdge[] {
  const raw = buildIpcEdges(index.edges);
  const rawById = new Map(raw.map((edge) => [edge.id, edge]));
  const lifted = liftEdges(raw, visibleIds, index.parentOf);
  return lifted.map((edge) => ({
    id: `ipc:${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    crossFrame: false,
    crossPackage: edge.underlyingEdgeIds.some((id) => {
      const rawEdge = rawById.get(id);
      return rawEdge !== undefined && graphEdgeCrossesPackage(rawEdge, index);
    }),
    outsideView: false,
    category: "ipc" as const,
  }));
}
