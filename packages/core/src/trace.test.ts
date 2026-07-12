import { describe, expect, it } from "vitest";
import { buildMockTraceBundle } from "./mock";
import { timelineEventSchema, traceBundleSchema } from "./trace";
import type { GraphArtifact, GraphNode } from "./types";
import { validArtifact } from "./testing/fixtures";

const ROOT = "ts:src/api/orderRoutes.ts#OrderRoutes.handleCreateOrder";
const ORDER_NODE_IDS = [
  ROOT,
  "ts:src/api/orderRoutes.ts#OrderRoutes.toErrorResponse",
  "ts:src/services/orderService.ts#OrderService.assemble",
  "ts:src/validation/orderValidator.ts#validateOrderRequest",
  "ts:src/pricing/pricingService.ts#PricingService.price",
  "ts:src/repository/orderRepository.ts#OrderRepository.save",
  "ts:src/notifications/emailService.ts#EmailService.sendOrderConfirmation",
];

describe("request trace contract", () => {
  it("validates every event variant in the orders-service demo", () => {
    const bundle = buildMockTraceBundle(ordersGraph(), "demo");
    expect(traceBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.source).toBe("mock");
    expect(new Set(bundle.traces.flatMap((trace) => trace.spans.flatMap((span) => span.events.map((event) => event.type))))).toEqual(
      new Set(["branch.taken", "data.observe", "loop.summary", "exception"]),
    );
  });

  it("requires stable event ids and OTel-compatible attribute values", () => {
    expect(timelineEventSchema.safeParse({
      type: "data.observe",
      timeUnixNano: "1",
      attributes: {},
      name: "missing event id",
      valueId: "value-1",
      value: true,
    }).success).toBe(false);
    expect(timelineEventSchema.safeParse({
      type: "data.observe",
      eventId: "unsafe-value",
      timeUnixNano: "1",
      attributes: {},
      name: "unsafe",
      valueId: "value-1",
      value: { nested: "objects are not OTel attributes" },
    }).success).toBe(false);
  });

  it("accepts an async handoff with an optional target span", () => {
    expect(timelineEventSchema.safeParse({
      type: "async.handoff",
      eventId: "handoff-1",
      timeUnixNano: "1",
      attributes: {},
      mode: "detached",
      siteId: "site:notify",
      source: { file: "src/notify.ts", line: 12 },
      targetSpanId: "1000000000000001",
    }).success).toBe(true);
  });
});

describe("orders-service mock request traces", () => {
  it("emits nothing for an unrelated graph", () => {
    expect(buildMockTraceBundle(validArtifact(), "demo").traces).toEqual([]);
  });

  it("is deterministic and preserves the canonical success and handled-error requests", () => {
    const graph = ordersGraph();
    const first = buildMockTraceBundle(graph, "demo");
    expect(JSON.stringify(first)).toBe(JSON.stringify(buildMockTraceBundle(graph, "demo")));
    expect(first.traces.length).toBeGreaterThanOrEqual(12);
    expect(first.traces.slice(0, 2).map((trace) => [trace.traceId, trace.name, trace.status])).toEqual([
      ["11111111111111111111111111111111", "POST /orders — WELCOME10", "ok"],
      ["22222222222222222222222222222222", "POST /orders — missing customer", "unset"],
    ]);
  });

  it("orders traces chronologically and uses globally unique trace, span, and event ids", () => {
    const bundle = buildMockTraceBundle(ordersGraph(), "demo");
    expect(traceBundleSchema.safeParse(bundle).success).toBe(true);
    for (let index = 1; index < bundle.traces.length; index += 1) {
      expect(BigInt(bundle.traces[index]!.startedAtUnixNano)).toBeGreaterThan(BigInt(bundle.traces[index - 1]!.startedAtUnixNano));
    }

    const traceIds = bundle.traces.map((trace) => trace.traceId);
    const spanIds = bundle.traces.flatMap((trace) => trace.spans.map((span) => span.spanId));
    const eventIds = bundle.traces.flatMap((trace) => trace.spans.flatMap((span) => span.events.map((event) => event.eventId)));
    expect(new Set(traceIds).size).toBe(traceIds.length);
    expect(new Set(spanIds).size).toBe(spanIds.length);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  it("uses only exact graph node ids and maintains request-relative timing", () => {
    const graph = ordersGraph();
    const bundle = buildMockTraceBundle(graph, "demo");
    const knownIds = new Set(graph.nodes.map((node) => node.id));
    for (const trace of bundle.traces) {
      expect(trace.spans.some((span) => span.spanId === trace.rootSpanId)).toBe(true);
      for (const span of trace.spans) {
        expect(span.nodeId && knownIds.has(span.nodeId)).toBe(true);
        expect(BigInt(span.startedAtUnixNano)).toBeGreaterThanOrEqual(BigInt(trace.startedAtUnixNano));
        expect(BigInt(span.endedAtUnixNano)).toBeLessThanOrEqual(BigInt(trace.endedAtUnixNano));
        expect(BigInt(span.endedAtUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startedAtUnixNano));
      }
    }
  });

  it("shows the discount path and reuses the order value token downstream", () => {
    const bundle = buildMockTraceBundle(ordersGraph(), "demo");
    const success = bundle.traces[0];
    const events = success.spans.flatMap((span) => span.events);
    expect(events).toContainEqual(expect.objectContaining({ type: "branch.taken", siteId: "price:discount", outcome: false, valueName: "request.discountCode", value: "WELCOME10" }));
    for (const event of bundle.traces.flatMap((trace) => trace.spans.flatMap((span) => span.events))) {
      if (event.type === "branch.taken" && event.value !== undefined) expect(event.valueName).toBeTruthy();
    }
    expect(events.filter((event) => event.type === "data.observe" && event.valueId === "order-1")).toHaveLength(3);
  });

  it("takes the validation catch path without executing downstream work", () => {
    const failed = buildMockTraceBundle(ordersGraph(), "demo").traces[1];
    expect(failed.spans.flatMap((span) => span.events)).toContainEqual(
      expect.objectContaining({ type: "branch.taken", siteId: "validate:customer", outcome: true }),
    );
    expect(failed.spans.map((span) => span.nodeId)).not.toEqual(expect.arrayContaining([
      "ts:src/pricing/pricingService.ts#PricingService.price",
      "ts:src/repository/orderRepository.ts#OrderRepository.save",
      "ts:src/notifications/emailService.ts#EmailService.sendOrderConfirmation",
    ]));
    expect(failed.spans.find((span) => span.spanId === failed.rootSpanId)?.status).toBe("unset");
    expect(failed.spans.find((span) => span.name === "validateOrderRequest")?.status).toBe("error");
  });

  it("varies customer, quantity, discount, validation, and internal-error flows", () => {
    const traces = buildMockTraceBundle(ordersGraph(), "demo").traces;
    const noDiscount = traces.find((trace) => trace.name.includes("new customer · no discount"));
    expect(noDiscount?.attributes).toMatchObject({
      "order.customer.segment": "new",
      "order.lines.count": 1,
      "order.quantity.total": 1,
    });
    expect(noDiscount?.spans.flatMap((span) => span.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "branch.taken", siteId: "price:discount", outcome: true, value: "none" }),
      expect.objectContaining({ type: "data.observe", name: "money.discountCents", value: 0 }),
    ]));

    const loyalDiscount = traces.find((trace) => trace.name.includes("LOYAL10 · 3 items"));
    expect(loyalDiscount?.spans.flatMap((span) => span.events)).toContainEqual(
      expect.objectContaining({ type: "branch.taken", siteId: "price:discount", outcome: false, value: "LOYAL10" }),
    );

    const invalidQuantity = traces.find((trace) => trace.name.includes("non-positive quantity"));
    expect(invalidQuantity?.attributes["http.response.status_code"]).toBe(400);
    expect(invalidQuantity?.spans.flatMap((span) => span.events)).toContainEqual(
      expect.objectContaining({ type: "branch.taken", siteId: "validate:quantity", outcome: true, value: 0 }),
    );
    expect(invalidQuantity?.spans.flatMap((span) => span.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "branch.taken", siteId: "validate:sku", pathId: "else", source: { file: "src/validation/orderValidator.ts", line: 21 } }),
      expect.objectContaining({ type: "branch.taken", siteId: "validate:quantity", pathId: "then", source: { file: "src/validation/orderValidator.ts", line: 24 } }),
      expect.objectContaining({ type: "exception", source: { file: "src/validation/orderValidator.ts", line: 25 } }),
    ]));

    const invalidPrice = traces.find((trace) => trace.name.includes("negative price"));
    expect(invalidPrice?.spans.flatMap((span) => span.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "branch.taken", siteId: "validate:sku", pathId: "else" }),
      expect.objectContaining({ type: "branch.taken", siteId: "validate:quantity", pathId: "else" }),
      expect.objectContaining({ type: "branch.taken", siteId: "validate:price", pathId: "then", source: { file: "src/validation/orderValidator.ts", line: 27 } }),
    ]));

    const repositoryTimeout = traces.find((trace) => trace.name.includes("repository timeout"));
    expect(repositoryTimeout).toMatchObject({ status: "error", attributes: { "http.response.status_code": 500 } });
    expect(repositoryTimeout?.spans.map((span) => span.nodeId)).not.toContain("ts:src/notifications/emailService.ts#EmailService.sendOrderConfirmation");
    expect(repositoryTimeout?.spans.flatMap((span) => span.events)).toContainEqual(
      expect.objectContaining({ type: "exception", exceptionType: "RepositoryTimeout", handled: false }),
    );
  });

  it("retains runtime spans and causal ids when their graph nodes are unavailable", () => {
    const graph = ordersGraph();
    graph.nodes = graph.nodes.filter((node) => node.id === ROOT);
    const bundle = buildMockTraceBundle(graph, "demo");
    const success = bundle.traces[0];
    expect(success.spans).toHaveLength(7);
    const validate = success.spans.find((span) => span.name === "validateOrderRequest");
    expect(validate).toMatchObject({
      parentSpanId: "1000000000000002",
      attributes: { "meridian.unmapped.node.id": "ts:src/validation/orderValidator.ts#validateOrderRequest" },
    });
    expect(validate?.nodeId).toBeUndefined();
    expect(validate?.attributes["meridian.node.id"]).toBeUndefined();
    expect(success.completeness).toEqual({ complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 });
    expect(traceBundleSchema.safeParse(bundle).success).toBe(true);
  });
});

function ordersGraph(): GraphArtifact {
  const graph = validArtifact();
  const existing = new Set(graph.nodes.map((node) => node.id));
  graph.nodes.push(...ORDER_NODE_IDS.filter((id) => !existing.has(id)).map(traceNode));
  return graph;
}

function traceNode(id: string): GraphNode {
  const qualifiedName = id.split("#")[1] ?? id;
  return {
    id,
    kind: "method",
    qualifiedName,
    displayName: qualifiedName.split(".").at(-1) ?? qualifiedName,
    location: { file: id.slice(3).split("#")[0], startLine: 1 },
  };
}
