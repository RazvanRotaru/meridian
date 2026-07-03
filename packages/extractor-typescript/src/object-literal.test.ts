/**
 * Object-literal method support: a const bound to an object literal becomes an "object" container
 * node and its function-valued members become `method` children — so a call inside such a method
 * attributes to the method, not (as it once did) to the enclosing module.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const SOURCE = ["export const svc = { async foo() { bar(); } };", "function bar() {}"].join("\n");

let root: string;
let result: ExtractionResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bp-object-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "svc.ts"), `${SOURCE}\n`);
  const extractor = createTypeScriptExtractor();
  result = await extractor.extract({ root, include: ["src/**/*.ts"] });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function nodeByQualname(qualname: string) {
  return result.nodes.find((node) => node.qualifiedName === qualname);
}

describe("object-literal method support", () => {
  it("emits the object-literal const as an 'object' container node", () => {
    expect(nodeByQualname("svc")?.kind).toBe("object");
  });

  it("emits a `method` child whose qualname is svc.foo, parented to the object", () => {
    const svc = nodeByQualname("svc");
    const foo = nodeByQualname("svc.foo");
    expect(foo?.kind).toBe("method");
    expect(foo?.parentId).toBe(svc?.id);
  });

  it("sources the inner call from svc.foo, not the module", () => {
    const foo = nodeByQualname("svc.foo");
    const bar = nodeByQualname("bar");
    const edge = result.edges.find(
      (candidate) =>
        candidate.kind === "calls" &&
        candidate.resolution === "resolved" &&
        candidate.source === foo?.id &&
        candidate.target === bar?.id,
    );
    expect(edge).toBeDefined();

    // Regression guard: the call must NOT be mis-attributed to the enclosing module.
    const moduleNode = result.nodes.find((node) => node.kind === "module");
    const misattributed = result.edges.some(
      (candidate) => candidate.kind === "calls" && candidate.source === moduleNode?.id && candidate.target === bar?.id,
    );
    expect(misattributed).toBe(false);
  });
});
