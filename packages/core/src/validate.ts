/**
 * Two-tier artifact validation.
 *
 * Tier 1 is the zod schema (structural shape). Tier 2 is the cross-array invariants zod
 * cannot express: id uniqueness, parentId acyclicity, edge-endpoint existence, edge-id
 * determinism, and the never-default-prod telemetry contract. Unknown vocabulary is a
 * warning, never an error.
 */

import { graphArtifactSchema } from "./schema";
import { rankOfKind } from "./extractor";
import type { GraphArtifact, GraphEdge, GraphNode } from "./types";

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  artifact?: GraphArtifact;
}

const KNOWN_NODE_KINDS = new Set([
  "package", "module", "namespace", "class", "interface", "enum", "typeAlias", "function", "method",
  "external", "unresolved", "channel", "system",
]);
const KNOWN_EDGE_KINDS = new Set([
  "calls", "references", "imports", "extends", "implements", "instantiates", "renders",
  "sends", "handles",
]);

export function validateArtifact(input: unknown): ValidationResult {
  const parsed = graphArtifactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: toSchemaIssues(parsed.error), warnings: [] };
  }
  const artifact = parsed.data as GraphArtifact;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodeIds = collectNodeIds(artifact.nodes, errors);
  checkParentIntegrity(artifact.nodes, nodeIds, errors);
  checkEdgeIntegrity(artifact.edges, nodeIds, errors);
  checkTelemetryContract(artifact, errors);
  lintVocabulary(artifact, warnings);
  return { ok: errors.length === 0, errors, warnings, artifact };
}

function toSchemaIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): ValidationIssue[] {
  return error.issues.map((issue) => ({
    code: "SCHEMA",
    message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  }));
}

function collectNodeIds(nodes: GraphNode[], errors: ValidationIssue[]): Set<string> {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      errors.push({ code: "DUPLICATE_NODE_ID", message: `duplicate node id: ${node.id}` });
    }
    seen.add(node.id);
  }
  return seen;
}

function checkParentIntegrity(nodes: GraphNode[], nodeIds: Set<string>, errors: ValidationIssue[]): void {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId ?? null]));
  for (const node of nodes) {
    const parentId = node.parentId;
    if (parentId && !nodeIds.has(parentId)) {
      errors.push({ code: "DANGLING_PARENT", message: `node ${node.id} has unknown parentId ${parentId}` });
    }
    if (hasCycle(node.id, parentOf)) {
      errors.push({ code: "PARENT_CYCLE", message: `node ${node.id} is part of a parentId cycle` });
    }
  }
}

function hasCycle(start: string, parentOf: Map<string, string | null>): boolean {
  const visited = new Set<string>();
  let current: string | null | undefined = start;
  while (current) {
    if (visited.has(current)) {
      return true;
    }
    visited.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

function checkEdgeIntegrity(edges: GraphEdge[], nodeIds: Set<string>, errors: ValidationIssue[]): void {
  for (const edge of edges) {
    checkEdgeId(edge, errors);
    checkEdgeWeight(edge, errors);
    checkEdgeEndpoints(edge, nodeIds, errors);
  }
}

function checkEdgeId(edge: GraphEdge, errors: ValidationIssue[]): void {
  const expected = `${edge.kind}@${edge.source}|${edge.target}`;
  if (edge.id !== expected) {
    errors.push({ code: "EDGE_ID_MISMATCH", message: `edge id ${edge.id} should be ${expected}` });
  }
}

function checkEdgeWeight(edge: GraphEdge, errors: ValidationIssue[]): void {
  if (edge.weight !== undefined && edge.callSites && edge.weight !== edge.callSites.length) {
    errors.push({
      code: "WEIGHT_MISMATCH",
      message: `edge ${edge.id} weight ${edge.weight} != ${edge.callSites.length} call sites`,
    });
  }
}

function checkEdgeEndpoints(edge: GraphEdge, nodeIds: Set<string>, errors: ValidationIssue[]): void {
  if (!nodeIds.has(edge.source)) {
    errors.push({ code: "DANGLING_EDGE_SOURCE", message: `edge ${edge.id} source ${edge.source} is not a node` });
  }
  const resolution = edge.resolution ?? "resolved";
  if (resolution === "resolved" && !nodeIds.has(edge.target)) {
    errors.push({ code: "DANGLING_EDGE_TARGET", message: `resolved edge ${edge.id} target ${edge.target} is not a node` });
  }
}

function checkTelemetryContract(artifact: GraphArtifact, errors: ValidationIssue[]): void {
  if (artifact.telemetry && artifact.telemetry.serviceDefaulting !== "forbidden") {
    errors.push({ code: "SERVICE_DEFAULTING", message: "telemetry.serviceDefaulting must be 'forbidden'" });
  }
}

function lintVocabulary(artifact: GraphArtifact, warnings: ValidationIssue[]): void {
  for (const node of artifact.nodes) {
    if (!KNOWN_NODE_KINDS.has(node.kind)) {
      warnings.push({ code: "UNKNOWN_NODE_KIND", message: `node ${node.id} has unregistered kind '${node.kind}'` });
    }
  }
  for (const edge of artifact.edges) {
    if (!KNOWN_EDGE_KINDS.has(edge.kind)) {
      warnings.push({ code: "UNKNOWN_EDGE_KIND", message: `edge ${edge.id} has unregistered kind '${edge.kind}'` });
    }
  }
}

/** Whether a node survives a `--depth` collapse to the given rank. */
export function isWithinDepth(node: GraphNode, maxRank: number): boolean {
  return rankOfKind(node.kind) <= maxRank;
}
