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
  it("extracts every focused execution-graph gallery exhibit", async () => {
    const result = await extractFixture({ includeExternal: true });
    const exhibitNames = [
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

    for (const method of exhibitNames) {
      expect(result.nodes.find((node) => node.id === galleryId(method))?.qualifiedName).toBe(
        `ExecutionGraphGallery.${method}`,
      );
      expect(result.flows?.[galleryId(method)]).toBeDefined();
    }

    const direct = result.flows?.[galleryId("directAwait")] ?? [];
    expect(direct[0]).toMatchObject({
      kind: "call",
      label: "this.fetchOrder",
      awaited: true,
      async: { kind: "direct-await" },
    });

    const launchThenAwait = result.flows?.[galleryId("launchThenAwait")] ?? [];
    const inventoryLaunch = launchThenAwait[0];
    expect(inventoryLaunch).toMatchObject({
      kind: "call",
      label: "this.fetchInventory",
      async: { kind: "launch", binding: "inventoryTask" },
    });
    if (inventoryLaunch?.kind === "call" && inventoryLaunch.async?.kind === "launch") {
      expect(launchThenAwait[3]).toEqual({
        kind: "await",
        label: "await inventoryTask",
        mode: "single",
        inputs: [{ label: "inventoryTask", taskId: inventoryLaunch.async.taskId }],
      });
    }

    const all = result.flows?.[galleryId("awaitAllBarrier")] ?? [];
    expect(all.slice(0, 3)).toEqual([
      expect.objectContaining({ kind: "call", async: expect.objectContaining({ kind: "launch", binding: "reserveTask" }) }),
      expect.objectContaining({ kind: "call", async: expect.objectContaining({ kind: "launch", binding: "paymentTask" }) }),
      expect.objectContaining({
        kind: "call",
        async: expect.objectContaining({ kind: "launch", binding: "notificationTask" }),
      }),
    ]);
    expect(all[3]).toMatchObject({
      kind: "call",
      label: "Promise.all",
      awaited: true,
      async: { kind: "barrier", mode: "all", inputs: expect.arrayContaining([expect.objectContaining({ taskId: expect.any(String) })]) },
    });

    const allSettled = result.flows?.[galleryId("awaitAllSettledBarrier")] ?? [];
    expect(allSettled.slice(0, 3).every((step) => step.kind === "call" && step.async?.kind === "launch")).toBe(true);
    expect(allSettled[3]).toMatchObject({
      kind: "call",
      label: "Promise.allSettled",
      awaited: true,
      async: { kind: "barrier", mode: "allSettled" },
    });

    const decisions = result.flows?.[galleryId("nestedDecisions")] ?? [];
    expect(decisions.map((step) => step.kind)).toEqual(["branch", "branch", "branch", "exit"]);
    expect(decisions[0]).toMatchObject({ kind: "branch", branchKind: "if" });
    expect(decisions[1]).toMatchObject({ kind: "branch", branchKind: "if" });
    expect(decisions[2]).toMatchObject({ kind: "branch", branchKind: "switch" });
    if (decisions[0]?.kind === "branch" && decisions[1]?.kind === "branch" && decisions[2]?.kind === "branch") {
      expect(decisions[0].paths[0].body.at(-1)).toMatchObject({ kind: "exit", variant: "return" });
      expect(decisions[1].paths[0].body[0]).toMatchObject({ kind: "branch", branchKind: "if" });
      expect(decisions[1].paths[1].body[0]).toMatchObject({ kind: "branch", branchKind: "if" });
      expect(decisions[2].paths.map((path) => path.role)).toEqual(["case", "case", "case", "default"]);
      expect(decisions[2].paths[1].body.at(-1)).toMatchObject({ kind: "exit", variant: "return" });
      expect(decisions[2].paths[3].body.at(-1)).toMatchObject({ kind: "exit", variant: "throw" });
    }

    const loops = result.flows?.[galleryId("loopShapes")] ?? [];
    expect(loops).toHaveLength(4);
    expect(loops.every((step) => step.kind === "loop")).toBe(true);
    expect(loops.map((step) => step.label)).toEqual([
      "for let attempt = 0",
      "for each orderId",
      "while cursor < orderIds.length",
      "while sweep < 2",
    ]);

    const protectedFlow = result.flows?.[galleryId("tryCatchFinally")] ?? [];
    expect(protectedFlow[0]).toMatchObject({ kind: "branch", branchKind: "try", label: "try/catch" });
    if (protectedFlow[0]?.kind === "branch") {
      expect(protectedFlow[0].paths.map((path) => path.role)).toEqual(["try", "catch", "finally"]);
      expect(protectedFlow[0].paths[0].body[0]).toMatchObject({
        kind: "call",
        label: "this.performProtectedWork",
        async: { kind: "direct-await" },
      });
    }

    const handOffs = result.flows?.[galleryId("callbackHandOffs")] ?? [];
    expect(handOffs.map((step) => step.kind)).toEqual(["call", "callback", "call", "callback", "loop"]);
    expect(handOffs.filter((step) => step.kind === "callback").map((step) => step.label)).toEqual([
      "callback → setTimeout",
      "callback → this.registerHandOff",
    ]);

    const detached = result.flows?.[galleryId("externalAndDetached")] ?? [];
    expect(detached.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: "call", label: "console.info", resolution: "external" }),
      expect.objectContaining({ kind: "call", label: "console.timeStamp", resolution: "external" }),
    ]);
    expect(detached.slice(2)).toEqual([
      expect.objectContaining({ kind: "call", label: "this.publishTelemetry", detached: true }),
      expect.objectContaining({ kind: "call", label: "this.refreshReadModel", detached: true }),
    ]);
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
