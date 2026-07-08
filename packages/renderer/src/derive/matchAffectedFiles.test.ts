/**
 * Path -> module-node matching: exact wins over suffix, longest suffix wins over shorter, the
 * monorepo duplicated-tail trap reports ambiguous, and matching is ALWAYS on location.file
 * (normalized) so Python's dotted ids resolve while a dotted path never spuriously matches.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { matchAffectedFiles, normalizePath } from "./matchAffectedFiles";

function moduleNode(id: string, file: string): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId: null, location: { file, startLine: 1 } } as GraphNode;
}

function indexOf(nodes: GraphNode[]) {
  return buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);
}

describe("normalizePath", () => {
  it("converts backslashes and strips leading ./ segments", () => {
    expect(normalizePath("./src\\a\\b.ts")).toBe("src/a/b.ts");
    expect(normalizePath("././x.ts")).toBe("x.ts");
  });
});

describe("matchAffectedFiles", () => {
  it("matches an exact location.file", () => {
    const result = matchAffectedFiles(indexOf([moduleNode("ts:src/a.ts", "src/a.ts")]), ["src/a.ts"]);
    expect(result.matched).toEqual([{ path: "src/a.ts", moduleId: "ts:src/a.ts", file: "src/a.ts" }]);
    expect(result.unmatched).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("prefers the longest /-boundary suffix over a shorter one", () => {
    const nodes = [moduleNode("deep", "src/derive/foo.ts"), moduleNode("shallow", "foo.ts")];
    const result = matchAffectedFiles(indexOf(nodes), ["packages/renderer/src/derive/foo.ts"]);
    expect(result.matched.map((m) => m.moduleId)).toEqual(["deep"]);
  });

  it("reports ambiguous when two nodes share the exact same file", () => {
    const nodes = [moduleNode("a", "src/index.ts"), moduleNode("b", "src/index.ts")];
    const result = matchAffectedFiles(indexOf(nodes), ["src/index.ts"]);
    expect(result.matched).toEqual([]);
    expect(result.ambiguous).toEqual([{ path: "src/index.ts", candidates: ["a", "b"] }]);
  });

  it("reports ambiguous on the monorepo duplicated-tail trap (equal-length suffixes)", () => {
    const nodes = [moduleNode("pkgA", "src/index.ts"), moduleNode("pkgB", "src/index.ts")];
    const result = matchAffectedFiles(indexOf(nodes), ["packages/foo/src/index.ts"]);
    expect(result.ambiguous).toEqual([{ path: "packages/foo/src/index.ts", candidates: ["pkgA", "pkgB"] }]);
    expect(result.matched).toEqual([]);
  });

  it("reports unmatched when nothing lines up", () => {
    const result = matchAffectedFiles(indexOf([moduleNode("a", "src/a.ts")]), ["src/b.ts"]);
    expect(result.unmatched).toEqual(["src/b.ts"]);
    expect(result.matched).toEqual([]);
  });

  it("matches a Python dotted-id node by its location.file, not its dotted id", () => {
    const index = indexOf([moduleNode("py:orders.pricing", "orders/pricing.py")]);
    expect(matchAffectedFiles(index, ["orders/pricing.py"]).matched.map((m) => m.moduleId)).toEqual(["py:orders.pricing"]);
    expect(matchAffectedFiles(index, ["orders.pricing"]).unmatched).toEqual(["orders.pricing"]);
  });

  it("normalizes both candidate and location.file before comparing", () => {
    const index = indexOf([moduleNode("a", "src\\a.ts")]);
    expect(matchAffectedFiles(index, ["./src/a.ts"]).matched.map((m) => m.moduleId)).toEqual(["a"]);
    expect(matchAffectedFiles(index, ["repo\\src\\a.ts"]).matched.map((m) => m.moduleId)).toEqual(["a"]);
  });

  it("dedupes candidates that normalize to the same path", () => {
    const index = indexOf([moduleNode("a", "src/a.ts")]);
    expect(matchAffectedFiles(index, ["src/a.ts", "./src/a.ts"]).matched).toHaveLength(1);
  });
});
