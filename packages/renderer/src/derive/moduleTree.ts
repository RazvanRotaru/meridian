/**
 * The Map lens's INLINE-EXPANDABLE containment tree, wired by the import graph lifted to the
 * visible frontier. Unlike the old flat one-level fold, this walks the real `parentId` hierarchy
 * from the current focus and emits a NESTED set: a group card that the reader expanded (its id is
 * in `expanded`) yields its children as `parentId`-nested nodes, exactly like the logic-flow tab.
 *
 *   - `focus === null` → the whole-repo overview: the npm packages that own ≥1 file, as top-level
 *     group cards (collapsed → the package graph; expand one to descend into its directories/files).
 *   - a `focus` package/dir → its children (after chain-collapsing a lone `src`), each expandable.
 *   - a FILE card holding declarations expands into the CODE level (the merged Service-composition
 *     level of the Map): a class/interface/object becomes a unit FRAME whose method nodes nest
 *     inside it; file-level functions and type definitions sit beside it as leaf BLOCK nodes.
 *
 * Imports are folded to the visible boxes by `liftEdges`: a collapsed group swallows its internal
 * imports (self-loops, dropped) and an import leaving the drawn subtree lifts past the frontier and
 * drops — so a level shows only the coupling between what is currently on screen. Code-dependency
 * wires (calls/instantiates/extends/implements at their REAL endpoints) join the edge set whenever
 * a code node is drawn, so a wire starts at the specific block that uses the dependency and points
 * at wherever its definition lives on screen. Pure; no React, no ELK.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { npmPackageIdOf } from "./compositionClusters";
import { packageEntryModule, type ModulePackageData } from "./packageOverview";
import { weightKey, type ModuleGraph } from "./moduleGraph";
import { basename, blockData, collapseChain, fileData, unitData, type BlockData, type ModuleCardData, type UnitCardData } from "./moduleLevel";
import { containmentChildren, frontierRoots, subtreeFileCount } from "./moduleFrontier";
import { BLOCK_KINDS, liftDepEdges, UNIT_CARD_KINDS, type BlockDeps } from "./blockDeps";
import { liftEdges } from "./liftEdges";

const MODULE_KIND = "module";

/** A group card carries its expansion state so the card can draw a chevron and open into a frame. */
export type ModuleGroupData = ModulePackageData & { isContainer: boolean; isExpanded: boolean };

/** One node in the drawn containment tree, in DFS preorder (parents BEFORE children — React Flow
 * requires a parent to appear first). `parentId` is the drawn parent (null at the frontier root). */
export interface VisibleModuleNode {
  id: string;
  parentId: string | null;
  kind: "package" | "file" | "unit" | "block";
  isContainer: boolean;
  isExpanded: boolean;
  depth: number;
  childCount: number;
  data: ModuleGroupData | ModuleCardData | UnitCardData | BlockData;
}

/** A wire between two visible nodes. `category` "import" is the file/package import graph;
 * "dep" is a code-dependency wire (it touches at least one drawn unit frame or block). `crossFrame`
 * = a group is involved (coupling gold). */
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
  blockDeps: BlockDeps,
): ModuleTree {
  const effectiveFocus = focus === null ? null : collapseChain(index, focus);
  const roots = frontierRoots(index, effectiveFocus, graph);
  const skeleton = walk(index, roots, expanded);
  const visibleIds = new Set(skeleton.map((entry) => entry.id));
  const lifted = liftEdges(importEdges(graph), visibleIds, index.parentOf);
  const nodes = skeleton.map((entry) => finalize(entry, index, graph, lifted));
  const kinds = kindsOf(skeleton);
  const edges = [...importTreeEdges(lifted, kinds), ...depTreeEdges(blockDeps, visibleIds, index, kinds)].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  return { nodes, edges, effectiveFocus };
}

/** A file's drawn declarations — the code level a file card expands to. Source order. */
function declChildren(index: GraphIndex, fileId: string): GraphNode[] {
  return index.childrenOf(fileId).filter((child) => UNIT_CARD_KINDS.has(child.kind) || BLOCK_KINDS.has(child.kind));
}

/** A unit's drawn members: its callable/type children, each a block node inside the frame. */
function memberChildren(index: GraphIndex, unitId: string): GraphNode[] {
  return index.childrenOf(unitId).filter((child) => BLOCK_KINDS.has(child.kind));
}

interface Skeleton {
  id: string;
  parentId: string | null;
  kind: "package" | "file" | "unit" | "block";
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
    const decls = declChildren(index, id);
    const isContainer = decls.length > 0;
    const isExpanded = isContainer && expanded.has(id);
    out.push({ id, parentId, kind: "file", isContainer, isExpanded, depth, childCount: decls.length });
    if (isExpanded) {
      decls.forEach((decl) => visitDecl(decl, id, depth + 1));
    }
  };
  // A unit with members ALWAYS opens as a frame of member blocks — methods are first-class nodes
  // (the surface logic flows will later chart in place), not rows on a card. Memberless units and
  // file-level functions/types are leaf blocks.
  const visitDecl = (decl: GraphNode, parentId: string, depth: number): void => {
    seen.add(decl.id);
    if (!UNIT_CARD_KINDS.has(decl.kind)) {
      out.push({ id: decl.id, parentId, kind: "block", isContainer: false, isExpanded: false, depth, childCount: 0 });
      return;
    }
    const members = memberChildren(index, decl.id);
    const isFrame = members.length > 0;
    out.push({ id: decl.id, parentId, kind: "unit", isContainer: isFrame, isExpanded: isFrame, depth, childCount: members.length });
    members.forEach((member) => {
      seen.add(member.id);
      out.push({ id: member.id, parentId: decl.id, kind: "block", isContainer: false, isExpanded: false, depth: depth + 1, childCount: 0 });
    });
  };
  roots.forEach((id) => visit(id, null, 0));
  return out;
}

/** Attach the card data each drawn node needs: file cards from the import graph, group cards from
 * the subtree file tally and the lifted-edge frontier degree (Ca/Ce among what is on screen),
 * unit frames and code blocks from their identity (name + kind — deps are the wires' story). */
function finalize(
  entry: Skeleton,
  index: GraphIndex,
  graph: ModuleGraph,
  lifted: ReturnType<typeof liftEdges>,
): VisibleModuleNode {
  const data =
    entry.kind === "block"
      ? blockData(entry.id, index)
      : entry.kind === "unit"
      ? unitData(entry.id, index, entry.childCount)
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

function kindsOf(skeleton: Skeleton[]): Map<string, Skeleton["kind"]> {
  return new Map(skeleton.map((entry) => [entry.id, entry.kind]));
}

/** Lifted import wires as level edges, flagged crossFrame when either endpoint is a group card. */
function importTreeEdges(lifted: ReturnType<typeof liftEdges>, kinds: Map<string, Skeleton["kind"]>): ModuleTreeEdge[] {
  return lifted.map((edge) => ({
    id: `lvl:${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    crossFrame: kinds.get(edge.source) === "package" || kinds.get(edge.target) === "package",
    category: "import" as const,
  }));
}

/** Code-dependency wires projected onto the frontier — derived only when a code node (a unit frame
 * or a block) is on screen (the common no-code level skips the whole projection). */
function depTreeEdges(
  blockDeps: BlockDeps,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  kinds: Map<string, Skeleton["kind"]>,
): ModuleTreeEdge[] {
  const isCode = (id: string) => kinds.get(id) === "unit" || kinds.get(id) === "block";
  if (![...kinds.values()].some((kind) => kind === "unit" || kind === "block")) {
    return [];
  }
  return liftDepEdges(blockDeps, visibleIds, index, isCode).map((edge) => ({
    id: `dep:${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    crossFrame: false,
    category: "dep" as const,
  }));
}
