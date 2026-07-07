/**
 * The Map lens's INLINE-EXPANDABLE containment tree, wired by the import graph lifted to the
 * visible frontier. Unlike the old flat one-level fold, this walks the real `parentId` hierarchy
 * from the current focus and emits a NESTED set: a group card that the reader expanded (its id is
 * in `expanded`) yields its children as `parentId`-nested nodes, exactly like the logic-flow tab.
 *
 *   - `focus === null` → the whole-repo overview: the npm packages that own ≥1 file, as top-level
 *     group cards (collapsed → the package graph; expand one to descend into its directories/files).
 *   - a `focus` package/dir → its children (after chain-collapsing a lone `src`), each expandable.
 *   - a FILE card holding class/interface/object declarations expands one level further: its UNIT
 *     cards nest inside the file frame (the merged Service-composition level of the Map).
 *
 * Imports are folded to the visible boxes by `liftEdges`: a collapsed group swallows its internal
 * imports (self-loops, dropped) and an import leaving the drawn subtree lifts past the frontier and
 * drops — so a level shows only the coupling between what is currently on screen. Unit-dependency
 * wires (calls/instantiates/extends/implements between units) join the edge set whenever a unit
 * card is drawn, pointing at wherever each dependency's definition lives on screen. Pure; no React,
 * no ELK.
 */

import type { GraphEdge } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { npmPackageIdOf } from "./compositionClusters";
import { packageEntryModule, type ModulePackageData } from "./packageOverview";
import { weightKey, type ModuleGraph } from "./moduleGraph";
import { basename, collapseChain, fileData, unitData, type ModuleCardData, type UnitCardData } from "./moduleLevel";
import { containmentChildren, frontierRoots, subtreeFileCount } from "./moduleFrontier";
import { liftDepEdges, UNIT_CARD_KINDS, type UnitDeps } from "./unitDeps";
import { liftEdges } from "./liftEdges";

const MODULE_KIND = "module";

/** A group card carries its expansion state so the card can draw a chevron and open into a frame. */
export type ModuleGroupData = ModulePackageData & { isContainer: boolean; isExpanded: boolean };

/** One node in the drawn containment tree, in DFS preorder (parents BEFORE children — React Flow
 * requires a parent to appear first). `parentId` is the drawn parent (null at the frontier root). */
export interface VisibleModuleNode {
  id: string;
  parentId: string | null;
  kind: "package" | "file" | "unit";
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
  data: ModuleGroupData | ModuleCardData | UnitCardData;
}

/** A wire between two visible nodes. `category` "import" is the file/package import graph;
 * "dep" is a unit-dependency wire (it touches at least one drawn unit card). `crossFrame` = a
 * group is involved (coupling gold). */
export interface ModuleTreeEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  crossFrame: boolean;
  category: "import" | "dep";
}

export interface ModuleTree {
  nodes: VisibleModuleNode[];
  edges: ModuleTreeEdge[];
  /** The node actually descended into after chain-collapse; null == the repo-level overview. */
  effectiveFocus: string | null;
}

/** The containment tree to draw for `(focus, expanded)`: overview when null, else the focus subtree. */
export function deriveModuleTree(
  index: GraphIndex,
  focus: string | null,
  expanded: ReadonlySet<string>,
  graph: ModuleGraph,
  unitDeps: UnitDeps,
): ModuleTree {
  const effectiveFocus = focus === null ? null : collapseChain(index, focus);
  const roots = frontierRoots(index, effectiveFocus, graph);
  const skeleton = walk(index, roots, expanded);
  const visibleIds = new Set(skeleton.map((entry) => entry.id));
  const lifted = liftEdges(importEdges(graph), visibleIds, index.parentOf);
  const nodes = skeleton.map((entry) => finalize(entry, index, graph, lifted, unitDeps));
  const kinds = kindsOf(skeleton);
  const edges = [...importTreeEdges(lifted, kinds), ...depTreeEdges(unitDeps, visibleIds, index, kinds)].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  return { nodes, edges, effectiveFocus };
}

/** A file's unit (class/interface/object) children — the one-deeper level a file card expands to. */
function unitChildren(index: GraphIndex, fileId: string): string[] {
  return index
    .childrenOf(fileId)
    .filter((child) => UNIT_CARD_KINDS.has(child.kind))
    .map((child) => child.id);
}

interface Skeleton {
  id: string;
  parentId: string | null;
  kind: "package" | "file" | "unit";
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
}

/** DFS preorder over the containment tree; a group/file descends only when it is in `expanded`. */
function walk(index: GraphIndex, roots: string[], expanded: ReadonlySet<string>): Skeleton[] {
  const out: Skeleton[] = [];
  const seen = new Set<string>();
  const visit = (id: string, parentId: string | null, depth: number): void => {
    if (seen.has(id)) {
      return; // a parentId cycle (tolerated by the lenient viewer) must not spin forever.
    }
    seen.add(id);
    if (index.nodesById.get(id)?.kind === MODULE_KIND) {
      visitFile(id, parentId, depth);
      return;
    }
    if (subtreeFileCount(index, id) === 0) {
      return; // a directory owning no in-project files anywhere below is a useless "0 files" card.
    }
    const children = containmentChildren(index, id);
    const isContainer = children.length > 0;
    const isExpanded = isContainer && expanded.has(id);
    out.push({ id, parentId, kind: "package", isContainer, isExpanded, depth, childCount: children.length });
    if (isExpanded) {
      children.forEach((child) => visit(child, id, depth + 1));
    }
  };
  const visitFile = (id: string, parentId: string | null, depth: number): void => {
    const units = unitChildren(index, id);
    const isContainer = units.length > 0;
    const isExpanded = isContainer && expanded.has(id);
    out.push({ id, parentId, kind: "file", isContainer, isExpanded, depth, childCount: units.length });
    if (isExpanded) {
      units.forEach((unit) => {
        seen.add(unit);
        out.push({ id: unit, parentId: id, kind: "unit", isContainer: false, isExpanded: false, depth: depth + 1, childCount: 0 });
      });
    }
  };
  roots.forEach((id) => visit(id, null, 0));
  return out;
}

/** Attach the card data each drawn node needs: file cards from the import graph, group cards from
 * the subtree file tally and the lifted-edge frontier degree (Ca/Ce among what is on screen),
 * unit cards from their members + dependency units. */
function finalize(
  entry: Skeleton,
  index: GraphIndex,
  graph: ModuleGraph,
  lifted: ReturnType<typeof liftEdges>,
  unitDeps: UnitDeps,
): VisibleModuleNode {
  const data =
    entry.kind === "unit"
      ? unitData(entry.id, index, unitDeps)
      : entry.kind === "file"
        ? fileData(entry.id, graph, index, entryFor(entry.id, index), {
            isContainer: entry.isContainer,
            isExpanded: entry.isExpanded,
            unitCount: entry.childCount,
          })
        : groupData(entry, index, subtreeFileCount(index, entry.id), lifted);
  return { ...entry, data };
}

/** The blast-radius entry module of the file's owning package (for the ENTRY badge on the card). */
function entryFor(fileId: string, index: GraphIndex): string | null {
  return packageEntryModule(index, npmPackageIdOf(fileId, index.nodesById) ?? fileId);
}

function groupData(entry: Skeleton, index: GraphIndex, fileCount: number, lifted: ReturnType<typeof liftEdges>): ModuleGroupData {
  const label = index.nodesById.get(entry.id)?.displayName ?? basename(entry.id);
  return {
    label,
    fileCount,
    ce: distinctNeighbours(lifted, entry.id, "source"),
    ca: distinctNeighbours(lifted, entry.id, "target"),
    isContainer: entry.isContainer,
    isExpanded: entry.isExpanded,
  };
}

/** Distinct frontier nodes this node imports (`source`) or is imported by (`target`) after lifting. */
function distinctNeighbours(lifted: ReturnType<typeof liftEdges>, id: string, role: "source" | "target"): number {
  const other = role === "source" ? "target" : "source";
  const neighbours = new Set<string>();
  for (const edge of lifted) {
    if (edge[role] === id) {
      neighbours.add(edge[other]);
    }
  }
  return neighbours.size;
}

/** The file-to-file import graph as synthetic resolved `imports` edges, ready for `liftEdges`. */
function importEdges(graph: ModuleGraph): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [source, targets] of graph.out) {
    for (const target of targets) {
      const key = weightKey(source, target);
      edges.push({ id: `mimp:${key}`, source, target, kind: "imports", resolution: "resolved", weight: graph.weight.get(key) ?? 1 } as GraphEdge);
    }
  }
  return edges;
}

function kindsOf(skeleton: Skeleton[]): Map<string, "package" | "file" | "unit"> {
  return new Map(skeleton.map((entry) => [entry.id, entry.kind]));
}

/** Lifted import wires as level edges, flagged crossFrame when either endpoint is a group card. */
function importTreeEdges(lifted: ReturnType<typeof liftEdges>, kinds: Map<string, "package" | "file" | "unit">): ModuleTreeEdge[] {
  return lifted.map((edge) => ({
    id: `lvl:${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    crossFrame: kinds.get(edge.source) === "package" || kinds.get(edge.target) === "package",
    category: "import" as const,
  }));
}

/** Unit-dependency wires projected onto the frontier — derived only when a unit card is on screen
 * (the common no-units level skips the whole projection). */
function depTreeEdges(
  unitDeps: UnitDeps,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  kinds: Map<string, "package" | "file" | "unit">,
): ModuleTreeEdge[] {
  const isUnit = (id: string) => kinds.get(id) === "unit";
  if (![...kinds.values()].includes("unit")) {
    return [];
  }
  return liftDepEdges(unitDeps, visibleIds, index, isUnit).map((edge) => ({
    id: `dep:${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    crossFrame: false,
    category: "dep" as const,
  }));
}
