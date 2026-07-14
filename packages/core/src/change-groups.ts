/**
 * "Is this PR really N independent changes?" — partition the changed files into disjoint change
 * groups, one per weakly-connected component of the CHANGED modules. Consumed by the review rail.
 *
 * Two changed modules join a group when an edge links them AND BOTH ends are themselves changed:
 * a resolved `imports` edge between the module nodes, or a resolved execution/coupling edge
 * (`calls`/`instantiates`/`renders`/`extends`/`implements`) between two leaves whose containing
 * modules differ. The lifted-leaf path is not optional — Python artifacts emit no `imports` edges,
 * so leaf calls are the only cross-module signal there. An UNCHANGED module shared by two changed
 * modules never glues them: only edges with two changed-module endpoints count, so `A → X ← B`
 * (X unchanged) stays two groups — the reviewer sees two independent changes, not one.
 *
 * `edge.resolution === undefined` counts as resolved (the coverage.ts precedent); external and
 * unresolved edges are honest non-facts and are skipped. Output is fully deterministic: every array
 * is sorted and each group's id is an FNV-1a hash of its sorted file list, so file input order can
 * never change the result. Lives in core so the renderer's review rail and any CLI share it.
 */

import { computeAffectedFlows, type AffectedFlow } from "./affected-flows";
import type { LogicFlows } from "./flow";
import type { ChangedFile } from "./review";
import type { GraphEdge, GraphNode, NodeId } from "./types";

export interface ChangeGroup {
  /** Stable FNV-1a hex of the sorted `files` list — same members ⇒ same id. */
  id: string;
  label: string;
  files: string[];
  /** Matched `module`-kind node ids — the isolation seeds. Sorted. */
  moduleIds: NodeId[];
  /** Affected flow roots touching this group (empty when no flows were supplied). Sorted. */
  flowIds: string[];
}

export interface ChangeGroupsResult {
  /** Sorted by files.length desc, then label asc. */
  groups: ChangeGroup[];
  /** Flow roots touching >1 group; each is ALSO listed in every touched group's flowIds. Sorted. */
  crossGroupFlowIds: string[];
  /** Changed paths that matched no module node (e.g. deletions, uncovered files). Sorted. */
  ungroupedFiles: string[];
}

/** Edge kinds whose two (module-lifted) endpoints being changed means the modules are one change. */
const CONNECTING_EDGE_KINDS: ReadonlySet<string> = new Set([
  "imports",
  "calls",
  "instantiates",
  "renders",
  "extends",
  "implements",
]);

export function computeChangeGroups(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  changedFiles: readonly ChangedFile[],
  flows?: LogicFlows,
): ChangeGroupsResult {
  const changedPaths = new Set(changedFiles.map((file) => file.path));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const changedModules = nodes.filter((node) => node.kind === "module" && changedPaths.has(node.location.file));
  const changedModuleIds = new Set(changedModules.map((node) => node.id));
  const moduleOf = buildModuleIndex(nodes, nodesById);

  const components = connectedModules(changedModules, edges, moduleOf, changedModuleIds);
  const globalRoot = commonDirSegments(changedModules.map((node) => node.location.file));
  const groups = components.map((members) => buildGroup(members, nodesById, globalRoot));

  const crossGroupFlowIds = assignFlows(groups, nodes, changedFiles, flows);
  const grouped = new Set(groups.flatMap((group) => group.files));
  return {
    groups: sortGroups(groups),
    crossGroupFlowIds,
    ungroupedFiles: [...changedPaths].filter((path) => !grouped.has(path)).sort(byAsc),
  };
}

/**
 * Union-find over the changed modules: join a pair for every CONNECTING edge whose two module-lifted
 * endpoints are both changed. Returns each component as its list of member module ids.
 */
function connectedModules(
  changedModules: GraphNode[],
  edges: readonly GraphEdge[],
  moduleOf: ReadonlyMap<NodeId, NodeId | null>,
  changedModuleIds: ReadonlySet<NodeId>,
): NodeId[][] {
  const parent = new Map<NodeId, NodeId>(changedModules.map((node) => [node.id, node.id]));
  const find = (id: NodeId): NodeId => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let node = id;
    while (node !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const edge of edges) {
    if (!isConnecting(edge)) continue;
    const a = moduleOf.get(edge.source) ?? null;
    const b = moduleOf.get(edge.target) ?? null;
    if (a && b && a !== b && changedModuleIds.has(a) && changedModuleIds.has(b)) {
      parent.set(find(a), find(b));
    }
  }
  const byRoot = new Map<NodeId, NodeId[]>();
  for (const node of changedModules) {
    const members = byRoot.get(find(node.id));
    if (members) members.push(node.id);
    else byRoot.set(find(node.id), [node.id]);
  }
  return [...byRoot.values()];
}

function isConnecting(edge: GraphEdge): boolean {
  return CONNECTING_EDGE_KINDS.has(edge.kind) && (edge.resolution ?? "resolved") === "resolved";
}

/** Nearest `module`-kind ancestor id (self included) for every node; null when none exists. */
function buildModuleIndex(
  nodes: readonly GraphNode[],
  nodesById: ReadonlyMap<NodeId, GraphNode>,
): Map<NodeId, NodeId | null> {
  const index = new Map<NodeId, NodeId | null>();
  for (const node of nodes) {
    index.set(node.id, containingModuleId(node.id, nodesById));
  }
  return index;
}

function containingModuleId(startId: NodeId, nodesById: ReadonlyMap<NodeId, GraphNode>): NodeId | null {
  const seen = new Set<NodeId>();
  let current: NodeId | null | undefined = startId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = nodesById.get(current);
    if (!node) return null;
    if (node.kind === "module") return node.id;
    current = node.parentId;
  }
  return null;
}

function buildGroup(memberIds: NodeId[], nodesById: ReadonlyMap<NodeId, GraphNode>, globalRoot: string[]): ChangeGroup {
  const moduleIds = [...memberIds].sort(byAsc);
  const files = uniqueSorted(moduleIds.map((id) => nodesById.get(id)!.location.file));
  return { id: fnv1aHex(files.join("\n")), label: labelFor(files, globalRoot), files, moduleIds, flowIds: [] };
}

/**
 * 1 file ⇒ its basename; else the common dir, unless that is non-discriminating (empty, or exactly
 * the root shared by EVERY changed file) — then the members' distinct next-level dirs joined by `+`.
 */
function labelFor(files: string[], globalRoot: string[]): string {
  if (files.length === 1) {
    return basename(files[0]);
  }
  const dir = commonDirSegments(files);
  if (dir.length > 0 && !segmentsEqual(dir, globalRoot)) {
    return dir.join("/");
  }
  return joinDistinctDirs(files, globalRoot);
}

function joinDistinctDirs(files: string[], globalRoot: string[]): string {
  const names = uniqueSorted(files.map((file) => distinguishingSegment(file, globalRoot)));
  return names.length > 3 ? `${names.slice(0, 3).join("+")}+…` : names.join("+");
}

/** The first dir segment that distinguishes a file below the shared root; its basename if it has none. */
function distinguishingSegment(file: string, globalRoot: string[]): string {
  const dir = dirSegments(file);
  return dir.length > globalRoot.length ? dir[globalRoot.length] : basename(file);
}

function commonDirSegments(files: string[]): string[] {
  const dirs = files.map(dirSegments);
  return dirs.length === 0 ? [] : dirs.reduce(commonPrefix);
}

function commonPrefix(a: string[], b: string[]): string[] {
  const prefix: string[] = [];
  for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) {
    prefix.push(a[i]);
  }
  return prefix;
}

function dirSegments(file: string): string[] {
  return file.split("/").slice(0, -1);
}

function basename(file: string): string {
  const segments = file.split("/");
  return segments[segments.length - 1];
}

function segmentsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/** Fill each group's flowIds with the affected flows touching it; return the roots touching >1 group. */
function assignFlows(
  groups: ChangeGroup[],
  nodes: readonly GraphNode[],
  changedFiles: readonly ChangedFile[],
  flows: LogicFlows | undefined,
): string[] {
  if (!flows) {
    return [];
  }
  const groupByFile = new Map<string, ChangeGroup>();
  for (const group of groups) {
    for (const file of group.files) groupByFile.set(file, group);
  }
  const accumulated = new Map<ChangeGroup, Set<string>>();
  const cross = new Set<string>();
  for (const flow of computeAffectedFlows(nodes, flows, changedFiles)) {
    const touched = touchedGroups(flow, groupByFile);
    for (const group of touched) addFlow(accumulated, group, flow.flowId);
    if (touched.size > 1) cross.add(flow.flowId);
  }
  for (const group of groups) {
    group.flowIds = uniqueSorted([...(accumulated.get(group) ?? [])]);
  }
  return [...cross].sort(byAsc);
}

/** Groups a flow touches: its owner's group (when the owner file changed) + every changed file it calls into. */
function touchedGroups(flow: AffectedFlow, groupByFile: ReadonlyMap<string, ChangeGroup>): Set<ChangeGroup> {
  const files = [...flow.changedFilesHit];
  if (flow.ownerChanged && flow.ownerFile) {
    files.push(flow.ownerFile);
  }
  const touched = new Set<ChangeGroup>();
  for (const file of files) {
    const group = groupByFile.get(file);
    if (group) touched.add(group);
  }
  return touched;
}

function addFlow(accumulated: Map<ChangeGroup, Set<string>>, group: ChangeGroup, flowId: string): void {
  const set = accumulated.get(group) ?? new Set<string>();
  set.add(flowId);
  accumulated.set(group, set);
}

function sortGroups(groups: ChangeGroup[]): ChangeGroup[] {
  return [...groups].sort(
    (a, b) => b.files.length - a.files.length || byAsc(a.label, b.label) || byAsc(a.id, b.id),
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(byAsc);
}

function byAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * FNV-1a 32-bit hex over the sorted file list, mirroring affected-flows' `flowFingerprint`. `Math.imul`
 * keeps the 32-bit multiply exact; this is deterministic change-detection, never security.
 */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
