/**
 * Golden test: extract the orders-service fixture and assert the exact resolved call/new
 * graph, the node-id grammar, the telemetry contract on callables, and that the whole thing
 * round-trips through core's Tier-1 + Tier-2 validation.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateArtifact, type ExtractionResult, type GraphArtifact, type GraphEdge } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_ROOT = join(REPO_ROOT, "examples", "orders-service");
const FIXTURE_PROJECT = join(FIXTURE_ROOT, "tsconfig.json");

async function extractFixture(overrides = {}): Promise<ExtractionResult> {
  const extractor = createTypeScriptExtractor();
  return extractor.extract({ root: FIXTURE_ROOT, project: FIXTURE_PROJECT, ...overrides });
}

function qualnameById(result: ExtractionResult): Map<string, string> {
  return new Map(result.nodes.map((node) => [node.id, node.qualifiedName]));
}

function hasEdge(result: ExtractionResult, kind: string, sourceQn: string, targetQn: string): boolean {
  const names = qualnameById(result);
  return result.edges.some(
    (edge: GraphEdge) =>
      edge.kind === kind &&
      edge.resolution === "resolved" &&
      names.get(edge.source) === sourceQn &&
      names.get(edge.target) === targetQn,
  );
}

function artifactFrom(result: ExtractionResult): GraphArtifact {
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    generator: { name: "test", version: "0.0.0" },
    target: { name: "orders-service", root: "examples/orders-service", language: "typescript" },
    telemetry: { joinKey: "node.id", requiredRuntimeAttributes: ["service.name"], serviceDefaulting: "forbidden" },
    nodes: result.nodes,
    edges: result.edges,
  };
}

describe("TypeScriptExtractor over orders-service", () => {
  it("resolves the OrderRoutes call edges", async () => {
    const result = await extractFixture();
    expect(hasEdge(result, "calls", "OrderRoutes.handleCreateOrder", "OrderService.placeOrder")).toBe(true);
    expect(hasEdge(result, "calls", "OrderRoutes.handleCreateOrder", "OrderRoutes.created")).toBe(true);
    expect(hasEdge(result, "calls", "OrderRoutes.handleCreateOrder", "OrderRoutes.toErrorResponse")).toBe(true);
  });

  it("resolves the OrderService.placeOrder fan-out", async () => {
    const result = await extractFixture();
    for (const target of [
      "validateOrderRequest",
      "PricingService.price",
      "OrderService.assemble",
      "OrderRepository.save",
      "EmailService.sendOrderConfirmation",
    ]) {
      expect(hasEdge(result, "calls", "OrderService.placeOrder", target)).toBe(true);
    }
  });

  it("resolves the remaining internal calls", async () => {
    const result = await extractFixture();
    expect(hasEdge(result, "calls", "OrderService.getOrder", "OrderRepository.findById")).toBe(true);
    expect(hasEdge(result, "calls", "validateOrderRequest", "assertLineIsSane")).toBe(true);
  });

  it("emits instantiates edges from buildOrdersApp", async () => {
    const result = await extractFixture();
    for (const target of ["PricingService", "OrderRepository", "EmailService", "OrderService", "OrderRoutes"]) {
      expect(hasEdge(result, "instantiates", "buildOrdersApp", target)).toBe(true);
    }
  });

  it("drops ValidationError extends Error (external) by default, materializes it on demand", async () => {
    const byDefault = await extractFixture();
    expect(byDefault.edges.some((edge) => edge.kind === "extends")).toBe(false);
    expect(byDefault.stats.externalCallsDropped).toBeGreaterThan(0);

    const withExternal = await extractFixture({ includeExternal: true });
    const names = qualnameById(withExternal);
    const extendsEdge = withExternal.edges.find(
      (edge) => edge.kind === "extends" && names.get(edge.source) === "ValidationError",
    );
    expect(extendsEdge?.resolution).toBe("external");
  });

  it("ids follow the <lang>:<modulePath>#<qualname> grammar", async () => {
    const result = await extractFixture();
    const placeOrder = result.nodes.find((node) => node.qualifiedName === "OrderService.placeOrder");
    expect(placeOrder?.id).toBe("ts:src/services/orderService.ts#OrderService.placeOrder");
    const servicePackage = result.nodes.find((node) => node.kind === "package" && node.qualifiedName === "src/services");
    expect(servicePackage?.id).toBe("ts:src/services");
  });

  it("stamps telemetry on every callable and never leaks a service/environment field", async () => {
    const result = await extractFixture();
    const callables = result.nodes.filter((node) => node.kind === "function" || node.kind === "method");
    expect(callables.length).toBeGreaterThan(0);
    for (const node of callables) {
      expect(node.telemetry?.codeFunction).toBeTruthy();
      expect(node.telemetry?.spanNameHints.length ?? 0).toBeGreaterThanOrEqual(1);
    }
    const forbidden = ["service", "serviceName", "environment", "deployment", "env"];
    for (const node of result.nodes) {
      expect(forbidden.some((key) => key in node)).toBe(false);
    }
  });

  it("produces an artifact that passes Tier-1 + Tier-2 validation", async () => {
    const result = await extractFixture();
    const validation = validateArtifact(artifactFrom(result));
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});
