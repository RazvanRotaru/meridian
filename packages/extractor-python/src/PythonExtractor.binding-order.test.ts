/** Regression coverage for source-ordered bindings and Python's class/function scopes. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionResult, GraphEdge } from "@meridian/core";
import { createPythonExtractor } from "./index";

async function extractSource(source: string): Promise<ExtractionResult> {
  return extractFiles({ "bindings.py": source });
}

async function extractFiles(files: Record<string, string>): Promise<ExtractionResult> {
  const root = await mkdtemp(join(tmpdir(), "meridian-python-bindings-"));
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

describe("PythonExtractor source-ordered bindings", () => {
  it("attributes calls on a rebound local to the constructor in force at each call site", async () => {
    const result = await extractSource(
      [
        "class A:",
        "    def ping(self):",
        "        return 'a'",
        "",
        "class B:",
        "    def ping(self):",
        "        return 'b'",
        "",
        "def run():",
        "    x = A()",
        "    x.ping()",
        "    x = B()",
        "    x.ping()",
        "",
      ].join("\n"),
    );

    expect(edge(result, "instantiates", "py:bindings#run", "py:bindings#A")).toBeDefined();
    expect(edge(result, "instantiates", "py:bindings#run", "py:bindings#B")).toBeDefined();
    expect(edge(result, "calls", "py:bindings#run", "py:bindings#A.ping")?.callSites?.map((site) => site.line)).toEqual([11]);
    expect(edge(result, "calls", "py:bindings#run", "py:bindings#B.ping")?.callSites?.map((site) => site.line)).toEqual([13]);
  });

  it("does not treat every name spelled self as the containing-class receiver", async () => {
    const result = await extractSource(
      [
        "class Other:",
        "    def target(self):",
        "        return 'other'",
        "",
        "class Container:",
        "    def target(self):",
        "        return 'container'",
        "",
        "    @staticmethod",
        "    def static(self):",
        "        return self.target()",
        "",
        "    def outer(self):",
        "        def inner(self):",
        "            return self.target()",
        "",
        "        return inner(Other())",
        "",
        "    def rebound(self):",
        "        self = Other()",
        "        return self.target()",
        "",
      ].join("\n"),
    );
    const containerTarget = "py:bindings#Container.target";

    for (const source of ["Container.static", "Container.outer.inner", "Container.rebound"]) {
      expect(edge(result, "calls", `py:bindings#${source}`, containerTarget)).toBeUndefined();
    }
    expect(edge(result, "calls", "py:bindings#Container.rebound", "py:bindings#Other.target")).toBeDefined();
    expect(edge(result, "instantiates", "py:bindings#Container.rebound", "py:bindings#Other")).toBeDefined();
    expect(edge(result, "calls", "py:bindings#Container.outer", "py:bindings#Container.outer.inner")).toBeDefined();
    expect(edge(result, "instantiates", "py:bindings#Container.outer", "py:bindings#Other")).toBeDefined();
  });

  it("resolves a class-body call to an earlier class-local definition before a module homonym", async () => {
    const result = await extractSource(
      [
        "def make():",
        "    return 'module'",
        "",
        "class Factory:",
        "    def make():",
        "        return 'class'",
        "",
        "    product = make()",
        "",
      ].join("\n"),
    );

    expect(edge(result, "calls", "py:bindings#Factory", "py:bindings#Factory.make")?.callSites?.map((site) => site.line)).toEqual([8]);
    expect(edge(result, "calls", "py:bindings#Factory", "py:bindings#make")).toBeUndefined();
  });

  it("joins mutually exclusive module exports instead of trusting the last visited branch", async () => {
    const result = await extractFiles({
      "b.py": ["def imported():", "    return 'imported'", "", "def shared():", "    return 'shared'", ""].join("\n"),
      "conditional.py": [
        "if FLAG:",
        "    def target():",
        "        return 'local'",
        "else:",
        "    from b import imported as target",
        "",
      ].join("\n"),
      "try_exports.py": [
        "try:",
        "    from b import imported as chosen",
        "except ImportError:",
        "    def chosen():",
        "        return 'fallback'",
        "",
      ].join("\n"),
      "same_exports.py": [
        "if FLAG:",
        "    from b import shared",
        "else:",
        "    from b import shared",
        "",
      ].join("\n"),
      "consumer.py": [
        "from conditional import target",
        "from try_exports import chosen",
        "from same_exports import shared",
        "",
        "def use_if():",
        "    return target()",
        "",
        "def use_try():",
        "    return chosen()",
        "",
        "def use_same():",
        "    return shared()",
        "",
      ].join("\n"),
    });

    for (const target of ["py:conditional#target", "py:b#imported"]) {
      expect.soft(edge(result, "calls", "py:consumer#use_if", target)).toBeUndefined();
    }
    for (const target of ["py:try_exports#chosen", "py:b#imported"]) {
      expect.soft(edge(result, "calls", "py:consumer#use_try", target)).toBeUndefined();
    }
    expect(edge(result, "calls", "py:consumer#use_same", "py:b#shared")).toBeDefined();
  });
});
