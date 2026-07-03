/**
 * Golden test for React composition edges: extract the shopfront fixture and assert the exact
 * `renders` drill-down (App -> StoreLayout -> ... -> leaf buttons), that host elements (div/
 * button/ul) never become edge targets, and that the assembled artifact still passes core's
 * two-tier validation with `renders` a registered edge kind (zero warnings).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { validateArtifact, type ExtractionResult, type GraphArtifact } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_ROOT = join(REPO_ROOT, "examples", "shopfront");
const FIXTURE_PROJECT = join(FIXTURE_ROOT, "tsconfig.json");

let result: ExtractionResult;

beforeAll(async () => {
  const extractor = createTypeScriptExtractor();
  result = await extractor.extract({ root: FIXTURE_ROOT, project: FIXTURE_PROJECT });
});

/** Renders edges keyed by the human names of both endpoints, for readable assertions. */
function rendersByName(extraction: ExtractionResult): Set<string> {
  const nameById = new Map(extraction.nodes.map((node) => [node.id, node.displayName]));
  const pairs = new Set<string>();
  for (const edge of extraction.edges) {
    if (edge.kind === "renders" && edge.resolution === "resolved") {
      pairs.add(`${nameById.get(edge.source)}->${nameById.get(edge.target)}`);
    }
  }
  return pairs;
}

function artifactFrom(extraction: ExtractionResult): GraphArtifact {
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    generator: { name: "test", version: "0.0.0" },
    target: { name: "shopfront", root: "examples/shopfront", language: "typescript" },
    telemetry: { joinKey: "node.id", requiredRuntimeAttributes: ["service.name"], serviceDefaulting: "forbidden" },
    nodes: extraction.nodes,
    edges: extraction.edges,
  };
}

const EXPECTED_COMPOSITION: Array<[string, string[]]> = [
  ["App", ["StoreLayout"]],
  ["StoreLayout", ["NavBar", "CatalogPage", "CartPanel", "Footer"]],
  ["NavBar", ["Logo", "SearchBox", "CartButton"]],
  ["CatalogPage", ["CategoryFilter", "ProductGrid"]],
  ["ProductGrid", ["ProductCard"]],
  ["ProductCard", ["PriceTag", "AddToCartButton"]],
  ["CartPanel", ["CartLine", "CheckoutBar"]],
  ["CheckoutBar", ["CheckoutButton"]],
];

describe("renders edges over shopfront", () => {
  it("emits the full component composition tree", () => {
    const pairs = rendersByName(result);
    for (const [source, targets] of EXPECTED_COMPOSITION) {
      for (const target of targets) {
        expect(pairs.has(`${source}->${target}`)).toBe(true);
      }
    }
  });

  it("never targets a host element (div/button/ul)", () => {
    const nameById = new Map(result.nodes.map((node) => [node.id, node.displayName]));
    const hosts = new Set(["div", "button", "ul", "nav", "section", "main", "span", "aside"]);
    const rendersToHost = result.edges.some(
      (edge) => edge.kind === "renders" && hosts.has(nameById.get(edge.target) ?? ""),
    );
    expect(rendersToHost).toBe(false);
  });

  it("aggregates weight to the render-site count and folds by (source,target)", () => {
    const nameById = new Map(result.nodes.map((node) => [node.id, node.displayName]));
    const rendersEdges = result.edges.filter((edge) => edge.kind === "renders");
    // Every renders edge is a single dedup'd relationship whose weight equals its call sites.
    for (const edge of rendersEdges) {
      expect(edge.weight).toBe(edge.callSites?.length);
    }
    // The map-produced <ProductCard/> resolves to ProductGrid, not the anonymous .map arrow.
    const productGridChildren = rendersEdges.filter((edge) => nameById.get(edge.source) === "ProductGrid");
    expect(productGridChildren.map((edge) => nameById.get(edge.target))).toContain("ProductCard");
  });

  it("assembles an artifact that validates with renders registered (zero warnings)", () => {
    const validation = validateArtifact(artifactFrom(result));
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});
