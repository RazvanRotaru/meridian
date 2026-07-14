import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@meridian/core";
import { collapseToDepth } from "./depth-collapse";

function node(id: string, kind: string, parentId: string | null): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file: "contract.ts", startLine: 1 },
  };
}

function edge(kind: string, source: string, target: string): GraphEdge {
  return {
    id: `${kind}@${source}|${target}`,
    kind,
    source,
    target,
    resolution: "resolved",
    weight: 1,
    callSites: [{ file: "contract.ts", line: 1 }],
  };
}

describe("collapseToDepth implementation edges", () => {
  it("drops method-level implementedBy instead of lifting it into a duplicate type edge", () => {
    const nodes = [
      node("ts:contract.ts", "module", null),
      node("ts:contract.ts#Contract", "interface", "ts:contract.ts"),
      node("ts:contract.ts#Contract.run", "method", "ts:contract.ts#Contract"),
      node("ts:contract.ts#Service", "class", "ts:contract.ts"),
      node("ts:contract.ts#Service.run", "method", "ts:contract.ts#Service"),
    ];
    const implementsEdge = edge("implements", "ts:contract.ts#Service", "ts:contract.ts#Contract");
    const implementedBy = edge(
      "implementedBy",
      "ts:contract.ts#Contract.run",
      "ts:contract.ts#Service.run",
    );

    const collapsed = collapseToDepth(nodes, [implementsEdge, implementedBy], "class");

    expect(collapsed.edges).toEqual([implementsEdge]);
  });
});
