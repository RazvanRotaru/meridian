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
  "export interface Worker { run(): string; }",
  "export interface ManagedWorker extends Worker { stop(): void; }",
  "export class WorkerImpl implements ManagedWorker { run(): string { return 'ok'; } stop(): void {} }",
  "export interface PersistedWorker { persist(value: string): string; }",
  "export class WorkerBase { persist(value: string): string { return value; } }",
  "export class InheritedWorker extends WorkerBase implements PersistedWorker {}",
  "export interface Formatter { format(value: string): string; }",
  "export class FormatterImpl implements Formatter {",
  "  static format(value: string): string { return value; }",
  "  format(value: string): string;",
  "  format(value: string): string { return value; }",
  "}",
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

  it("emits method-level implementedBy edges from interface contracts to concrete methods", () => {
    expect(hasEdge(result, "implements", "WorkerImpl", "ManagedWorker")).toBe(true);
    expect(hasEdge(result, "implementedBy", "ManagedWorker.stop", "WorkerImpl.stop")).toBe(true);
    // A class implementing a derived interface also fulfills methods inherited from its base.
    expect(hasEdge(result, "implementedBy", "Worker.run", "WorkerImpl.run")).toBe(true);
  });

  it("resolves an implementation inherited from a superclass", () => {
    expect(hasEdge(result, "implementedBy", "PersistedWorker.persist", "WorkerBase.persist")).toBe(true);
  });

  it("targets exactly the compatible instance body, not static lookalikes or overload signatures", () => {
    const formatter = result.nodes.find((node) => node.qualifiedName === "Formatter");
    const contract = result.nodes.find(
      (node) => node.parentId === formatter?.id && node.displayName === "format",
    );
    const implementationEdges = result.edges.filter(
      (edge) => edge.kind === "implementedBy" && edge.source === contract?.id,
    );
    expect(implementationEdges).toHaveLength(1);
    const target = result.nodes.find((node) => node.id === implementationEdges[0]?.target);
    expect(target?.parentId).toBe(result.nodes.find((node) => node.qualifiedName === "FormatterImpl")?.id);
    expect(target?.tags ?? []).not.toContain("static");
    expect(target?.location.startLine).toBe(
      SOURCE.split("\n").findIndex((line) => line === "  format(value: string): string { return value; }") + 1,
    );
  });
});

describe("unresolved sentinel", () => {
  it("targets the reserved unresolved: pseudo-lang, not a ts: node", () => {
    const unresolved = withUnresolved.edges.filter((edge) => edge.resolution === "unresolved");
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every((edge) => edge.target.startsWith("unresolved:"))).toBe(true);
  });
});
