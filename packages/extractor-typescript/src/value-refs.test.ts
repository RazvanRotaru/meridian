/**
 * The opt-in value-reference pass (`valueRefs`). It surfaces symbols used as plain VALUES — an
 * imported const, an `instanceof`, or a same-file callback handoff — which the call/new/type/JSX
 * passes don't model, turning otherwise hidden usage into traceable `references` edges. These tests pin:
 *   - it adds real value references (orders-service's `toErrorResponse` reads `ValidationError`),
 *   - imported-value edges stay concrete and cross-module; local edges are callable handoffs only,
 *   - it NEVER double-counts what another pass owns — JSX composition stays `renders` only,
 *   - it is strictly opt-in (off by default), and the artifact still validates with zero warnings.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { validateArtifact, type ExtractionResult, type GraphArtifact } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function extractFixture(name: string, valueRefs: boolean): Promise<ExtractionResult> {
  const root = join(REPO_ROOT, "examples", name);
  return createTypeScriptExtractor().extract({ root, project: join(root, "tsconfig.json"), valueRefs });
}

const moduleOf = (id: string): string => (id.includes("#") ? id.slice(0, id.indexOf("#")) : id);
const refKey = (edge: { source: string; target: string }): string => `${edge.source}|${edge.target}`;
const references = (extraction: ExtractionResult) => extraction.edges.filter((edge) => edge.kind === "references");

function artifactFrom(extraction: ExtractionResult, name: string): GraphArtifact {
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    generator: { name: "test", version: "0.0.0" },
    target: { name, root: `examples/${name}`, language: "typescript" },
    telemetry: { joinKey: "node.id", requiredRuntimeAttributes: ["service.name"], serviceDefaulting: "forbidden" },
    nodes: extraction.nodes,
    edges: extraction.edges,
  };
}

describe("value-refs over orders-service", () => {
  let off: ExtractionResult;
  let on: ExtractionResult;
  beforeAll(async () => {
    off = await extractFixture("orders-service", false);
    on = await extractFixture("orders-service", true);
  });

  it("is off by default — no value references appear without the flag", () => {
    const nameById = new Map(off.nodes.map((node) => [node.id, node.displayName]));
    const offPairs = new Set(references(off).map((edge) => `${nameById.get(edge.source)}->${nameById.get(edge.target)}`));
    // `toErrorResponse` does `err instanceof ValidationError` — a value use, not a call/new/type.
    expect(offPairs.has("toErrorResponse->ValidationError")).toBe(false);
  });

  it("surfaces the imported value used only via instanceof", () => {
    const nameById = new Map(on.nodes.map((node) => [node.id, node.displayName]));
    const onPairs = new Set(references(on).map((edge) => `${nameById.get(edge.source)}->${nameById.get(edge.target)}`));
    expect(onPairs.has("toErrorResponse->ValidationError")).toBe(true);
    expect(references(on).length).toBeGreaterThan(references(off).length);
  });

  it("every added edge is a concrete cross-module `references` (no intra-file / external noise)", () => {
    const offKeys = new Set(references(off).map(refKey));
    const added = references(on).filter((edge) => !offKeys.has(refKey(edge)));
    expect(added.length).toBeGreaterThan(0);
    for (const edge of added) {
      expect(edge.resolution).toBe("resolved");
      expect(moduleOf(edge.source)).not.toBe(moduleOf(edge.target));
    }
  });
});

describe("value-refs module fallback", () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "value-refs");
  let off: ExtractionResult;
  let on: ExtractionResult;
  beforeAll(async () => {
    const extract = (valueRefs: boolean) =>
      createTypeScriptExtractor().extract({ root: FIXTURE, project: join(FIXTURE, "tsconfig.json"), valueRefs });
    off = await extract(false);
    on = await extract(true);
  });

  it("an imported type alias resolves precisely without the value-reference fallback", () => {
    const alias = off.nodes.find((node) => node.qualifiedName === "VoidRequest");
    expect(alias).toMatchObject({ kind: "typeAlias", parentId: moduleIdOf(off, "wire") });
    const ref = references(off).find((edge) => edge.target === alias?.id);
    expect(ref).toMatchObject({
      resolution: "resolved",
      weight: 2,
      callSites: [
        expect.objectContaining({ file: "src/feature.ts", line: 11 }),
        expect.objectContaining({ file: "src/feature.ts", line: 12 }),
      ],
    });
    // Enabling value refs must not re-emit the ordinary type-pass edge through a module fallback.
    expect(references(on).filter((edge) => edge.target === alias?.id)).toEqual([ref]);
  });

  it("a plain-const read resolves to the declaring module, sourced from the enclosing callable", () => {
    const nameById = new Map(on.nodes.map((node) => [node.id, node.displayName]));
    const constRead = references(on).find(
      (edge) => nameById.get(edge.source) === "retriesLeft" && edge.target === moduleIdOf(on, "wire"),
    );
    expect(constRead).toBeDefined();
    expect(constRead?.resolution).toBe("resolved");
  });

  it("surfaces generic plain-value uses of a same-file callable", () => {
    const constructorSource = on.nodes.find((node) => node.qualifiedName === "createConsumer");
    const returnSource = on.nodes.find((node) => node.qualifiedName === "exposeCallback");
    const invocationSource = on.nodes.find((node) => node.qualifiedName === "invokeCallback");
    const target = on.nodes.find((node) => node.qualifiedName === "localCallback");
    expect(constructorSource).toBeDefined();
    expect(returnSource).toBeDefined();
    expect(invocationSource).toBeDefined();
    expect(target).toBeDefined();

    expect(references(on)).toContainEqual(expect.objectContaining({
      source: constructorSource!.id,
      target: target!.id,
      resolution: "resolved",
      callSites: [expect.objectContaining({ file: "src/feature.ts", line: 33 })],
    }));
    expect(references(on)).toContainEqual(expect.objectContaining({
      source: returnSource!.id,
      target: target!.id,
      resolution: "resolved",
      callSites: [expect.objectContaining({ file: "src/feature.ts", line: 37 })],
    }));
    expect(references(off).some((edge) => edge.target === target!.id)).toBe(false);
    expect(references(on).some((edge) => (
      edge.source === invocationSource!.id && edge.target === target!.id
    ))).toBe(false);
    expect(on.edges.some((edge) => (
      edge.kind === "calls"
      && (edge.source === constructorSource!.id || edge.source === returnSource!.id)
      && edge.target === target!.id
    ))).toBe(false);
    expect(on.edges).toContainEqual(expect.objectContaining({
      source: invocationSource!.id,
      target: target!.id,
      kind: "calls",
    }));
    expect(references(on).some((edge) => edge.source === target!.id && edge.target === target!.id)).toBe(false);
  });
});

/** The module node id whose file basename contains `stem`. */
function moduleIdOf(extraction: ExtractionResult, stem: string): string {
  const module = extraction.nodes.find((node) => node.kind === "module" && node.id.includes(stem));
  if (!module) throw new Error(`no module node matching '${stem}'`);
  return module.id;
}

describe("value-refs never double-count another pass (shopfront JSX)", () => {
  it("adds no `references` that duplicates a JSX `renders` edge, and still validates cleanly", async () => {
    const off = await extractFixture("shopfront", false);
    const on = await extractFixture("shopfront", true);
    const rendersPairs = new Set(on.edges.filter((edge) => edge.kind === "renders").map(refKey));
    const offKeys = new Set(references(off).map(refKey));
    const added = references(on).filter((edge) => !offKeys.has(refKey(edge)));
    // A component composition is a `renders` edge; value-refs must never re-emit it as `references`.
    for (const edge of added) {
      expect(rendersPairs.has(refKey(edge))).toBe(false);
    }
    const validation = validateArtifact(artifactFrom(on, "shopfront"));
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
  });
});
