/**
 * Selection → seeds: a file card seeds itself, a group card seeds every file module in its subtree,
 * anything else (unknown ids, members below file level) contributes nothing, and the result is
 * deduped + sorted.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { seedModuleIdsFor } from "./selectionSeeds";

function node(id: string, kind: string, parentId: string | null): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file: `${id}.ts`, startLine: 1 } } as GraphNode;
}

const NODES = [
  node("p:root", "package", null),
  node("p:src", "package", "p:root"),
  node("m:a", "module", "p:src"),
  node("m:b", "module", "p:src"),
  node("fn:a1", "function", "m:a"),
  node("p:lib", "package", "p:root"),
  node("m:c", "module", "p:lib"),
];

function seedsFor(selected: string[]): string[] {
  const index = buildGraphIndex({ nodes: NODES, edges: [] } as unknown as GraphArtifact);
  return seedModuleIdsFor(index, selected);
}

describe("seedModuleIdsFor", () => {
  it("keeps selected file modules as their own seeds", () => {
    expect(seedsFor(["m:a", "m:c"])).toEqual(["m:a", "m:c"]);
  });

  it("expands a selected group card to every file module in its subtree", () => {
    expect(seedsFor(["p:src"])).toEqual(["m:a", "m:b"]);
  });

  it("dedupes overlapping picks (a package plus a file inside it) and sorts", () => {
    expect(seedsFor(["p:src", "m:b", "m:c"])).toEqual(["m:a", "m:b", "m:c"]);
  });

  it("drops ids that are not in the graph and never descends below a file", () => {
    expect(seedsFor(["ghost:x", "fn:a1"])).toEqual([]);
  });
});
