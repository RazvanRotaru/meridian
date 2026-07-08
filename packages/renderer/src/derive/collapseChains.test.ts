/**
 * Package-chain collapse over the kept subtree: a single-kept-child ladder folds into one frame
 * labeled with the joined path segments; a branch (>=2 kept children) or a file child stops it. The
 * DEEPEST package survives as the frame; pass-through ancestors are absorbed; parents skip them.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { collapseChains } from "./collapseChains";

function pkg(id: string, name: string, parentId: string | null): GraphNode {
  return { id, kind: "package", qualifiedName: id, displayName: name, parentId, location: { file: name, startLine: 1 } } as GraphNode;
}

function mod(id: string, parentId: string): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId, location: { file: `${id}.ts`, startLine: 1 } } as GraphNode;
}

function collapseOf(nodes: GraphNode[]) {
  const index = buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);
  return collapseChains(index, new Set(nodes.map((node) => node.id)));
}

describe("collapseChains", () => {
  it("folds a maximal single-child package chain into one frame labeled with joined segments", () => {
    const nodes = [
      pkg("p:packages", "packages", null),
      pkg("p:renderer", "renderer", "p:packages"),
      pkg("p:src", "src", "p:renderer"),
      pkg("p:derive", "derive", "p:src"),
      mod("m:foo", "p:derive"),
    ];
    const collapse = collapseOf(nodes);
    expect(collapse.absorbed).toEqual(new Set(["p:packages", "p:renderer", "p:src"]));
    expect(collapse.labelById.get("p:derive")).toBe("packages/renderer/src/derive");
    expect(collapse.parentById.get("p:derive")).toBeNull();
    expect(collapse.parentById.get("m:foo")).toBe("p:derive");
  });

  it("stops a chain at a branch and starts a fresh label below it", () => {
    const nodes = [
      pkg("p:packages", "packages", null),
      pkg("p:renderer", "renderer", "p:packages"),
      pkg("p:src", "src", "p:renderer"),
      pkg("p:derive", "derive", "p:src"),
      mod("m:foo", "p:derive"),
      pkg("p:core", "core", "p:packages"),
      mod("m:bar", "p:core"),
    ];
    const collapse = collapseOf(nodes);
    expect(collapse.absorbed).toEqual(new Set(["p:renderer", "p:src"]));
    expect(collapse.parentById.get("p:packages")).toBeNull();
    expect(collapse.labelById.has("p:packages")).toBe(false);
    expect(collapse.labelById.get("p:derive")).toBe("renderer/src/derive");
    expect(collapse.parentById.get("p:derive")).toBe("p:packages");
    expect(collapse.parentById.get("p:core")).toBe("p:packages");
    expect(collapse.labelById.has("p:core")).toBe(false);
  });

  it("never collapses a package whose single kept child is a file", () => {
    const nodes = [pkg("p:src", "src", null), mod("m:only", "p:src")];
    const collapse = collapseOf(nodes);
    expect(collapse.absorbed.size).toBe(0);
    expect(collapse.labelById.size).toBe(0);
    expect(collapse.parentById.get("p:src")).toBeNull();
    expect(collapse.parentById.get("m:only")).toBe("p:src");
  });
});
