/**
 * Regression coverage the orders-service fixture lacks: interface-to-interface `extends`
 * edges, and the reserved `unresolved:` pseudo-lang on unbindable call targets.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const SOURCE = [
  "export interface Animal { name(): string; }",
  "export interface Dog extends Animal { bark(): void; }",
  "export class Base {}",
  "export class Sub extends Base {}",
  "export function topcall(cb: () => void) { cb(); }",
  "export function dyn(o: any) { o.whatever(); }",
].join("\n");

let root: string;
let result: ExtractionResult;
let withUnresolved: ExtractionResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bp-inherit-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "shapes.ts"), `${SOURCE}\n`);
  const extractor = createTypeScriptExtractor();
  result = await extractor.extract({ root, include: ["src/**/*.ts"] });
  withUnresolved = await extractor.extract({ root, include: ["src/**/*.ts"], includeUnresolved: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function hasEdge(extraction: ExtractionResult, kind: string, sourceQn: string, targetQn: string): boolean {
  const qualnameById = new Map(extraction.nodes.map((node) => [node.id, node.qualifiedName]));
  return extraction.edges.some(
    (edge) =>
      edge.kind === kind &&
      edge.resolution === "resolved" &&
      qualnameById.get(edge.source) === sourceQn &&
      qualnameById.get(edge.target) === targetQn,
  );
}

describe("inheritance edges", () => {
  it("emits an extends edge between interfaces", () => {
    expect(hasEdge(result, "extends", "Dog", "Animal")).toBe(true);
  });

  it("still emits an extends edge between classes", () => {
    expect(hasEdge(result, "extends", "Sub", "Base")).toBe(true);
  });
});

describe("unresolved sentinel", () => {
  it("targets the reserved unresolved: pseudo-lang, not a ts: node", () => {
    const unresolved = withUnresolved.edges.filter((edge) => edge.resolution === "unresolved");
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every((edge) => edge.target.startsWith("unresolved:"))).toBe(true);
  });
});
