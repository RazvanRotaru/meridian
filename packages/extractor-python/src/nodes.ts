/** Build and finalize the Python containment tree before any edge is resolved. */

import { buildNodeId } from "@meridian/core";
import type { GraphNode, NodeKind, TelemetryKey } from "@meridian/core";
import type { AnalyzeModule, AnalyzeNode, AnalyzeOutput } from "./types";

const LANG = "py";
const ROOT_PACKAGE = "__root__";

export interface NodeIndex {
  nodes: GraphNode[];
  kindById: Map<string, NodeKind>;
  modulePaths: Set<string>;
  renamed: number;
  sourceId(module: AnalyzeModule, qualname: string | null, startLine: number | null): string | undefined;
  targetId(modulePath: string, qualname: string | null, startLine?: number): string | undefined;
}

export function buildNodes(output: AnalyzeOutput): NodeIndex {
  const allocator = new IdAllocator();
  const nodes: GraphNode[] = [];
  const packageIds = emitPackages(output.modules, nodes, allocator);
  const moduleIdsByFile = new Map<string, string>();
  const moduleIdsByPath = new Map<string, string>();
  const memberIdsByFile = new Map<string, string>();
  const memberIdsByOccurrence = new Map<string, string>();
  const memberIdsByTargetOccurrence = new Map<string, string>();
  const memberIdsByPath = new Map<string, string>();

  for (const module of output.modules) {
    const graphPath = graphModulePath(module);
    const moduleId = module.isPackage ? packageIds.get(graphPath)! : allocator.next(idOf(graphPath));
    moduleIdsByFile.set(module.file, moduleId);
    moduleIdsByPath.set(module.modulePath, moduleId);
    moduleIdsByPath.set(graphPath, moduleId);
    if (!module.isPackage) nodes.push(moduleNode(module, moduleId, packageIds));
    for (const member of module.nodes) {
      const memberId = allocator.next(idOf(graphPath, member.qualname));
      const parentId = member.parentQualname
        ? memberIdsByFile.get(memberKey(module.file, member.parentQualname))
        : moduleId;
      nodes.push(memberNode(module, member, memberId, parentId ?? moduleId));
      memberIdsByFile.set(memberKey(module.file, member.qualname), memberId);
      memberIdsByOccurrence.set(occurrenceKey(module.file, member.qualname, member.startLine), memberId);
      memberIdsByTargetOccurrence.set(occurrenceKey(module.modulePath, member.qualname, member.startLine), memberId);
      memberIdsByTargetOccurrence.set(occurrenceKey(graphPath, member.qualname, member.startLine), memberId);
      memberIdsByPath.set(memberKey(module.modulePath, member.qualname), memberId);
      memberIdsByPath.set(memberKey(graphPath, member.qualname), memberId);
    }
  }

  const kindById = new Map(nodes.map((node) => [node.id, node.kind]));
  return {
    nodes,
    kindById,
    modulePaths: new Set([...moduleIdsByPath.keys(), ...packageIds.keys()]),
    renamed: allocator.renamed,
    sourceId: (module, qualname, startLine) =>
      qualname
        ? (startLine ? memberIdsByOccurrence.get(occurrenceKey(module.file, qualname, startLine)) : undefined) ??
          memberIdsByFile.get(memberKey(module.file, qualname))
        : moduleIdsByFile.get(module.file),
    targetId: (modulePath, qualname, startLine) =>
      qualname
        ? (startLine
            ? memberIdsByTargetOccurrence.get(occurrenceKey(modulePath, qualname, startLine))
            : undefined) ?? memberIdsByPath.get(memberKey(modulePath, qualname))
        : moduleIdsByPath.get(modulePath) ?? packageIds.get(modulePath),
  };
}

function emitPackages(
  modules: AnalyzeModule[],
  nodes: GraphNode[],
  allocator: IdAllocator,
): Map<string, string> {
  const prefixes = packagePrefixes(modules);
  const initializers = new Map(
    modules.filter((module) => module.isPackage).map((module) => [graphModulePath(module), module]),
  );
  const ids = new Map<string, string>();
  for (const prefix of [...prefixes].sort(byDepth)) {
    const id = allocator.next(idOf(prefix));
    ids.set(prefix, id);
    nodes.push(packageNode(prefix, id, prefixes, ids, initializers.get(prefix)));
  }
  return ids;
}

function packagePrefixes(modules: AnalyzeModule[]): Set<string> {
  const prefixes = new Set<string>();
  for (const module of modules) {
    const graphPath = graphModulePath(module);
    const segments = graphPath.split(".");
    for (let depth = 1; depth < segments.length; depth += 1) prefixes.add(segments.slice(0, depth).join("."));
    if (module.isPackage) prefixes.add(graphPath);
  }
  if (prefixes.size === 0 && modules.length > 0) prefixes.add(ROOT_PACKAGE);
  return prefixes;
}

function packageNode(
  prefix: string,
  id: string,
  prefixes: ReadonlySet<string>,
  ids: ReadonlyMap<string, string>,
  initializer: AnalyzeModule | undefined,
): GraphNode {
  const parent = prefix.split(".").slice(0, -1).join(".");
  return {
    id,
    kind: "package",
    qualifiedName: prefix,
    displayName: prefix === ROOT_PACKAGE ? "project" : lastSegment(prefix),
    summary: null,
    parentId: parent && prefixes.has(parent) ? ids.get(parent) ?? null : null,
    location: initializer
      ? { file: initializer.file, startLine: 1, endLine: initializer.endLine }
      : { file: prefix === ROOT_PACKAGE ? "." : prefix, startLine: 1, endLine: 1 },
  };
}

function moduleNode(module: AnalyzeModule, id: string, packages: ReadonlyMap<string, string>): GraphNode {
  const modulePath = graphModulePath(module);
  const parent = modulePath.split(".").slice(0, -1).join(".");
  return {
    id,
    kind: "module",
    qualifiedName: modulePath,
    displayName: lastSegment(modulePath),
    summary: null,
    parentId: packages.get(parent) ?? packages.get(ROOT_PACKAGE) ?? null,
    location: { file: module.file, startLine: 1, endLine: module.endLine },
  };
}

function memberNode(module: AnalyzeModule, node: AnalyzeNode, id: string, parentId: string): GraphNode {
  const graphNode: GraphNode = {
    id,
    kind: node.kind as NodeKind,
    qualifiedName: node.qualname,
    displayName: node.name,
    summary: node.summary,
    parentId,
    location: { file: module.file, startLine: node.startLine, endLine: node.endLine, startCol: node.startCol },
  };
  if (node.signature) graphNode.signature = node.signature;
  if (node.tags.length > 0) graphNode.tags = node.tags;
  if (node.kind === "function" || node.kind === "method") graphNode.telemetry = telemetryFor(node);
  return graphNode;
}

function graphModulePath(module: AnalyzeModule): string {
  return module.isPackage ? module.modulePath.replace(/\.__init__$/, "") : module.modulePath;
}

function telemetryFor(node: AnalyzeNode): TelemetryKey {
  return {
    codeNamespace: node.parentQualname,
    codeFunction: node.name,
    spanNameHints: [...new Set([node.qualname, node.name])],
  };
}

class IdAllocator {
  private readonly counts = new Map<string, number>();
  renamed = 0;

  next(base: string): string {
    const count = this.counts.get(base) ?? 0;
    this.counts.set(base, count + 1);
    if (count === 0) return base;
    this.renamed += 1;
    return `${base}~${count}`;
  }
}

function idOf(modulePath: string, qualname?: string): string {
  return buildNodeId({ lang: LANG, modulePath, qualname });
}

function memberKey(module: string, qualname: string): string {
  return `${module}#${qualname}`;
}

function occurrenceKey(file: string, qualname: string, startLine: number): string {
  return `${memberKey(file, qualname)}@${startLine}`;
}

function byDepth(left: string, right: string): number {
  return left.split(".").length - right.split(".").length || left.localeCompare(right);
}

function lastSegment(dotted: string): string {
  return dotted.split(".").at(-1) ?? dotted;
}
