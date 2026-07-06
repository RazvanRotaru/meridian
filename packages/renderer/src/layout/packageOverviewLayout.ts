/**
 * Lay the whole-repo PACKAGE graph out as a dependency diagram: ELK `layered` left→right so importers
 * sit left of what they import, giving the reader a flow to follow. Each package node is sized by its
 * file count (bigger package ⇒ bigger box, clamped) so scale reads at a glance. React Flow consumes
 * only the node coordinates (it routes its own edges), so `layered` costs us nothing on routing.
 * Deterministic — ELK layered is stable and no Math.random/Date is used.
 */

import type { Edge, Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import { runElkLayout } from "./elkLayout";
import type { ModulePackageData, PackageOverviewSpec } from "../derive/packageOverview";

const NODE_HEIGHT = 76;
const MIN_WIDTH = 172;
const MAX_WIDTH = 320;
const WIDTH_PER_FILE = 3;

const ROOT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "44",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.edgeNode": "28",
};

type PackageRfNode = Node<ModulePackageData, "package">;

export async function layoutPackageOverview(spec: PackageOverviewSpec): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const widthOf = new Map(spec.nodes.map((node) => [node.id, nodeWidth(node.data.fileCount)]));
  const laid = await runElkLayout(buildElkGraph(spec, widthOf));
  return { nodes: toNodes(spec, laid, widthOf), edges: spec.edges.map(toEdge) };
}

function buildElkGraph(spec: PackageOverviewSpec, widthOf: Map<string, number>): ElkNode {
  return {
    id: "root",
    layoutOptions: ROOT_OPTIONS,
    children: spec.nodes.map((node) => ({ id: node.id, width: widthOf.get(node.id) as number, height: NODE_HEIGHT })),
    edges: spec.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
}

/** Bigger packages get wider boxes, clamped so the largest can't dwarf the smallest off-screen. */
function nodeWidth(fileCount: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, MIN_WIDTH + fileCount * WIDTH_PER_FILE));
}

function toNodes(spec: PackageOverviewSpec, laid: ElkNode, widthOf: Map<string, number>): PackageRfNode[] {
  const dataById = new Map(spec.nodes.map((node) => [node.id, node.data]));
  const placedById = new Map((laid.children ?? []).map((child) => [child.id, child]));
  return spec.nodes.map((node) => {
    const placed = placedById.get(node.id);
    return {
      id: node.id,
      type: "package",
      position: { x: placed?.x ?? 0, y: placed?.y ?? 0 },
      style: { width: widthOf.get(node.id) as number, height: NODE_HEIGHT },
      data: dataById.get(node.id) as ModulePackageData,
    };
  });
}

// Every overview wire crosses a package boundary, so flag it `crossFrame` — the shared paint colours
// it as the warm cross-boundary coupling tone, matching the file view's cross-package wires.
function toEdge(edge: PackageOverviewSpec["edges"][number]): Edge {
  return { id: edge.id, source: edge.source, target: edge.target, data: { weight: edge.weight, crossFrame: true } };
}
