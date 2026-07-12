/** Regressions for definition-time symbol context, target occurrences, and Python MRO. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionResult, GraphEdge } from "@meridian/core";
import { createPythonExtractor } from "./index";

async function extractFiles(files: Record<string, string>): Promise<ExtractionResult> {
  const root = await mkdtemp(join(tmpdir(), "meridian-python-context-"));
  try {
    for (const [file, source] of Object.entries(files)) await writeFile(join(root, file), source);
    return await createPythonExtractor().extract({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function edge(
  result: ExtractionResult,
  kind: GraphEdge["kind"],
  source: string,
  target: string,
): GraphEdge | undefined {
  return result.edges.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.resolution === "resolved" &&
      candidate.source === source &&
      candidate.target === target,
  );
}

describe("PythonExtractor source contexts", () => {
  it("keeps base and field aliases from their class-definition context after late rebinds", async () => {
    const dependencyModule = (label: string) =>
      [
        "class Base:",
        "    def foo(self):",
        `        return '${label} base'`,
        "",
        "class Dep:",
        "    def foo(self):",
        `        return '${label} dep'`,
        "",
      ].join("\n");
    const result = await extractFiles({
      "a.py": dependencyModule("a"),
      "b.py": dependencyModule("b"),
      "consumer.py": [
        "from a import Base as Parent",
        "from a import Dep as Dependency",
        "",
        "class Child(Parent):",
        "    dependency: Dependency",
        "",
        "    def invoke(self):",
        "        return self.foo(), self.dependency.foo()",
        "",
        "from b import Base as Parent",
        "from b import Dep as Dependency",
        "",
      ].join("\n"),
    });

    expect(edge(result, "extends", "py:consumer#Child", "py:a#Base")).toBeDefined();
    expect(edge(result, "calls", "py:consumer#Child.invoke", "py:a#Base.foo")).toBeDefined();
    expect(edge(result, "calls", "py:consumer#Child.invoke", "py:a#Dep.foo")).toBeDefined();
    expect(edge(result, "extends", "py:consumer#Child", "py:b#Base")).toBeUndefined();
    expect(edge(result, "calls", "py:consumer#Child.invoke", "py:b#Base.foo")).toBeUndefined();
    expect(edge(result, "calls", "py:consumer#Child.invoke", "py:b#Dep.foo")).toBeUndefined();
  });

  it("leaves self.pick unresolved when dynamic branches define distinct method occurrences", async () => {
    const result = await extractFiles({
      "methods.py": [
        "class Chooser:",
        "    if FLAG:",
        "        def pick(self):",
        "            return 'left'",
        "    else:",
        "        def pick(self):",
        "            return 'right'",
        "",
        "    def choose(self):",
        "        return self.pick()",
        "",
      ].join("\n"),
    });
    const alternatives = result.nodes.filter((node) => node.qualifiedName === "Chooser.pick");
    const targets = new Set(alternatives.map((node) => node.id));

    expect(alternatives).toHaveLength(2);
    expect(result.edges.some((candidate) => candidate.source === "py:methods#Chooser.choose" && targets.has(candidate.target))).toBe(false);
    expect(result.stats.unresolvedCalls).toBe(1);
  });

  it("uses C3 order for D(B, C), selecting C.foo before A.foo", async () => {
    const result = await extractFiles({
      "mro.py": [
        "class A:",
        "    def foo(self):",
        "        return 'a'",
        "",
        "class B(A):",
        "    pass",
        "",
        "class C(A):",
        "    def foo(self):",
        "        return 'c'",
        "",
        "class D(B, C):",
        "    def invoke(self):",
        "        return self.foo()",
        "",
      ].join("\n"),
    });

    expect(edge(result, "calls", "py:mro#D.invoke", "py:mro#C.foo")).toBeDefined();
    expect(edge(result, "calls", "py:mro#D.invoke", "py:mro#A.foo")).toBeUndefined();
  });

  it("uses the target occurrence line to select the final duplicate definition", async () => {
    const result = await extractFiles({
      "duplicate.py": [
        "def target():",
        "    return 'first'",
        "",
        "def target():",
        "    return 'final'",
        "",
        "def invoke():",
        "    return target()",
        "",
      ].join("\n"),
    });

    expect(edge(result, "calls", "py:duplicate#invoke", "py:duplicate#target~1")).toBeDefined();
    expect(edge(result, "calls", "py:duplicate#invoke", "py:duplicate#target")).toBeUndefined();
  });
});
