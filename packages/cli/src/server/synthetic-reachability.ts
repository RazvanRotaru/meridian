/** Static selection of the callables worth probing for one configured root. */

import type { GraphArtifact, JsonValue } from "@meridian/core";

const EXECUTION_EDGE_KINDS = new Set(["calls", "instantiates"]);

export interface CallableCandidate {
  id: string;
  file: string;
  line: number;
  name: string;
}

export function reachableCallableIds(artifact: GraphArtifact, rootId: string): Set<string> {
  const callables = new Set(
    artifact.nodes.filter((node) => node.kind === "function" || node.kind === "method").map((node) => node.id),
  );
  const outgoing = new Map<string, string[]>();
  for (const edge of artifact.edges) {
    if (!EXECUTION_EDGE_KINDS.has(edge.kind) || (edge.resolution !== undefined && edge.resolution !== "resolved")) continue;
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const flows = artifact.extensions?.logicFlow;
  const reached = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reached.has(current)) continue;
    reached.add(current);
    for (const target of outgoing.get(current) ?? []) {
      if (!reached.has(target)) pending.push(target);
    }
    if (isJsonRecord(flows)) {
      for (const target of flowTargets(flows[current])) {
        if (!reached.has(target)) pending.push(target);
      }
    }
  }
  return new Set([...reached].filter((id) => callables.has(id)));
}

export function callableCandidates(
  artifact: GraphArtifact,
  ids: ReadonlySet<string>,
): Map<string, CallableCandidate[]> {
  const result = new Map<string, CallableCandidate[]>();
  for (const node of artifact.nodes) {
    if (!ids.has(node.id)) continue;
    const candidate = {
      id: node.id,
      file: normalizeRelative(node.location.file),
      line: node.location.startLine,
      name: node.displayName,
    };
    const key = candidateKey(candidate.file, candidate.line, candidate.name);
    result.set(key, [...(result.get(key) ?? []), candidate]);
  }
  return result;
}

export function candidateKey(file: string, line: number, name: string): string {
  return `${normalizeRelative(file)}\u0000${line}\u0000${name}`;
}

export function normalizeRelative(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function flowTargets(value: JsonValue | undefined): string[] {
  const targets: string[] = [];
  const pending: JsonValue[] = value === undefined ? [] : [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (isJsonRecord(current)) {
      if (current.kind === "call" && typeof current.target === "string") targets.push(current.target);
      pending.push(...Object.values(current));
    }
  }
  return targets;
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
