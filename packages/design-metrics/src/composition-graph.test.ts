/**
 * Coupling-edge derivation: the peer-dependency wires between composition units. Fixtures are
 * hand-built graphs so unit mapping, containment exclusion, per-pair dedupe, and the
 * inheritance-only flag are each pinned independently of any extractor.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@meridian/core";
import { couplingEdges } from "./composition-graph";

function node(id: string, kind: string, parentId?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId: parentId ?? null,
    location: { file: "f.ts", startLine: 1 },
  } as GraphNode;
}

function edge(source: string, target: string, kind = "calls"): GraphEdge {
  return { id: `${kind}:${source}->${target}`, source, target, kind } as GraphEdge;
}

describe("couplingEdges", () => {
  it("maps a cross-class call to one peer edge between the owning units", () => {
    const nodes = [
      node("ts:m", "module"),
      node("ts:m#A", "class", "ts:m"),
      node("ts:m#A.a1", "method", "ts:m#A"),
      node("ts:m#B", "class", "ts:m"),
      node("ts:m#B.b1", "method", "ts:m#B"),
    ];
    const result = couplingEdges(nodes, [edge("ts:m#A.a1", "ts:m#B.b1")]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: "ts:m#A", target: "ts:m#B", inheritanceOnly: false });
    expect([...result[0].kinds]).toEqual(["calls"]);
  });

  it("drops a module → its-own-class edge as containment, not a peer dependency", () => {
    // A module's top-level function calls a method of a class declared inside that module: source
    // unit is the module, target unit is the class it contains — a frame (PR3), never a peer wire.
    const nodes = [
      node("ts:m", "module"),
      node("ts:m#f", "function", "ts:m"),
      node("ts:m#A", "class", "ts:m"),
      node("ts:m#A.a1", "method", "ts:m#A"),
    ];
    expect(couplingEdges(nodes, [edge("ts:m#f", "ts:m#A.a1")])).toEqual([]);
  });

  it("dedupes a unit pair while retaining exact per-kind weights and evidence ids", () => {
    const nodes = [
      node("ts:m", "module"),
      node("ts:m#A", "class", "ts:m"),
      node("ts:m#A.a1", "method", "ts:m#A"),
      node("ts:m#A.a2", "method", "ts:m#A"),
      node("ts:m#B", "class", "ts:m"),
      node("ts:m#B.b1", "method", "ts:m#B"),
      node("ts:m#B.b2", "method", "ts:m#B"),
    ];
    const first = edge("ts:m#A.a1", "ts:m#B.b1");
    first.weight = 2;
    const second = edge("ts:m#A.a2", "ts:m#B.b2");
    const inheritance = edge("ts:m#A", "ts:m#B", "implements");
    const registration = edge("ts:m#A.a1", "ts:m#B", "registers");
    const edges = [first, second, inheritance, registration];
    const result = couplingEdges(nodes, edges);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: "ts:m#A", target: "ts:m#B" });
    expect([...result[0].kinds].sort()).toEqual(["calls", "implements", "registers"]);
    expect(result[0].evidenceByKind?.get("calls")).toEqual({
      weight: 3,
      underlyingEdgeIds: [first.id, second.id],
    });
    expect(result[0].evidenceByKind?.get("implements")).toEqual({
      weight: 1,
      underlyingEdgeIds: [inheritance.id],
    });
    expect(result[0].evidenceByKind?.get("registers")).toEqual({
      weight: 1,
      underlyingEdgeIds: [registration.id],
    });
  });

  it("flags an extends-only pair as inheritanceOnly", () => {
    const nodes = [node("ts:m", "module"), node("ts:m#A", "class", "ts:m"), node("ts:m#B", "class", "ts:m")];
    const result = couplingEdges(nodes, [edge("ts:m#A", "ts:m#B", "extends")]);
    expect(result).toHaveLength(1);
    expect(result[0].inheritanceOnly).toBe(true);
  });

  it("does not flag inheritanceOnly when a call also links the pair", () => {
    const nodes = [
      node("ts:m", "module"),
      node("ts:m#A", "class", "ts:m"),
      node("ts:m#A.a1", "method", "ts:m#A"),
      node("ts:m#B", "class", "ts:m"),
      node("ts:m#B.b1", "method", "ts:m#B"),
    ];
    const edges = [edge("ts:m#A", "ts:m#B", "extends"), edge("ts:m#A.a1", "ts:m#B.b1")];
    const result = couplingEdges(nodes, edges);
    expect(result).toHaveLength(1);
    expect(result[0].inheritanceOnly).toBe(false);
    expect([...result[0].kinds].sort()).toEqual(["calls", "extends"]);
  });

  it("ignores external and same-unit couplings", () => {
    const nodes = [
      node("ts:m", "module"),
      node("ts:m#A", "class", "ts:m"),
      node("ts:m#A.a1", "method", "ts:m#A"),
      node("ts:m#A.a2", "method", "ts:m#A"),
    ];
    const edges = [edge("ts:m#A.a1", "ts:m#A.a2"), edge("ts:m#A.a1", "ext:lib#x")];
    expect(couplingEdges(nodes, edges)).toEqual([]);
  });
});
