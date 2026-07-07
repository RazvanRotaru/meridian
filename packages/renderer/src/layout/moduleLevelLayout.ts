/**
 * Lay one Module-map LEVEL out as a flat dependency diagram: ELK `layered` left→right so importers
 * sit left of what they import. Group cards (directories/packages) size by their file count; file
 * cards are fixed. React Flow consumes only the coordinates (it routes its own edges), so `layered`
 * costs nothing on routing. Deterministic — ELK layered is stable and no Math.random/Date is used.
 */

import type { Edge, Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import { runElkLayout } from "./elkLayout";
import type { LevelSpec, ModuleCardData } from "../derive/moduleLevel";
import type { ModulePackageData } from "../derive/packageOverview";

const GROUP_HEIGHT = 76;
const GROUP_MIN_WIDTH = 172;
const GROUP_MAX_WIDTH = 320;
const WIDTH_PER_FILE = 3;
const FILE_WIDTH = 210;
const FILE_HEIGHT = 54;

const ROOT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "44",
  "elk.layered.spacing.nodeNodeBetweenLayers": "120",
  "elk.spacing.edgeNode": "28",
};

interface Sized {
  id: string;
  type: "package" | "file";
  width: number;
  height: number;
  data: ModulePackageData | ModuleCardData;
}

/** Size every level node, run ELK, and map the placed coordinates back to React Flow nodes/edges. */
export async function layoutLevel(spec: LevelSpec): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const sized = sizeNodes(spec);
  if (sized.length === 0) {
    return { nodes: [], edges: [] };
  }
  const laid = await runElkLayout(buildElkGraph(sized, spec));
  return { nodes: toNodes(sized, laid), edges: spec.edges.map(toEdge) };
}

function sizeNodes(spec: LevelSpec): Sized[] {
  const groups: Sized[] = spec.groups.map((group) => ({
    id: group.id,
    type: "package",
    width: groupWidth(group.data.fileCount),
    height: GROUP_HEIGHT,
    data: group.data,
  }));
  const files: Sized[] = spec.files.map((file) => ({
    id: file.id,
    type: "file",
    width: FILE_WIDTH,
    height: FILE_HEIGHT,
    data: file.data,
  }));
  return [...groups, ...files];
}

/** Bigger directories get wider boxes, clamped so the largest can't dwarf the smallest off-screen. */
function groupWidth(fileCount: number): number {
  return Math.max(GROUP_MIN_WIDTH, Math.min(GROUP_MAX_WIDTH, GROUP_MIN_WIDTH + fileCount * WIDTH_PER_FILE));
}

function buildElkGraph(sized: Sized[], spec: LevelSpec): ElkNode {
  return {
    id: "root",
    layoutOptions: ROOT_OPTIONS,
    children: sized.map((node) => ({ id: node.id, width: node.width, height: node.height })),
    edges: spec.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
}

function toNodes(sized: Sized[], laid: ElkNode): Node[] {
  const placedById = new Map((laid.children ?? []).map((child) => [child.id, child]));
  return sized.map((node) => {
    const placed = placedById.get(node.id);
    return {
      id: node.id,
      type: node.type,
      position: { x: placed?.x ?? 0, y: placed?.y ?? 0 },
      style: { width: node.width, height: node.height },
      data: node.data,
    };
  });
}

function toEdge(edge: LevelSpec["edges"][number]): Edge {
  return { id: edge.id, source: edge.source, target: edge.target, data: { weight: edge.weight, crossFrame: edge.crossFrame } };
}
