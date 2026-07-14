/**
 * Golden test: extract the orders-service-py fixture and assert the exact resolved call/new
 * graph (by source->target qualname), the node-id grammar + package nodes, the builtins-drop
 * policy, the telemetry contract on callables, and a full Tier-1 + Tier-2 validation pass.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateArtifact, type ExtractionResult, type GraphArtifact, type GraphEdge } from "@meridian/core";
import { createPythonExtractor } from "./index";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_ROOT = join(REPO_ROOT, "examples", "orders-service-py");

async function extractFixture(overrides = {}): Promise<ExtractionResult> {
  return createPythonExtractor().extract({ root: FIXTURE_ROOT, ...overrides });
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
    target: { name: "orders-service-py", root: "examples/orders-service-py", language: "python" },
    telemetry: { joinKey: "node.id", requiredRuntimeAttributes: ["service.name"], serviceDefaulting: "forbidden" },
    nodes: result.nodes,
    edges: result.edges,
  };
}

describe("PythonExtractor over orders-service-py", () => {
  it("resolves the OrderRoutes handlers", async () => {
    const result = await extractFixture();
    expect(hasEdge(result, "calls", "OrderRoutes.handle_create_order", "OrderService.place_order")).toBe(true);
    expect(hasEdge(result, "calls", "OrderRoutes.handle_create_order", "OrderRoutes._created")).toBe(true);
    expect(hasEdge(result, "instantiates", "OrderRoutes.handle_create_order", "ApiResponse")).toBe(true);
    expect(hasEdge(result, "calls", "OrderRoutes.handle_get_order", "OrderService.get_order")).toBe(true);
    expect(hasEdge(result, "instantiates", "OrderRoutes.handle_get_order", "ApiResponse")).toBe(true);
  });

  it("resolves the OrderService fan-out", async () => {
    const result = await extractFixture();
    for (const target of [
      "validate_order_request",
      "PricingService.price",
      "OrderService._assemble",
      "OrderRepository.save",
      "EmailService.send_order_confirmation",
    ]) {
      expect(hasEdge(result, "calls", "OrderService.place_order", target)).toBe(true);
    }
    expect(hasEdge(result, "calls", "OrderService.get_order", "OrderRepository.find_by_id")).toBe(true);
    expect(hasEdge(result, "instantiates", "OrderService._assemble", "Order")).toBe(true);
    expect(hasEdge(result, "calls", "OrderService._assemble", "OrderService._next_id")).toBe(true);
  });

  it("resolves pricing, email, and validation internals", async () => {
    const result = await extractFixture();
    for (const target of ["PricingService._subtotal", "PricingService._discount_for", "PricingService._tax"]) {
      expect(hasEdge(result, "calls", "PricingService.price", target)).toBe(true);
    }
    expect(hasEdge(result, "calls", "PricingService._discount_for", "PricingService._is_known_code")).toBe(true);
    expect(hasEdge(result, "calls", "EmailService.send_order_confirmation", "EmailService._render_confirmation")).toBe(true);
    expect(hasEdge(result, "calls", "EmailService.send_order_confirmation", "EmailService._deliver")).toBe(true);
    expect(hasEdge(result, "calls", "validate_order_request", "_assert_line_is_sane")).toBe(true);
    expect(hasEdge(result, "instantiates", "validate_order_request", "ValidationError")).toBe(true);
  });

  it("emits instantiates edges from build_orders_app", async () => {
    const result = await extractFixture();
    for (const target of ["PricingService", "OrderRepository", "EmailService", "OrderService", "OrderRoutes"]) {
      expect(hasEdge(result, "instantiates", "build_orders_app", target)).toBe(true);
    }
  });

  it("ids follow the <lang>:<modulePath>#<qualname> grammar with package nodes", async () => {
    const result = await extractFixture();
    const placeOrder = result.nodes.find((node) => node.qualifiedName === "OrderService.place_order");
    expect(placeOrder?.id).toBe("py:orders.services.order_service#OrderService.place_order");
    expect(result.nodes.some((node) => node.kind === "package" && node.id === "py:orders")).toBe(true);
    expect(result.nodes.some((node) => node.kind === "package" && node.id === "py:orders.services")).toBe(true);
  });

  it("drops builtins as external by default and counts an unresolved call", async () => {
    const result = await extractFixture();
    expect(result.stats.externalCallsDropped).toBeGreaterThan(0);
    expect(result.stats.unresolvedCalls).toBeGreaterThan(0);
    const names = qualnameById(result);
    const leaksBuiltin = result.edges.some((edge) => ["len", "round", "sum"].includes(names.get(edge.target) ?? ""));
    expect(leaksBuiltin).toBe(false);
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

  it("disambiguates colliding ids with ~n ordinals instead of emitting duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-pydup-"));
    try {
      await writeFile(join(root, "twice.py"), "def f():\n    return 1\n\n\ndef f():\n    return 2\n");
      const result = await createPythonExtractor().extract({ root });
      const ids = result.nodes.map((node) => node.id).sort();
      expect(ids).toContain("py:twice#f");
      expect(ids).toContain("py:twice#f~1");
      expect(new Set(ids).size).toBe(ids.length); // no duplicates survive
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never walks virtualenvs or vendored trees (a real .venv holds 20k+ files)", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-pyvenv-"));
    try {
      await mkdir(join(root, ".venv", "lib"), { recursive: true });
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(root, "app.py"), "def main():\n    return 1\n");
      await writeFile(join(root, ".venv", "lib", "vendored.py"), "def hidden():\n    return 2\n");
      await writeFile(join(root, "node_modules", "pkg", "shim.py"), "def shim():\n    return 3\n");
      const result = await createPythonExtractor().extract({ root });
      const files = new Set(result.nodes.map((node) => node.location.file));
      expect(files.has("app.py")).toBe(true);
      expect([...files].some((file) => file.includes(".venv") || file.includes("node_modules"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps syntax diagnostics repository-relative", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-pysyntax-"));
    try {
      await writeFile(join(root, "broken.py"), "def broken(:\n    pass\n");
      const result = await createPythonExtractor().extract({ root });
      const warning = result.diagnostics.find((diagnostic) => diagnostic.message.includes("failed to parse broken.py"));

      expect(warning?.severity).toBe("warn");
      expect(warning?.message).toContain("broken.py");
      expect(warning?.message).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves nested-class fields and locally constructed instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-pynested-class-"));
    try {
      await writeFile(join(root, "nested.py"), [
        "class Dependency:",
        "    def work(self):", "        return 1", "",
        "def outer():",
        "    class Inner:",
        "        def __init__(self, dependency: Dependency):", "            self.dependency = dependency",
        "        def run(self):", "            return self.dependency.work()", "",
        "    instance = Inner(Dependency())", "    return instance.run()", "",
      ].join("\n"));
      const result = await createPythonExtractor().extract({ root });
      expect(hasEdge(result, "calls", "outer.Inner.run", "Dependency.work")).toBe(true);
      expect(hasEdge(result, "calls", "outer", "outer.Inner.run")).toBe(true);
      expect(hasEdge(result, "instantiates", "outer", "outer.Inner")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
