/** Regressions for Python scopes whose bindings diverge across classes and control flow. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionResult, GraphEdge } from "@meridian/core";
import { createPythonExtractor } from "./index";

async function extractSource(source: string): Promise<ExtractionResult> {
  const root = await mkdtemp(join(tmpdir(), "meridian-python-flow-bindings-"));
  try {
    await writeFile(join(root, "flow.py"), source);
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

describe("PythonExtractor control-flow bindings", () => {
  it("resolves a nested class body through module scope, not its outer class namespace", async () => {
    const result = await extractSource(
      [
        "def make():",
        "    return 'module'",
        "",
        "class Outer:",
        "    def make():",
        "        return 'outer class'",
        "",
        "    class Inner:",
        "        product = make()",
        "",
      ].join("\n"),
    );

    expect(edge(result, "calls", "py:flow#Outer.Inner", "py:flow#make")).toBeDefined();
    expect(edge(result, "calls", "py:flow#Outer.Inner", "py:flow#Outer.make")).toBeUndefined();
  });

  it("does not merge alternative definitions merely because their qualnames match", async () => {
    const result = await extractSource(
      [
        "def choose(flag):",
        "    if flag:",
        "        def target():",
        "            return 'left'",
        "    else:",
        "        def target():",
        "            return 'right'",
        "    return target()",
        "",
      ].join("\n"),
    );
    const alternatives = result.nodes.filter((node) => node.qualifiedName === "choose.target");
    const alternativeIds = new Set(alternatives.map((node) => node.id));
    const resolvedCalls = result.edges.filter(
      (candidate) =>
        candidate.kind === "calls" &&
        candidate.source === "py:flow#choose" &&
        alternativeIds.has(candidate.target),
    );

    expect(alternatives).toHaveLength(2);
    expect(resolvedCalls).toEqual([]);
    expect(result.stats.unresolvedCalls).toBe(1);
  });

  it("joins pre-try and try-body receivers before analyzing an exception handler", async () => {
    const result = await extractSource(
      [
        "class A:",
        "    def run(self):",
        "        return 'a'",
        "",
        "class B:",
        "    def run(self):",
        "        return 'b'",
        "",
        "def might_fail():",
        "    return None",
        "",
        "def handle():",
        "    worker = A()",
        "    try:",
        "        worker = B()",
        "        might_fail()",
        "    except Exception:",
        "        worker.run()",
        "",
      ].join("\n"),
    );

    expect(edge(result, "instantiates", "py:flow#handle", "py:flow#A")).toBeDefined();
    expect(edge(result, "instantiates", "py:flow#handle", "py:flow#B")).toBeDefined();
    expect(edge(result, "calls", "py:flow#handle", "py:flow#might_fail")).toBeDefined();
    expect(edge(result, "calls", "py:flow#handle", "py:flow#A.run")).toBeUndefined();
    expect(edge(result, "calls", "py:flow#handle", "py:flow#B.run")).toBeUndefined();
    expect(result.stats.unresolvedCalls).toBe(1);
  });

  it("shadows homonymous callables with Match captures before guards and case bodies", async () => {
    const result = await extractSource(
      [
        "def helper():",
        "    return True",
        "",
        "class Example:",
        "    def helper():",
        "        return True",
        "",
        "    match {'value': 1}:",
        "        case {'value': helper} if helper():",
        "            result = helper()",
        "",
        "match {'value': 1}:",
        "    case {'value': helper} if helper():",
        "        result = helper()",
        "",
      ].join("\n"),
    );

    expect(edge(result, "calls", "py:flow#Example", "py:flow#Example.helper")).toBeUndefined();
    expect(edge(result, "calls", "py:flow#Example", "py:flow#helper")).toBeUndefined();
    expect(edge(result, "calls", "py:flow", "py:flow#helper")).toBeUndefined();
    expect(result.stats.unresolvedCalls).toBe(4);
  });

  it("uses module scope for global but the enclosing function binding for nonlocal", async () => {
    const result = await extractSource(
      [
        "def helper():",
        "    return 'module'",
        "",
        "def outer():",
        "    def helper():",
        "        return 'outer'",
        "",
        "    def via_global():",
        "        global helper",
        "        return helper()",
        "",
        "    def via_nonlocal():",
        "        nonlocal helper",
        "        return helper()",
        "",
        "    return via_global(), via_nonlocal()",
        "",
      ].join("\n"),
    );

    expect(edge(result, "calls", "py:flow#outer.via_global", "py:flow#helper")).toBeDefined();
    expect(edge(result, "calls", "py:flow#outer.via_global", "py:flow#outer.helper")).toBeUndefined();
    expect(edge(result, "calls", "py:flow#outer.via_nonlocal", "py:flow#outer.helper")).toBeDefined();
    expect(edge(result, "calls", "py:flow#outer.via_nonlocal", "py:flow#helper")).toBeUndefined();
  });
});
