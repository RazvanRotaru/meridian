/**
 * Affected files -> node sets: the seed MODULE nodes, and EVERY node in an affected file regardless
 * of kind, matched by location.file so Python's dotted member ids are included too.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { affectedNodes } from "./affectedNodes";

function node(id: string, kind: string, file: string, parentId: string | null = null): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file, startLine: 1 } } as GraphNode;
}

function indexOf(nodes: GraphNode[]) {
  return buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);
}

const nodes = [
  node("m:svc", "module", "src/svc.ts"),
  node("m:svc#run", "function", "src/svc.ts", "m:svc"),
  node("m:svc#C", "class", "src/svc.ts", "m:svc"),
  node("m:other", "module", "src/other.ts"),
  node("m:other#x", "function", "src/other.ts", "m:other"),
];

describe("affectedNodes", () => {
  it("collects every node in an affected file, any kind, and the seed modules", () => {
    const result = affectedNodes(indexOf(nodes), ["src/svc.ts"]);
    expect(result.seedModuleIds).toEqual(new Set(["m:svc"]));
    expect(result.affectedCallableIds).toEqual(new Set(["m:svc", "m:svc#run", "m:svc#C"]));
    expect(result.affectedFilesResolved).toEqual(["src/svc.ts"]);
  });

  it("normalizes affected paths and reports resolved files sorted and deduped", () => {
    const result = affectedNodes(indexOf(nodes), ["./src/other.ts", "src/svc.ts", "src\\svc.ts"]);
    expect(result.affectedFilesResolved).toEqual(["src/other.ts", "src/svc.ts"]);
    expect(result.seedModuleIds).toEqual(new Set(["m:svc", "m:other"]));
  });

  it("includes Python dotted member ids by location.file", () => {
    const python = [node("py:pkg.mod", "module", "pkg/mod.py"), node("py:pkg.mod.func", "function", "pkg/mod.py", "py:pkg.mod")];
    const result = affectedNodes(indexOf(python), ["pkg/mod.py"]);
    expect(result.affectedCallableIds).toEqual(new Set(["py:pkg.mod", "py:pkg.mod.func"]));
  });
});
