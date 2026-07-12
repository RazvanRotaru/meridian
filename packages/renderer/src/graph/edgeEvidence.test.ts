import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import type { GraphEdge } from "@meridian/core";
import { BUNDLE_EDGE_TYPE } from "../layout/edgeBundling";
import { CYCLE_EDGE_TYPE } from "../layout/cycleFusion";
import { RIBBON_EDGE_TYPE } from "../layout/parallelWires";
import {
  artifactLinksForWire,
  edgeEvidenceForPair,
  formatCallSite,
} from "./edgeEvidence";

const CALL: GraphEdge = {
  id: "calls@ts:a.ts#A.run|ts:b.ts#B.go",
  source: "ts:a.ts#A.run",
  target: "ts:b.ts#B.go",
  kind: "calls",
  callSites: [{ file: "src/a.ts", line: 10, col: 3, endLine: 12, endCol: 8 }],
};
const REGISTERS: GraphEdge = {
  id: "registers@ts:a.ts#A.run|ts:c.ts#C",
  source: "ts:a.ts#A.run",
  target: "ts:c.ts#C",
  kind: "registers",
  callSites: [
    { file: "src/a.ts", line: 20, col: 5, endLine: 20, endCol: 28 },
    { file: "src/a.ts", line: 30 },
  ],
};
const EDGES = new Map([CALL, REGISTERS].map((edge) => [edge.id, edge]));

const callWire: Edge = {
  id: "visual:calls",
  source: "card:a",
  target: "card:b",
  data: { underlyingEdgeIds: [CALL.id] },
};
const registersWire: Edge = {
  id: "visual:registers",
  source: "card:a",
  target: "card:b",
  data: { underlyingEdgeIds: [REGISTERS.id] },
};

describe("wire source evidence", () => {
  it("resolves a plain visual edge to its concrete artifact link and exact source range", () => {
    expect(artifactLinksForWire(callWire, EDGES)).toEqual([CALL]);
    expect(edgeEvidenceForPair([callWire], EDGES)).toEqual([
      {
        edgeId: CALL.id,
        source: CALL.source,
        target: CALL.target,
        kind: "calls",
        site: CALL.callSites![0],
      },
    ]);
  });

  it("flattens ribbon, cycle, and highway members while preserving clicked-story order", () => {
    const ribbon: Edge = {
      id: "ribbon",
      source: "card:a",
      target: "card:b",
      type: RIBBON_EDGE_TYPE,
      data: { members: [registersWire, callWire] },
    };
    const cycle: Edge = {
      id: "cycle",
      source: "card:a",
      target: "card:b",
      type: CYCLE_EDGE_TYPE,
      data: { members: [ribbon, callWire] },
    };
    const highway: Edge = {
      id: "highway",
      source: "frame:a",
      target: "frame:b",
      type: BUNDLE_EDGE_TYPE,
      data: { constituents: [cycle, registersWire] },
    };

    expect(artifactLinksForWire(highway, EDGES)).toEqual([REGISTERS, CALL]);
    const contexts = edgeEvidenceForPair([highway], EDGES);
    expect(contexts.map((entry) => [entry.kind, entry.site.line])).toEqual([
      ["registers", 20],
      ["registers", 30],
      ["calls", 10],
    ]);
  });

  it("deduplicates repeated aggregate members and ignores unattributed presentation wires", () => {
    expect(edgeEvidenceForPair([callWire, callWire], EDGES)).toHaveLength(1);
    expect(edgeEvidenceForPair([{ id: "x", source: "a", target: "b" }], EDGES)).toEqual([]);
  });

  it("formats point, same-line, and multi-line evidence precisely", () => {
    expect(formatCallSite({ file: "a.ts", line: 7 })).toBe("a.ts:7");
    expect(formatCallSite({ file: "a.ts", line: 7, col: 2, endLine: 7, endCol: 9 })).toBe("a.ts:7:2–9");
    expect(formatCallSite(CALL.callSites![0]!)).toBe("src/a.ts:10:3–12:8");
  });
});
