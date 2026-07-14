import type { GraphEdge } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { npmPackageIdOf } from "./compositionClusters";
import { type Skeleton } from "./codeWalk";
import { liftEdges } from "./liftEdges";
import { basename, blockData, fileData, unitData } from "./moduleLevel";
import { underlyingEdgesCrossPackage } from "./packageBoundary";

const EMPTY_HIDDEN: ReadonlySet<string> = new Set<string>();
import { subtreeFileCount } from "./moduleFrontier";
import { weightKey, type ModuleGraph } from "./moduleGraph";
import { derivePackageOverview, packageEntryModule, type ModulePackageData } from "./packageOverview";
import type { StepData } from "./flowSteps";
import type { ModuleGroupData, ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";

/** Attach the card data each drawn node needs: file cards from the import graph, group cards from
 * the subtree file tally and the lifted-edge frontier degree (Ca/Ce among what is on screen),
 * unit frames and code blocks from their identity (name + kind — deps are the wires' story). */
export function finalizeModuleNode(
  entry: Skeleton,
  index: GraphIndex,
  graph: ModuleGraph,
  lifted: ReturnType<typeof liftEdges>,
  stepData: ReadonlyMap<string, StepData>,
  overviewFold: ReadonlyMap<string, ModulePackageData>,
  hiddenIds: ReadonlySet<string> = EMPTY_HIDDEN,
): VisibleModuleNode {
  const data =
    entry.kind === "step"
      ? (stepData.get(entry.id) as StepData)
      : entry.kind === "block"
      ? blockData(entry.id, index, {
          expandable: entry.isContainer,
          emptyFlow: entry.isContainer && entry.childCount === 0,
          childCount: entry.childCount,
          isExpanded: entry.isExpanded,
        })
      : entry.kind === "unit"
      ? unitData(entry.id, index, {
          memberCount: entry.childCount,
          isContainer: entry.isContainer,
          isExpanded: entry.isExpanded,
        })
      : entry.kind === "file"
        ? fileData(
            entry.id,
            graph,
            index,
            entryFor(entry.id, index),
            { isContainer: entry.isContainer, isExpanded: entry.isExpanded, unitCount: entry.childCount },
            hiddenIds,
          )
        : groupData(entry, index, subtreeFileCount(index, entry.id), lifted, overviewFold);
  return { ...entry, data };
}

/** Overview-fold card data per npm package id (empty when the artifact has none — the topmost-dir
 * fallback roots keep the lifted-edge numbers). */
export function foldById(index: GraphIndex): Map<string, ModulePackageData> {
  return new Map(derivePackageOverview(index).nodes.map((node) => [node.id, node.data]));
}

/** The file-to-file import graph as synthetic resolved `imports` edges, ready for `liftEdges`. */
export function importEdges(graph: ModuleGraph): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [source, targets] of graph.out) {
    for (const target of targets) {
      const key = weightKey(source, target);
      edges.push({ id: `mimp:${key}`, source, target, kind: "imports", resolution: "resolved", weight: graph.weight.get(key) ?? 1 } as GraphEdge);
    }
  }
  return edges;
}

/** Lifted import wires as level edges, flagged crossFrame when either endpoint is a group card.
 * The lifted underlying ids are SYNTHETIC (`mimp:<pair>` — see `importEdges`); each expands through
 * `graph.edgeIds` back to the real artifact `imports` edges so the Wire Inspector can attribute. */
export function importTreeEdges(
  lifted: ReturnType<typeof liftEdges>,
  kinds: Map<string, Skeleton["kind"]>,
  graph: ModuleGraph,
  index: GraphIndex,
): ModuleTreeEdge[] {
  return lifted.map((edge) => {
    const underlyingEdgeIds = edge.underlyingEdgeIds.flatMap((id) => graph.edgeIds.get(id.slice("mimp:".length)) ?? []);
    return {
      id: `lvl:${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
      crossFrame: kinds.get(edge.source) === "package" || kinds.get(edge.target) === "package",
      crossPackage: underlyingEdgesCrossPackage(underlyingEdgeIds, index),
      outsideView: false,
      category: "import" as const,
      relationKind: "imports",
      underlyingEdgeIds,
    };
  });
}

/** The blast-radius entry module of the file's owning package (for the ENTRY badge on the card). */
function entryFor(fileId: string, index: GraphIndex): string | null {
  return packageEntryModule(index, npmPackageIdOf(fileId, index.nodesById) ?? fileId);
}

function groupData(
  entry: Skeleton,
  index: GraphIndex,
  fileCount: number,
  lifted: ReturnType<typeof liftEdges>,
  overviewFold: ReadonlyMap<string, ModulePackageData>,
): ModuleGroupData {
  const fold = overviewFold.get(entry.id);
  if (fold) {
    return { ...fold, isContainer: entry.isContainer, isExpanded: entry.isExpanded };
  }
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
