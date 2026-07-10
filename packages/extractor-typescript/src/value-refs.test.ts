/**
 * The opt-in value-reference pass (`valueRefs`). It surfaces imported symbols used as plain VALUES
 * — a callback, a const read, an `instanceof` — which the call/new/type/JSX passes don't model,
 * turning featureless `imports` wires into traceable `references` edges. These golden tests pin:
 *   - it adds real value references (orders-service's `toErrorResponse` reads `ValidationError`),
 *   - every added edge is a concrete cross-module `references` (never intra-file / external noise),
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

describe("value-refs module fallback (unemitted symbols)", () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "value-refs");
  let off: ExtractionResult;
  let on: ExtractionResult;
  beforeAll(async () => {
    const extract = (valueRefs: boolean) =>
      createTypeScriptExtractor().extract({ root: FIXTURE, project: join(FIXTURE, "tsconfig.json"), valueRefs });
    off = await extract(false);
    on = await extract(true);
  });

  it("without the flag the pair stays a bare import (the bug being fixed)", () => {
    const pair = off.edges.filter((edge) => moduleOf(edge.source).includes("feature") && moduleOf(edge.target).includes("wire"));
    expect(pair.map((edge) => edge.kind)).toEqual(["imports"]);
  });

  it("a type alias used only inside a `declare module` augmentation resolves to the declaring module", () => {
    // VoidRequest has no emitted node; its two augmentation uses must land on wire.ts's MODULE node.
    const refs = references(on).filter((edge) => edge.target === moduleIdOf(on, "wire"));
    expect(refs.length).toBeGreaterThan(0);
    const augmentation = refs.find((edge) => edge.source === moduleIdOf(on, "feature"));
    expect(augmentation?.weight).toBe(2); // ping + pong requests
  });

  it("a plain-const read resolves to the declaring module, sourced from the enclosing callable", () => {
    const nameById = new Map(on.nodes.map((node) => [node.id, node.displayName]));
    const constRead = references(on).find(
      (edge) => nameById.get(edge.source) === "retriesLeft" && edge.target === moduleIdOf(on, "wire"),
    );
    expect(constRead).toBeDefined();
    expect(constRead?.resolution).toBe("resolved");
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
