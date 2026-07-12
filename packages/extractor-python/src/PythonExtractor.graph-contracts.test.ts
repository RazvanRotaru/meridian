/** Focused graph-policy contracts for the repository-shaped Python extractor. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractOptions, ExtractionResult, GraphEdge } from "@meridian/core";
import { createPythonExtractor } from "./index";

async function withProject<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "meridian-python-contracts-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function extract(root: string, options: Omit<ExtractOptions, "root"> = {}): Promise<ExtractionResult> {
  return createPythonExtractor().extract({ root, ...options });
}

function findEdge(
  result: ExtractionResult,
  kind: GraphEdge["kind"],
  source: string,
  target: string,
): GraphEdge | undefined {
  return result.edges.find(
    (edge) => edge.kind === kind && edge.resolution === "resolved" && edge.source === source && edge.target === target,
  );
}

describe("PythonExtractor graph contracts", () => {
  it("keeps external edges without counting any as dropped when includeExternal is enabled", async () => {
    await withProject(
      {
        "main.py": ["import third_party", "", "def run():", "    return third_party.execute()", ""].join("\n"),
      },
      async (root) => {
        const result = await extract(root, { includeExternal: true });
        const externalEdges = result.edges.filter((edge) => edge.resolution === "external");

        expect(externalEdges).toHaveLength(2);
        expect(externalEdges.map((edge) => edge.kind).sort()).toEqual(["calls", "imports"]);
        expect(result.stats.edgeCountByResolution.external).toBe(2);
        expect(result.stats.externalCallsDropped).toBe(0);
      },
    );
  });

  it("preserves the complete multi-line AST range for a call site", async () => {
    await withProject(
      {
        "calls.py": [
          "def target(value: int) -> int:",
          "    return value",
          "",
          "def caller() -> int:",
          "    return target(",
          "        41,",
          "    )",
          "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);
        const edge = findEdge(result, "calls", "py:calls#caller", "py:calls#target");

        expect(edge?.callSites).toEqual([
          { file: "calls.py", line: 5, col: 12, endLine: 7, endCol: 6 },
        ]);
      },
    );
  });

  it("retains a synthetic project package when a flat project is collapsed to package depth", async () => {
    await withProject(
      {
        "helpers.py": "def helper():\n    return 1\n",
        "app.py": ["from helpers import helper", "", "def start():", "    return helper()", ""].join("\n"),
      },
      async (root) => {
        const result = await extract(root, { depth: "package" });

        expect(result.nodes).toEqual([
          expect.objectContaining({ id: "py:__root__", kind: "package", displayName: "project", parentId: null }),
        ]);
        expect(result.stats.nodeCountByKind.package).toBe(1);
      },
    );
  });

  it("honors lexical shadowing, local imports, and conditional definitions", async () => {
    await withProject(
      {
        "other.py": "def helper():\n    return 2\n",
        "main.py": [
          "def helper():", "    return 1", "",
          "def by_parameter(helper):", "    return helper()", "",
          "def by_assignment():", "    helper = object()", "    return helper()", "",
          "def by_loop(items):", "    for helper in items:", "        helper()", "",
          "def by_unpack(value):", "    (helper,) = (value,)", "    return helper()", "",
          "def by_comprehension(items):", "    return [helper() for helper in items]", "",
          "def by_import():", "    from other import helper", "    return helper()", "",
          "if True:", "    def conditional():", "        return 3", "",
          "def call_conditional():", "    return conditional()", "",
          "class ConditionalMethods:", "    if True:", "        def method(self):", "            return 4",
          "    def caller(self):", "        return self.method()", "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);
        expect(findEdge(result, "calls", "py:main#by_parameter", "py:main#helper")).toBeUndefined();
        expect(findEdge(result, "calls", "py:main#by_assignment", "py:main#helper")).toBeUndefined();
        expect(findEdge(result, "calls", "py:main#by_loop", "py:main#helper")).toBeUndefined();
        expect(findEdge(result, "calls", "py:main#by_unpack", "py:main#helper")).toBeUndefined();
        expect(findEdge(result, "calls", "py:main#by_comprehension", "py:main#helper")).toBeUndefined();
        expect(findEdge(result, "calls", "py:main#by_import", "py:other#helper")).toBeDefined();
        expect(findEdge(result, "calls", "py:main#call_conditional", "py:main#conditional")).toBeDefined();
        expect(findEdge(result, "calls", "py:main#ConditionalMethods.caller", "py:main#ConditionalMethods.method")).toBeDefined();
      },
    );
  });

  it("attributes duplicate-qualname call sites to the matching occurrence", async () => {
    await withProject(
      {
        "properties.py": [
          "def getter_helper():", "    return 1", "", "def setter_helper():", "    return 2", "",
          "class Example:", "    @property", "    def value(self):", "        return getter_helper()", "",
          "    @value.setter", "    def value(self, new_value):", "        setter_helper()", "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);
        expect(findEdge(result, "calls", "py:properties#Example.value", "py:properties#getter_helper")).toBeDefined();
        expect(findEdge(result, "calls", "py:properties#Example.value~1", "py:properties#setter_helper")).toBeDefined();
      },
    );
  });

  it("does not guess a receiver type across ambiguous unions or branches", async () => {
    await withProject(
      {
        "ambiguous.py": [
          "class First:", "    def run(self):", "        return 1", "",
          "class Second:", "    def run(self):", "        return 2", "",
          "def annotated(value: First | Second):", "    return value.run()", "",
          "def branched(flag):", "    value = First() if flag else Second()", "    return value.run()", "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);
        for (const source of ["py:ambiguous#annotated", "py:ambiguous#branched"]) {
          expect(findEdge(result, "calls", source, "py:ambiguous#First.run")).toBeUndefined();
          expect(findEdge(result, "calls", source, "py:ambiguous#Second.run")).toBeUndefined();
        }
      },
    );
  });

  it("uses the final module binding for re-exports and shadows", async () => {
    await withProject(
      {
        "source.py": "def target():\n    return 1\n",
        "barrel.py": [
          "def target():", "    return 0", "", "from source import target", "",
          "def hidden():", "    return 2", "", "hidden = object()", "",
        ].join("\n"),
        "consumer.py": [
          "from barrel import target, hidden", "", "def run():", "    target()", "    hidden()", "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);
        expect(findEdge(result, "calls", "py:consumer#run", "py:source#target")).toBeDefined();
        expect(findEdge(result, "calls", "py:consumer#run", "py:barrel#target")).toBeUndefined();
        expect(findEdge(result, "calls", "py:consumer#run", "py:barrel#hidden")).toBeUndefined();
      },
    );
  });
});
