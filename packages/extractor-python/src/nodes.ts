/**
 * Pass 1 — nodes. Synthesizes `package` nodes from dotted module prefixes, one `module` node
 * per analyzed module, and a node per analyzer class/function/method. Telemetry is stamped on
 * callables only. Emitted parent-before-child so `parentId` always points at an earlier node.
 */

import { buildNodeId } from "@meridian/core";
import type { GraphNode, NodeKind, TelemetryKey } from "@meridian/core";
import type { AnalyzeModule, AnalyzeNode, AnalyzeOutput } from "./types";

const LANG = "py";

export interface NodeIndex {
  nodes: GraphNode[];
  ids: Set<string>;
  kindById: Map<string, NodeKind>;
}

export function buildNodes(output: AnalyzeOutput): NodeIndex {
  const nodes: GraphNode[] = [];
  emitPackages(output.modules, nodes);
  for (const module of output.modules) {
    nodes.push(moduleNode(module));
    for (const node of module.nodes) {
      nodes.push(memberNode(module, node));
    }
  }
  const kindById = new Map(nodes.map((node) => [node.id, node.kind]));
  return { nodes, ids: new Set(kindById.keys()), kindById };
}

/** Any dotted prefix that is an ancestor of a module becomes a package, shallow ones first. */
function emitPackages(modules: AnalyzeModule[], nodes: GraphNode[]): void {
  const prefixes = new Set<string>();
  for (const module of modules) {
    const segments = module.modulePath.split(".");
    for (let depth = 1; depth < segments.length; depth += 1) {
      prefixes.add(segments.slice(0, depth).join("."));
    }
  }
  for (const prefix of [...prefixes].sort(byDepth)) {
    nodes.push(packageNode(prefix, prefixes));
  }
}

function byDepth(left: string, right: string): number {
  const delta = left.split(".").length - right.split(".").length;
  return delta !== 0 ? delta : left.localeCompare(right);
}

function packageNode(prefix: string, prefixes: ReadonlySet<string>): GraphNode {
  const parent = prefix.split(".").slice(0, -1).join(".");
  return {
    id: idOf(prefix),
    kind: "package",
    qualifiedName: prefix,
    displayName: lastSegment(prefix),
    summary: null,
    parentId: parent && prefixes.has(parent) ? idOf(parent) : null,
    location: { file: prefix, startLine: 1, endLine: 1 },
  };
}

function moduleNode(module: AnalyzeModule): GraphNode {
  const parent = module.modulePath.split(".").slice(0, -1).join(".");
  return {
    id: idOf(module.modulePath),
    kind: "module",
    qualifiedName: module.modulePath,
    displayName: lastSegment(module.modulePath),
    summary: null,
    parentId: parent ? idOf(parent) : null,
    location: { file: module.file, startLine: 1 },
  };
}

function memberNode(module: AnalyzeModule, node: AnalyzeNode): GraphNode {
  const graphNode: GraphNode = {
    id: idOf(module.modulePath, node.qualname),
    kind: node.kind as NodeKind,
    qualifiedName: node.qualname,
    displayName: node.name,
    summary: node.summary,
    parentId: node.parentQualname ? idOf(module.modulePath, node.parentQualname) : idOf(module.modulePath),
    location: { file: module.file, startLine: node.startLine, endLine: node.endLine },
  };
  if (node.signature) graphNode.signature = node.signature;
  if (node.tags.length > 0) graphNode.tags = node.tags;
  if (node.kind === "function" || node.kind === "method") graphNode.telemetry = telemetryFor(node);
  return graphNode;
}

function telemetryFor(node: AnalyzeNode): TelemetryKey {
  return {
    codeNamespace: node.parentQualname,
    codeFunction: node.name,
    spanNameHints: [...new Set([node.qualname, node.name])],
  };
}

function idOf(modulePath: string, qualname?: string): string {
  return buildNodeId({ lang: LANG, modulePath, qualname });
}

function lastSegment(dotted: string): string {
  return dotted.split(".").at(-1) ?? dotted;
}
