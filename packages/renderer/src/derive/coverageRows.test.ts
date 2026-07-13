/** coverageRows: the pure shaping behind the coverage panel — grouping, ordering, reasons. */

import { describe, expect, it } from "vitest";
import { computeCoverage } from "@meridian/core";
import type { GraphArtifact, GraphEdge, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { buildCoverageRows } from "./coverageRows";

function node(id: string, kind: string, file: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id.split(/[#.]/).pop() ?? id, parentId, location: { file, startLine: 1 } };
}

function callsEdge(source: string, target: string): GraphEdge {
  return { id: `calls@${source}|${target}`, source, target, kind: "calls", resolution: "resolved" };
}

// Svc: place covered / cancel uncovered (50%); Email.send uncovered via uncovered caller (0%).
const NODES: GraphNode[] = [
  node("ts:src", "package", "src"),
  node("ts:src/svc.ts", "module", "src/svc.ts", "ts:src"),
  node("ts:src/svc.ts#Svc", "class", "src/svc.ts", "ts:src/svc.ts"),
  node("ts:src/svc.ts#Svc.place", "method", "src/svc.ts", "ts:src/svc.ts#Svc"),
  node("ts:src/svc.ts#Svc.cancel", "method", "src/svc.ts", "ts:src/svc.ts#Svc"),
  node("ts:src/email.ts", "module", "src/email.ts", "ts:src"),
  node("ts:src/email.ts#Email", "class", "src/email.ts", "ts:src/email.ts"),
  node("ts:src/email.ts#Email.send", "method", "src/email.ts", "ts:src/email.ts#Email"),
  node("ts:src/svc.test.ts", "module", "src/svc.test.ts", "ts:src"),
  node("ts:src/svc.test.ts#t1", "function", "src/svc.test.ts", "ts:src/svc.test.ts"),
];

const EDGES: GraphEdge[] = [
  callsEdge("ts:src/svc.test.ts#t1", "ts:src/svc.ts#Svc.place"),
  callsEdge("ts:src/svc.ts#Svc.cancel", "ts:src/email.ts#Email.send"),
];

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-03T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: NODES,
  edges: EDGES,
};

describe("buildCoverageRows", () => {
  const index = buildGraphIndex(ARTIFACT);
  const rows = buildCoverageRows(computeCoverage(ARTIFACT.nodes, ARTIFACT.edges), index);

  it("emits one row per container that directly holds callables, worst first", () => {
    expect(rows.map((row) => row.id)).toEqual(["ts:src/email.ts#Email", "ts:src/svc.ts#Svc"]);
    expect(rows[0]).toMatchObject({ percent: 0, covered: 0, total: 1 });
    expect(rows[1]).toMatchObject({ percent: 50, covered: 1, total: 2 });
  });

  it("lists uncovered members with a human reason", () => {
    const email = rows[0];
    expect(email.uncoveredMembers).toHaveLength(1);
    expect(email.uncoveredMembers[0].name).toBe("send");
    expect(email.uncoveredMembers[0].reason).toContain("only called by code not reachable from tests");
    expect(email.uncoveredMembers[0].reason).toContain("Svc.cancel");

    const svc = rows[1];
    expect(svc.uncoveredMembers.map((member) => member.name)).toEqual(["cancel"]);
    expect(svc.uncoveredMembers[0].reason).toContain("never called");
  });

  it("never emits rows for test containers", () => {
    expect(rows.some((row) => row.id.includes("test"))).toBe(false);
  });
});
