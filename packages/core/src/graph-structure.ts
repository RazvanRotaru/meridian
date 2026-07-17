/**
 * View-independent containment facts derived from a graph's nodes.
 *
 * Extraction already owns the complete node array, so it is the natural place to calculate these
 * facts once and persist them beside disk-backed projections. The renderer can run the same pure
 * derivation for an ordinary in-memory artifact, while projected views receive only the entries
 * for nodes in their current bounded slice.
 */

import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from "./types";
import { collectTestIds } from "./test-detection";

const MODULE_KIND = "module";
const PACKAGE_KIND = "package";
const NPM_PACKAGE_TAG = "npm-package";

export interface GraphHierarchyFact {
  /** Authoritative whole-revision test classification for this node. */
  isTest: boolean;
  /** Exact direct-child counts by open-vocabulary node kind. */
  childKindCounts: Readonly<Record<string, number>>;
  /** Source-file (`module`) descendants below this node, excluding the node itself. */
  descendantSourceFileCount: number;
  /** Files assigned to this node on the canonical repository overview frontier. */
  ownedSourceFileCount: number;
}

export interface GraphRepositorySummary {
  /** Package cards on the canonical whole-repository Map frontier. */
  overviewPackageCount: number;
  /** Every source-file (`module`) node in the repository, including tests. */
  sourceFileCount: number;
  /** Source-file nodes classified as tests in the same whole-revision universe. */
  testSourceFileCount: number;
}

/** Everything the repository-level Map needs to draw one canonical ownership root card. */
export interface GraphModuleOverviewRoot {
  id: string;
  kind: NodeKind;
  displayName: string;
  qualifiedName: string;
  /** Files owned by this root after applying nearest-npm-package ownership. */
  sourceFileCount: number;
  /** Test files among `sourceFileCount`, using the whole-revision classification. */
  testSourceFileCount: number;
  /** Distinct overview roots with relationships into this root. */
  ca: number;
  /** Distinct overview roots this root has relationships to. */
  ce: number;
  isTest: boolean;
}

/** A typed cross-root relationship with an exact trail back to its artifact edges. */
export interface GraphModuleOverviewEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
  evidenceIds: readonly string[];
}

/** Compact, deterministic whole-repository Map data; no descendant nodes are required to draw it. */
export interface GraphModuleOverview {
  roots: readonly GraphModuleOverviewRoot[];
  edges: readonly GraphModuleOverviewEdge[];
}

/** Strict shared parser for disk bundles and browser projection boundaries. */
export function parseGraphModuleOverview(value: unknown): GraphModuleOverview {
  if (!isRecord(value) || !exactKeys(value, ["roots", "edges"])
    || !Array.isArray(value.roots) || !value.roots.every(isModuleOverviewRoot)
    || !Array.isArray(value.edges) || !value.edges.every(isModuleOverviewEdge)) {
    throw new TypeError("invalid graph module overview");
  }
  const overview = value as unknown as GraphModuleOverview;
  assertCanonicalModuleOverview(overview);
  return overview;
}

export interface GraphStructureFacts {
  hierarchyById: ReadonlyMap<string, GraphHierarchyFact>;
  /** Canonical whole-repository Map frontier, in stable id order. */
  moduleOverviewRootIds: readonly string[];
  moduleOverview: GraphModuleOverview;
  repositorySummary: GraphRepositorySummary;
}

/** Derive exact containment/navigation facts for the supplied node universe. */
export function deriveGraphStructure(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): GraphStructureFacts {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const testIds = collectTestIds([...nodes]);
  const childrenByParent = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.parentId === null || node.parentId === undefined || !nodesById.has(node.parentId)) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }

  const mutableHierarchy = new Map<string, {
    isTest: boolean;
    childKindCounts: Record<string, number>;
    descendantSourceFileCount: number;
    ownedSourceFileCount: number;
  }>();
  for (const node of nodes) {
    const childKindCounts: Record<string, number> = {};
    for (const child of childrenByParent.get(node.id) ?? []) {
      childKindCounts[child.kind] = (childKindCounts[child.kind] ?? 0) + 1;
    }
    mutableHierarchy.set(node.id, {
      isTest: testIds.has(node.id),
      childKindCounts,
      descendantSourceFileCount: 0,
      ownedSourceFileCount: 0,
    });
  }

  const sourceFiles = nodes.filter((node) => node.kind === MODULE_KIND);
  for (const file of sourceFiles) {
    const seen = new Set<string>([file.id]);
    let parentId = file.parentId ?? null;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      const fact = mutableHierarchy.get(parentId);
      if (fact === undefined) break;
      fact.descendantSourceFileCount += 1;
      parentId = nodesById.get(parentId)?.parentId ?? null;
    }
  }

  const npmPackages = new Set<string>();
  const npmPackageByFile = new Map<string, string>();
  const unownedFiles: string[] = [];
  for (const file of sourceFiles) {
    const npmPackage = nearestNpmPackage(file.id, nodesById);
    if (npmPackage === null) unownedFiles.push(file.id);
    else {
      npmPackages.add(npmPackage);
      npmPackageByFile.set(file.id, npmPackage);
    }
  }

  // A structural ancestor of an npm boundary cannot also own that boundary's files on the Map
  // frontier. The npm package itself is blocked from fallback selection because it is already an
  // explicit root above.
  const blockedPackages = new Set<string>();
  for (const packageId of npmPackages) {
    for (const ancestor of ancestorsOf(packageId, nodesById)) {
      if (ancestor.kind === PACKAGE_KIND) blockedPackages.add(ancestor.id);
    }
  }

  const overviewRoots = new Set(npmPackages);
  const overviewOwnerByFile = new Map(npmPackageByFile);
  for (const fileId of unownedFiles) {
    const owner = ancestorsOf(fileId, nodesById)
      .find((ancestor) => ancestor.kind === PACKAGE_KIND && !blockedPackages.has(ancestor.id));
    const ownerId = owner?.id ?? fileId;
    overviewRoots.add(ownerId);
    overviewOwnerByFile.set(fileId, ownerId);
  }
  for (const ownerId of overviewOwnerByFile.values()) {
    const fact = mutableHierarchy.get(ownerId);
    if (fact !== undefined) fact.ownedSourceFileCount += 1;
  }
  const moduleOverviewRootIds = [...overviewRoots].sort();
  const overviewPackageCount = moduleOverviewRootIds
    .filter((id) => nodesById.get(id)?.kind === PACKAGE_KIND)
    .length;
  const moduleOverview = deriveModuleOverview(
    moduleOverviewRootIds,
    overviewOwnerByFile,
    nodesById,
    testIds,
    edges,
  );

  return {
    hierarchyById: mutableHierarchy,
    moduleOverviewRootIds,
    moduleOverview,
    repositorySummary: {
      overviewPackageCount,
      sourceFileCount: sourceFiles.length,
      testSourceFileCount: sourceFiles.reduce((count, file) => count + Number(testIds.has(file.id)), 0),
    },
  };
}

function deriveModuleOverview(
  rootIds: readonly string[],
  ownerByFile: ReadonlyMap<string, string>,
  nodesById: ReadonlyMap<string, GraphNode>,
  testIds: ReadonlySet<string>,
  edges: readonly GraphEdge[],
): GraphModuleOverview {
  const rootIdSet = new Set(rootIds);
  const fileCountByRoot = new Map<string, number>();
  const testFileCountByRoot = new Map<string, number>();
  for (const [fileId, rootId] of ownerByFile) {
    fileCountByRoot.set(rootId, (fileCountByRoot.get(rootId) ?? 0) + 1);
    if (testIds.has(fileId)) {
      testFileCountByRoot.set(rootId, (testFileCountByRoot.get(rootId) ?? 0) + 1);
    }
  }

  const aggregateByKey = new Map<string, MutableOverviewEdge>();
  const inboundByRoot = new Map<string, Set<string>>();
  const outboundByRoot = new Map<string, Set<string>>();
  for (const edge of edges) {
    const source = overviewRootOf(edge.source, rootIdSet, nodesById);
    const target = overviewRootOf(edge.target, rootIdSet, nodesById);
    if (source === null || target === null || source === target) continue;
    const key = JSON.stringify([edge.kind, source, target]);
    const aggregate = aggregateByKey.get(key);
    if (aggregate === undefined) {
      aggregateByKey.set(key, {
        source,
        target,
        kind: edge.kind,
        weight: edge.weight ?? 1,
        evidenceIds: new Set([edge.id]),
      });
    } else {
      aggregate.weight += edge.weight ?? 1;
      // Extractors normally aggregate identical endpoint/kind edges into one weighted edge, but
      // callers may still provide repeated records. Weight remains additive while provenance is a
      // canonical identity set, so one evidence id can never appear twice in the transport facts.
      aggregate.evidenceIds.add(edge.id);
    }
    addNeighbour(outboundByRoot, source, target);
    addNeighbour(inboundByRoot, target, source);
  }

  const roots = rootIds.map((id): GraphModuleOverviewRoot => {
    const node = nodesById.get(id);
    if (node === undefined) {
      throw new Error(`module overview root is not present in the graph: ${id}`);
    }
    return {
      id,
      kind: node.kind,
      displayName: node.displayName,
      qualifiedName: node.qualifiedName,
      sourceFileCount: fileCountByRoot.get(id) ?? 0,
      testSourceFileCount: testFileCountByRoot.get(id) ?? 0,
      ca: inboundByRoot.get(id)?.size ?? 0,
      ce: outboundByRoot.get(id)?.size ?? 0,
      isTest: testIds.has(id),
    };
  });
  const overviewEdges = [...aggregateByKey.values()]
    .map((edge): GraphModuleOverviewEdge => ({
      id: moduleOverviewEdgeId(edge.kind, edge.source, edge.target),
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      weight: edge.weight,
      evidenceIds: [...edge.evidenceIds].sort(),
    }))
    .sort((left, right) => compareText(left.id, right.id));
  return parseGraphModuleOverview({ roots, edges: overviewEdges });
}

interface MutableOverviewEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
  evidenceIds: Set<string>;
}

function overviewRootOf(
  nodeId: string,
  rootIds: ReadonlySet<string>,
  nodesById: ReadonlyMap<string, GraphNode>,
): string | null {
  const seen = new Set<string>();
  let current = nodesById.get(nodeId);
  while (current !== undefined && !seen.has(current.id)) {
    if (rootIds.has(current.id)) return current.id;
    seen.add(current.id);
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return null;
}

function addNeighbour(map: Map<string, Set<string>>, source: string, target: string): void {
  const neighbours = map.get(source);
  if (neighbours === undefined) map.set(source, new Set([target]));
  else neighbours.add(target);
}

function moduleOverviewEdgeId(kind: EdgeKind, source: string, target: string): string {
  return `overview:${encodeURIComponent(kind)}:${encodeURIComponent(source)}->${encodeURIComponent(target)}`;
}

function assertCanonicalModuleOverview(overview: GraphModuleOverview): void {
  const rootIds = overview.roots.map((root) => root.id);
  if (!isSortedUnique(rootIds)) {
    throw new TypeError("graph module overview roots must be canonical");
  }
  const roots = new Set(rootIds);
  const inbound = new Map<string, Set<string>>();
  const outbound = new Map<string, Set<string>>();
  const evidenceIds = new Set<string>();
  const edgeIds = overview.edges.map((edge) => edge.id);
  if (!isSortedUnique(edgeIds)) {
    throw new TypeError("graph module overview edges must be canonical");
  }
  for (const edge of overview.edges) {
    if (!roots.has(edge.source) || !roots.has(edge.target) || edge.source === edge.target
      || edge.id !== moduleOverviewEdgeId(edge.kind, edge.source, edge.target)
      || !isSortedUnique(edge.evidenceIds) || edge.evidenceIds.length === 0) {
      throw new TypeError("graph module overview edge references must be canonical");
    }
    for (const evidenceId of edge.evidenceIds) {
      if (evidenceIds.has(evidenceId)) {
        throw new TypeError("graph module overview evidence ids must be unique");
      }
      evidenceIds.add(evidenceId);
    }
    addNeighbour(outbound, edge.source, edge.target);
    addNeighbour(inbound, edge.target, edge.source);
  }
  for (const root of overview.roots) {
    if (root.sourceFileCount === 0 || root.testSourceFileCount > root.sourceFileCount
      || (root.isTest && root.testSourceFileCount !== root.sourceFileCount)
      || root.ca !== (inbound.get(root.id)?.size ?? 0)
      || root.ce !== (outbound.get(root.id)?.size ?? 0)) {
      throw new TypeError("graph module overview root facts are inconsistent");
    }
  }
}

function isModuleOverviewRoot(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, [
    "id", "kind", "displayName", "qualifiedName", "sourceFileCount",
    "testSourceFileCount", "ca", "ce", "isTest",
  ])
    && isId(value.id)
    && (value.kind === MODULE_KIND || value.kind === PACKAGE_KIND)
    && isText(value.displayName) && isText(value.qualifiedName)
    && isNonNegativeInteger(value.sourceFileCount)
    && isNonNegativeInteger(value.testSourceFileCount)
    && isNonNegativeInteger(value.ca) && isNonNegativeInteger(value.ce)
    && typeof value.isTest === "boolean";
}

function isModuleOverviewEdge(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, [
    "id", "source", "target", "kind", "weight", "evidenceIds",
  ])
    && isId(value.id) && isId(value.source) && isId(value.target) && isId(value.kind)
    && isPositiveInteger(value.weight)
    && Array.isArray(value.evidenceIds) && value.evidenceIds.every(isId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const canonicalExpected = [...expected].sort(compareText);
  return actual.length === canonicalExpected.length
    && actual.every((key, index) => key === canonicalExpected[index]);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nearestNpmPackage(
  nodeId: string,
  nodesById: ReadonlyMap<string, GraphNode>,
): string | null {
  const seen = new Set<string>();
  let current = nodesById.get(nodeId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.kind === PACKAGE_KIND && current.tags?.includes(NPM_PACKAGE_TAG)) return current.id;
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return null;
}

function ancestorsOf(
  nodeId: string,
  nodesById: ReadonlyMap<string, GraphNode>,
): GraphNode[] {
  const ancestors: GraphNode[] = [];
  const seen = new Set<string>();
  let current = nodesById.get(nodeId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    ancestors.push(current);
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return ancestors.reverse();
}
