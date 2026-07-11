/**
 * Path -> module-node matching: exact wins over suffix, longest suffix wins over shorter, the
 * monorepo duplicated-tail trap reports ambiguous, and matching is ALWAYS on location.file
 * (normalized) so Python's dotted ids resolve while a dotted path never spuriously matches.
 */

import { describe, expect, it } from "vitest";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { matchAffectedFiles, normalizePath, type FileMatch } from "./matchAffectedFiles";
import { rollupSeeds } from "./seedRollup";

function moduleNode(id: string, file: string): GraphNode {
  return { id, kind: "module", qualifiedName: id, displayName: id, parentId: null, location: { file, startLine: 1 } } as GraphNode;
}

function indexOf(nodes: GraphNode[]) {
  return buildGraphIndex({ nodes, edges: [] } as unknown as GraphArtifact);
}

function packageNode(id: string): GraphNode {
  return { id, kind: "package", qualifiedName: id, displayName: id, parentId: null, location: { file: id, startLine: 1 } } as GraphNode;
}

function rollupFixture(groups: Record<string, number>) {
  const nodes: GraphNode[] = [];
  const matched: FileMatch[] = [];
  for (const [packageId, count] of Object.entries(groups)) {
    nodes.push(packageNode(packageId));
    for (let index = 1; index <= count; index += 1) {
      const file = `${packageId.slice(2)}/file-${index}.ts`;
      const moduleId = `m:${file}`;
      nodes.push({ ...moduleNode(moduleId, file), parentId: packageId });
      matched.push({ path: file, moduleId, file });
    }
  }
  return { index: indexOf(nodes), matched };
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

describe("rollupSeeds", () => {
  it("passes file module ids through at or below the ten-file threshold", () => {
    const { index, matched } = rollupFixture({ "p:src": 10 });
    const result = rollupSeeds(matched, index);
    expect(result.seeds).toEqual(matched.map((match) => match.moduleId).sort());
    expect(result.rolledUp.size).toBe(0);
  });

  it("rolls groups of three or more into their immediate parent and leaves smaller groups as files", () => {
    const { index, matched } = rollupFixture({ "p:app": 3, "p:docs": 2, "p:lib": 6 });
    const result = rollupSeeds(matched, index);
    expect(result.seeds).toEqual([
      "m:docs/file-1.ts",
      "m:docs/file-2.ts",
      "p:app",
      "p:lib",
    ]);
    expect(Object.fromEntries(result.rolledUp)).toEqual({
      "p:app": ["m:app/file-1.ts", "m:app/file-2.ts", "m:app/file-3.ts"],
      "p:lib": [
        "m:lib/file-1.ts",
        "m:lib/file-2.ts",
        "m:lib/file-3.ts",
        "m:lib/file-4.ts",
        "m:lib/file-5.ts",
        "m:lib/file-6.ts",
      ],
    });
  });

  it("re-evaluates the threshold for an isolated change group's own files", () => {
    const { index, matched } = rollupFixture({ "p:app": 6, "p:lib": 6 });
    expect(rollupSeeds(matched, index).seeds).toEqual(["p:app", "p:lib"]);

    const isolated = matched.filter((match) => match.file.startsWith("app/"));
    const result = rollupSeeds(isolated, index);
    expect(result.seeds).toEqual(isolated.map((match) => match.moduleId).sort());
    expect(result.rolledUp.size).toBe(0);
  });
});
