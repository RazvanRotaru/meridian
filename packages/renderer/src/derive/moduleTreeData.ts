import type { GraphEdge } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { npmPackageIdOf } from "./compositionClusters";
import { type Skeleton } from "./codeWalk";
import { liftEdges } from "./liftEdges";
import { basename, blockData, fileData, unitData } from "./moduleLevel";
import { crossesPackageBoundary, underlyingEdgesCrossPackage } from "./packageBoundary";

const EMPTY_HIDDEN: ReadonlySet<string> = new Set<string>();
import { subtreeFileCount } from "./moduleFrontier";
import { weightKey, type ModuleGraph } from "./moduleGraph";
import { packageEntryModule, type ModulePackageData } from "./packageOverview";
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

/**
 * Authoritative repository-overview card data. These facts are derived once from the complete
 * revision and travel with bounded projections, so card totals never shrink to the descendants
 * that happen to be resident in the browser.
 */
export function foldById(
  index: GraphIndex,
  hiddenIds: ReadonlySet<string> = EMPTY_HIDDEN,
): Map<string, ModulePackageData> {
  const hideTests = hiddenIds.size > 0;
  return new Map(index.structure.moduleOverview.roots.map((root) => [root.id, {
    label: root.displayName,
    fileCount: root.sourceFileCount - (hideTests ? root.testSourceFileCount : 0),
    ca: root.ca,
    ce: root.ce,
  }]));
}

/**
 * The repository overview's exact typed relationships. `evidenceIds` refer to the complete
 * artifact, not merely the edge records resident in a projection, and therefore remain stable
 * across forward/back navigation and projection-cache eviction.
 */
export function moduleOverviewTreeEdges(
  index: GraphIndex,
  visibleIds: ReadonlySet<string>,
): ModuleTreeEdge[] {
  return index.structure.moduleOverview.edges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .map((edge): ModuleTreeEdge => {
      const category = edge.kind === "imports" ? "import" : edge.kind === "ipc" ? "ipc" : "dep";
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        weight: edge.weight,
        crossFrame: index.nodesById.get(edge.source)?.kind === "package"
          || index.nodesById.get(edge.target)?.kind === "package",
        // Overview ownership roots preserve npm/system scope, so their boundary comparison is the
        // same ownership comparison as the original endpoints represented by this aggregate.
        crossPackage: crossesPackageBoundary(edge.source, edge.target, index),
        outsideView: false,
        category,
        relationKind: edge.kind,
        ...(category === "dep" ? { depKind: edge.kind } : {}),
        underlyingEdgeIds: [...edge.evidenceIds],
      };
    });
}

/**
 * Compose complete-revision overview wires with locally resident drill-down wires. A local wire may
 * replace an overview wire only when it carries that aggregate's complete evidence set; a partial
 * slice never shadows or double-counts complete-revision evidence.
 */
export function withModuleOverviewEdges(
  index: GraphIndex,
  visibleIds: ReadonlySet<string>,
  localEdges: readonly ModuleTreeEdge[],
): ModuleTreeEdge[] {
  const overviewEdges = moduleOverviewTreeEdges(index, visibleIds);
  const overviewByEvidence = new Map<string, ModuleTreeEdge>();
  const overviewEvidenceIds = new Set<string>();
  for (const edge of overviewEdges) {
    const evidence = edge.underlyingEdgeIds ?? [];
    overviewByEvidence.set(evidenceKey(evidence), edge);
    evidence.forEach((id) => overviewEvidenceIds.add(id));
  }

  const substitutedOverviewIds = new Set<string>();
  const retainedLocalEdges: ModuleTreeEdge[] = [];
  for (const edge of localEdges) {
    const evidence = edge.underlyingEdgeIds ?? [];
    if (evidence.length === 0) {
      retainedLocalEdges.push(edge);
      continue;
    }
    const exactOverview = overviewByEvidence.get(evidenceKey(evidence));
    if (exactOverview !== undefined) {
      if (edge.source !== exactOverview.source || edge.target !== exactOverview.target) {
        substitutedOverviewIds.add(exactOverview.id);
        retainedLocalEdges.push(edge);
      }
      continue;
    }
    if (!evidence.some((id) => overviewEvidenceIds.has(id))) retainedLocalEdges.push(edge);
  }
  return [
    ...overviewEdges.filter((edge) => !substitutedOverviewIds.has(edge.id)),
    ...retainedLocalEdges,
  ];
}

function evidenceKey(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].sort());
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
