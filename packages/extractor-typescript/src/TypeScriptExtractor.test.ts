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
const SHOPFRONT_ROOT = join(REPO_ROOT, "examples", "shopfront");
const GALLERY_PREFIX = "ts:src/showcase/executionGraphGallery.ts#ExecutionGraphGallery.";

function galleryId(method: string): string {
  return `${GALLERY_PREFIX}${method}`;
}

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

function hasImportEdge(result: ExtractionResult, source: string, target: string): boolean {
  return result.edges.some(
    (edge: GraphEdge) =>
      edge.kind === "imports" && edge.resolution === "resolved" && edge.source === source && edge.target === target,
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
  it("extracts the focused execution-graph gallery exhibits", async () => {
    const result = await extractFixture({ includeExternal: true });
    const exhibits = [
      "guidedTour",
      "directAwait",
      "launchThenAwait",
      "awaitAllBarrier",
      "awaitAllSettledBarrier",
      "nestedDecisions",
      "loopShapes",
      "tryCatchOnly",
      "tryCatchFinally",
      "callbackHandOffs",
      "externalAndDetached",
    ];

    for (const method of exhibits) {
      expect(result.nodes.find((node) => node.id === galleryId(method))?.qualifiedName).toBe(
        `ExecutionGraphGallery.${method}`,
      );
      expect(result.flows?.[galleryId(method)]).toBeDefined();
    }

    const barriers = [
      ...(result.flows?.[galleryId("awaitAllBarrier")] ?? []),
      ...(result.flows?.[galleryId("awaitAllSettledBarrier")] ?? []),
    ].filter((step) => step.kind === "call" && step.label.startsWith("Promise."));
    expect(barriers.map((step) => step.kind === "call" ? step.label : "")).toEqual([
      "Promise.all",
      "Promise.allSettled",
    ]);
    expect(barriers.every((step) => step.kind === "call" && step.awaited)).toBe(true);

    const decisions = result.flows?.[galleryId("nestedDecisions")] ?? [];
    expect(decisions.filter((step) => step.kind === "branch").length).toBeGreaterThanOrEqual(3);

    const loops = result.flows?.[galleryId("loopShapes")] ?? [];
    expect(loops.filter((step) => step.kind === "loop").map((step) => step.label)).toEqual([
      "for let attempt = 0",
      "for each orderId",
      "while cursor < orderIds.length",
      "while sweep < 2",
    ]);

    const protectedFlow = result.flows?.[galleryId("tryCatchFinally")] ?? [];
    expect(protectedFlow[0]).toMatchObject({ kind: "branch", label: "try/catch" });

    const handOffs = result.flows?.[galleryId("callbackHandOffs")] ?? [];
    expect(handOffs.some((step) => step.kind === "callback")).toBe(true);
    expect(handOffs.some((step) => step.kind === "loop")).toBe(true);

    const boundary = result.flows?.[galleryId("externalAndDetached")] ?? [];
    expect(boundary.some((step) => step.kind === "call" && step.resolution === "external")).toBe(true);
    expect(boundary.filter((step) => step.kind === "call" && step.detached)).toHaveLength(2);
  });

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

  it("attributes type references to their nearest semantic declaration", async () => {
    const result = await extractFixture();

    // Parameter and return annotations belong to the callable whose signature contains them.
    expect(hasEdge(result, "references", "OrderRoutes.constructor", "OrderService")).toBe(true);
    expect(hasEdge(result, "references", "OrderRoutes.handleCreateOrder", "OrderRequest")).toBe(true);
    expect(hasEdge(result, "references", "OrderRoutes.handleCreateOrder", "ApiResponse")).toBe(true);
    expect(hasEdge(result, "references", "validateOrderRequest", "OrderRequest")).toBe(true);

    // An un-emitted property signature belongs to its owning interface, not the file module.
    expect(hasEdge(result, "references", "OrderRequest", "OrderLine")).toBe(true);

    // These used to be coarse module ghosts beside the precise callable/type ghosts above.
    expect(hasEdge(result, "references", "src/api/orderRoutes.ts", "OrderService")).toBe(false);
    expect(hasEdge(result, "references", "src/domain/order.ts", "OrderLine")).toBe(false);
  });

  it("keeps a genuinely top-level type reference on its module", async () => {
    const result = await createTypeScriptExtractor().extract({
      root: SHOPFRONT_ROOT,
      project: join(SHOPFRONT_ROOT, "tsconfig.json"),
    });

    // `export const services: ShopfrontServices = ...` has no emitted declaration node of its own.
    expect(hasEdge(result, "references", "src/app.ts", "ShopfrontServices")).toBe(true);
  });

  it("emits instantiates edges from buildOrdersApp", async () => {
    const result = await extractFixture();
    for (const target of ["PricingService", "OrderRepository", "EmailService", "OrderService", "OrderRoutes"]) {
      expect(hasEdge(result, "instantiates", "buildOrdersApp", target)).toBe(true);
    }
  });

  it("emits module->module imports edges for the entry file's dependencies", async () => {
    const result = await extractFixture();
    // src/index.ts wires the app together; each `import ... from` is one resolved imports edge.
    expect(hasImportEdge(result, "ts:src/index.ts", "ts:src/api/orderRoutes.ts")).toBe(true);
    expect(hasImportEdge(result, "ts:src/index.ts", "ts:src/services/orderService.ts")).toBe(true);
    expect(hasImportEdge(result, "ts:src/index.ts", "ts:src/pricing/pricingService.ts")).toBe(true);
    // Type-only imports count too: orderService.ts imports the Order type from the domain module.
    expect(hasImportEdge(result, "ts:src/services/orderService.ts", "ts:src/domain/order.ts")).toBe(true);
    // Only in-project targets resolve; every imports edge stays resolved (externals are dropped).
    const imports = result.edges.filter((edge) => edge.kind === "imports");
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((edge) => edge.resolution === "resolved")).toBe(true);
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
