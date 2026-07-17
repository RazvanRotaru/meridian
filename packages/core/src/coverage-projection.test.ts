import { describe, expect, it } from "vitest";
import {
  buildReachabilityProjection,
  filterReachabilityPaintFacts,
  parseReachabilityProjectionFacts,
  REACHABILITY_WORST_ROW_LIMIT,
} from "./coverage-projection";
import type { GraphEdge, GraphNode } from "./types";

describe("buildReachabilityProjection", () => {
  it("keeps the full summary and self-contained worst-container diagnoses", () => {
    const nodes = [
      node("src", "package", null, "src"),
      node("src/svc.ts", "module", "src", "src/svc.ts"),
      node("src/svc.ts#Svc", "class", "src/svc.ts", "src/svc.ts", "Svc"),
      node("src/svc.ts#Svc.direct", "method", "src/svc.ts#Svc", "src/svc.ts", "Svc.direct"),
      node("src/svc.ts#Svc.indirect", "method", "src/svc.ts#Svc", "src/svc.ts", "Svc.indirect"),
      node("src/gap.ts", "module", "src", "src/gap.ts"),
      node("src/gap.ts#Gap", "class", "src/gap.ts", "src/gap.ts", "Gap"),
      node("src/gap.ts#Gap.caller", "method", "src/gap.ts#Gap", "src/gap.ts", "Gap.caller"),
      node("src/gap.ts#Gap.victim", "method", "src/gap.ts#Gap", "src/gap.ts", "Gap.victim"),
      node("src/svc.test.ts", "module", "src", "src/svc.test.ts"),
      node("src/svc.test.ts#test", "function", "src/svc.test.ts", "src/svc.test.ts", "test direct"),
    ];
    const edges = [
      edge("test-direct", "src/svc.test.ts#test", "src/svc.ts#Svc.direct"),
      edge("direct-indirect", "src/svc.ts#Svc.direct", "src/svc.ts#Svc.indirect"),
      edge("gap", "src/gap.ts#Gap.caller", "src/gap.ts#Gap.victim"),
    ];

    const facts = buildReachabilityProjection(nodes, edges);

    expect(facts.summary).toEqual({
      callables: 4,
      covered: 1,
      indirect: 1,
      uncovered: 2,
      percent: 50,
      testNodes: 2,
      unresolvedFromTests: 0,
    });
    expect(facts.worstRows.map((row) => ({ name: row.name, percent: row.percent }))).toEqual([
      { name: "Gap", percent: 0 },
      { name: "Svc", percent: 100 },
    ]);
    expect(facts.worstRows[0]?.uncoveredMembers).toEqual([
      {
        id: "src/gap.ts#Gap.caller",
        name: "Gap.caller",
        reason: "never called in the graph — likely an entry point or dead code",
      },
      {
        id: "src/gap.ts#Gap.victim",
        name: "Gap.victim",
        reason: "only called by code not reachable from tests: Gap.caller",
      },
    ]);
    expect(parseReachabilityProjectionFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts);

    const nonCanonical = JSON.parse(JSON.stringify(facts));
    nonCanonical.leaves["src/svc.ts#Svc.direct"].directTestCallers = ["z-test", "a-test"];
    expect(() => parseReachabilityProjectionFacts(nonCanonical)).toThrow("reachability leaf references must be canonical");

    const malformed = JSON.parse(JSON.stringify(facts));
    malformed.containers["src/gap.ts#Gap"].percent = 99;
    expect(() => parseReachabilityProjectionFacts(malformed)).toThrow("invalid reachability projection facts");

    const oversized = JSON.parse(JSON.stringify(facts));
    while (oversized.worstRows.length <= REACHABILITY_WORST_ROW_LIMIT) oversized.worstRows.push(oversized.worstRows[0]);
    expect(() => parseReachabilityProjectionFacts(oversized)).toThrow("invalid reachability projection facts");
  });

  it("caps the stable worst-covered list at ten rows", () => {
    const nodes: GraphNode[] = [node("src", "package", null, "src")];
    for (let index = 11; index >= 0; index -= 1) {
      const suffix = String(index).padStart(2, "0");
      const moduleId = `src/gap-${suffix}.ts`;
      const containerId = `${moduleId}#Gap${suffix}`;
      nodes.push(
        node(moduleId, "module", "src", moduleId),
        node(containerId, "class", moduleId, moduleId, `Gap${suffix}`),
        node(`${containerId}.miss`, "method", containerId, moduleId, `Gap${suffix}.miss`),
      );
    }

    const facts = buildReachabilityProjection(nodes, []);

    expect(facts.worstRows).toHaveLength(REACHABILITY_WORST_ROW_LIMIT);
    expect(facts.worstRows.map((row) => row.name)).toEqual([
      "Gap00", "Gap01", "Gap02", "Gap03", "Gap04", "Gap05", "Gap06", "Gap07", "Gap08", "Gap09",
    ]);
  });
});

describe("filterReachabilityPaintFacts", () => {
  it("retains leaf and container paint only for returned node ids", () => {
    const nodes = [
      node("src", "package", null, "src"),
      node("src/a.ts", "module", "src", "src/a.ts"),
      node("src/a.ts#A", "class", "src/a.ts", "src/a.ts"),
      node("src/a.ts#A.one", "method", "src/a.ts#A", "src/a.ts"),
      node("src/a.ts#A.two", "method", "src/a.ts#A", "src/a.ts"),
    ];
    const facts = buildReachabilityProjection(nodes, []);

    const filtered = filterReachabilityPaintFacts(facts, new Set(["src/a.ts#A", "src/a.ts#A.two", "missing"]));

    expect(Object.keys(filtered.containers)).toEqual(["src/a.ts#A"]);
    expect(Object.keys(filtered.leaves)).toEqual(["src/a.ts#A.two"]);
    expect(filtered.leaves["src/a.ts#A.two"]).toBe(facts.leaves["src/a.ts#A.two"]);
    expect(parseReachabilityProjectionFacts({
      summary: facts.summary,
      worstRows: facts.worstRows,
      ...filtered,
    })).toEqual({ summary: facts.summary, worstRows: facts.worstRows, ...filtered });
  });
});

function node(
  id: string,
  kind: string,
  parentId: string | null,
  file: string,
  qualifiedName = id,
): GraphNode {
  return {
    id,
    kind,
    parentId,
    qualifiedName,
    displayName: qualifiedName,
    location: { file, startLine: 1 },
  };
}

function edge(id: string, source: string, target: string): GraphEdge {
  return { id, source, target, kind: "calls", resolution: "resolved" };
}
