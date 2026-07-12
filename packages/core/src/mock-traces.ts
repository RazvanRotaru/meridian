/** Deterministic, privacy-safe request traces for the orders-service fixture. */

import { TRACE_VERSION } from "./trace";
import type {
  BranchTakenEvent,
  DataObserveEvent,
  ExceptionTimelineEvent,
  RequestTrace,
  TimelineEvent,
  TimelineSpan,
  TraceAttributeScalar,
  TraceBundle,
  TraceSource,
} from "./trace";
import type { GraphArtifact } from "./types";

const GENERATED_AT = "1970-01-01T00:00:00.000Z";

const NODE = {
  root: "ts:src/api/orderRoutes.ts#OrderRoutes.handleCreateOrder",
  errorResponse: "ts:src/api/orderRoutes.ts#OrderRoutes.toErrorResponse",
  place: "ts:src/services/orderService.ts#OrderService.placeOrder",
  assemble: "ts:src/services/orderService.ts#OrderService.assemble",
  validate: "ts:src/validation/orderValidator.ts#validateOrderRequest",
  price: "ts:src/pricing/pricingService.ts#PricingService.price",
  save: "ts:src/repository/orderRepository.ts#OrderRepository.save",
  email: "ts:src/notifications/emailService.ts#EmailService.sendOrderConfirmation",
} as const;

const COMPLETE = { complete: true, droppedSpans: 0, droppedEvents: 0, droppedValues: 0 } as const;
const TRACE_EPOCH_NANO = 1_767_225_600_000_000_000n;
const API = (line: number): TraceSource => ({ file: "src/api/orderRoutes.ts", line });
const VALIDATION = (line: number): TraceSource => ({ file: "src/validation/orderValidator.ts", line });
const PRICING = (line: number): TraceSource => ({ file: "src/pricing/pricingService.ts", line });

interface SuccessScenario {
  ordinal: number;
  name: string;
  customerSegment: string;
  lineCount: number;
  totalQuantity: number;
  subtotalCents: number;
  discountCode?: string;
  durationMs: number;
}

interface ValidationFailureScenario {
  ordinal: number;
  name: string;
  customerSegment: string;
  lineCount: number;
  totalQuantity: number;
  siteId: string;
  condition: string;
  branchLine: number;
  throwLine: number;
  message: string;
}

const SUCCESS_SCENARIOS: SuccessScenario[] = [
  { ordinal: 3, name: "POST /orders — new customer · no discount · 1 item", customerSegment: "new", lineCount: 1, totalQuantity: 1, subtotalCents: 1_250, durationMs: 52 },
  { ordinal: 4, name: "POST /orders — loyal customer · LOYAL10 · 3 items", customerSegment: "loyal", lineCount: 3, totalQuantity: 4, subtotalCents: 12_750, discountCode: "LOYAL10", durationMs: 58 },
  { ordinal: 5, name: "POST /orders — wholesale customer · WELCOME10 · 12 units", customerSegment: "wholesale", lineCount: 4, totalQuantity: 12, subtotalCents: 22_000, discountCode: "WELCOME10", durationMs: 63 },
  { ordinal: 6, name: "POST /orders — returning customer · unknown code · 2 items", customerSegment: "returning", lineCount: 2, totalQuantity: 3, subtotalCents: 8_200, discountCode: "SPRING25", durationMs: 55 },
  { ordinal: 7, name: "POST /orders — priority customer · no discount · 6 items", customerSegment: "priority", lineCount: 6, totalQuantity: 18, subtotalCents: 45_500, durationMs: 70 },
  { ordinal: 8, name: "POST /orders — loyal customer · LOYAL10 · 1 item", customerSegment: "loyal", lineCount: 1, totalQuantity: 2, subtotalCents: 3_600, discountCode: "LOYAL10", durationMs: 49 },
];

const VALIDATION_FAILURE_SCENARIOS: ValidationFailureScenario[] = [
  { ordinal: 9, name: "POST /orders — empty cart", customerSegment: "new", lineCount: 0, totalQuantity: 0, siteId: "validate:lines", condition: "request.lines.length === 0", branchLine: 11, throwLine: 12, message: "order has no items" },
  { ordinal: 10, name: "POST /orders — non-positive quantity", customerSegment: "returning", lineCount: 1, totalQuantity: 0, siteId: "validate:quantity", condition: "quantity <= 0", branchLine: 24, throwLine: 25, message: "order line has a non-positive quantity" },
  { ordinal: 11, name: "POST /orders — missing product", customerSegment: "business", lineCount: 1, totalQuantity: 1, siteId: "validate:sku", condition: "!sku", branchLine: 21, throwLine: 22, message: "order line is missing a product" },
  { ordinal: 12, name: "POST /orders — negative price", customerSegment: "loyal", lineCount: 2, totalQuantity: 3, siteId: "validate:price", condition: "unitPriceCents < 0", branchLine: 27, throwLine: 28, message: "order line has a negative price" },
];

export function buildOrdersMockTraceBundle(graph: GraphArtifact, env: string): TraceBundle {
  const graphRef = {
    schemaVersion: graph.schemaVersion,
    generatedAt: graph.generatedAt,
    nodeCount: graph.nodes.length,
    ...(graph.target.vcs?.commit ? { commit: graph.target.vcs.commit } : {}),
  };
  const bundle: TraceBundle = { traceVersion: TRACE_VERSION, source: "mock", env, generatedAt: GENERATED_AT, graphRef, traces: [] };
  const knownNodes = new Set(graph.nodes.map((node) => node.id));
  if (!knownNodes.has(NODE.root)) return bundle;
  const traces = [
    successTrace(),
    errorTrace(),
    ...SUCCESS_SCENARIOS.map(successVariantTrace),
    ...VALIDATION_FAILURE_SCENARIOS.map(validationFailureTrace),
    internalFailureTrace(),
  ];
  return { ...bundle, traces: traces.map((trace) => retainKnownSpans(trace, knownNodes)) };
}

function successTrace(): RequestTrace {
  const traceId = "11111111111111111111111111111111";
  const rootSpanId = "1000000000000001";
  return {
    traceId,
    name: "POST /orders — WELCOME10",
    rootSpanId,
    startedAtUnixNano: "1767225600000000000",
    endedAtUnixNano: "1767225600050000000",
    status: "ok",
    attributes: { "http.request.method": "POST", "http.route": "/orders", "http.response.status_code": 201 },
    completeness: { ...COMPLETE },
    spans: [
      span(rootSpanId, NODE.root, "OrderRoutes.handleCreateOrder", undefined, "1767225600000000000", "1767225600050000000", [
        observed("s-request", "1767225600001000000", "request", "request-1", "OrderRequest", API(15), undefined, undefined, { "field.names": ["customerId", "lines", "discountCode"] }),
        observed("s-root-response", "1767225600049000000", "response.status", "status-201", 201, API(19)),
      ], "server"),
      span("1000000000000002", NODE.place, "OrderService.placeOrder", rootSpanId, "1767225600002000000", "1767225600045000000"),
      span("1000000000000003", NODE.validate, "validateOrderRequest", "1000000000000002", "1767225600004000000", "1767225600010000000", [
        branch("s-customer", "1767225600005000000", "validate:customer", "else", "!request.customerId", false, VALIDATION(8), "customer.present", true),
        branch("s-lines", "1767225600006000000", "validate:lines", "else", "request.lines.length === 0", false, VALIDATION(11), "request.lines.count", 2),
        { type: "loop.summary", eventId: "s-lines-loop", timeUnixNano: "1767225600009000000", attributes: {}, siteId: "validate:line-loop", label: "for request.lines", iterations: 2, emittedIterations: 2, truncated: false, source: VALIDATION(14) },
      ]),
      span("1000000000000004", NODE.price, "PricingService.price", "1000000000000002", "1767225600012000000", "1767225600022000000", [
        branch("s-discount", "1767225600015000000", "price:discount", "else", "!code || !isKnownCode(code)", false, PRICING(28), "request.discountCode", "WELCOME10"),
        observed("s-subtotal", "1767225600016000000", "money.subtotalCents", "subtotal-1", 5000, PRICING(8), undefined, ["request-1"]),
        observed("s-discount-value", "1767225600017000000", "money.discountCents", "discount-1", 500, PRICING(9), undefined, ["subtotal-1"]),
        observed("s-total", "1767225600021000000", "money.totalCents", "money-1", 5400, PRICING(15), undefined, ["subtotal-1", "discount-1"]),
      ]),
      span("1000000000000005", NODE.assemble, "OrderService.assemble", "1000000000000002", "1767225600023000000", "1767225600030000000", [
        observed("s-order", "1767225600029000000", "order", "order-1", "Order", { file: "src/services/orderService.ts", line: 36 }, undefined, ["request-1", "money-1"], { "field.names": ["id", "customerId", "lines", "subtotalCents", "discountCents", "taxCents", "totalCents", "createdAt"] }),
      ]),
      span("1000000000000006", NODE.save, "OrderRepository.save", "1000000000000002", "1767225600032000000", "1767225600035000000", [
        observed("s-save-order", "1767225600033000000", "argument.order", "order-1", "Order", { file: "src/repository/orderRepository.ts", line: 8 }, undefined, ["order-1"]),
      ]),
      span("1000000000000007", NODE.email, "EmailService.sendOrderConfirmation", "1000000000000002", "1767225600036000000", "1767225600043000000", [
        observed("s-email-order", "1767225600037000000", "argument.order", "order-1", "Order", { file: "src/notifications/emailService.ts", line: 6 }, undefined, ["order-1"]),
      ]),
    ],
  };
}

function errorTrace(): RequestTrace {
  const rootSpanId = "2000000000000001";
  return {
    traceId: "22222222222222222222222222222222",
    name: "POST /orders — missing customer",
    rootSpanId,
    startedAtUnixNano: "1767225601000000000",
    endedAtUnixNano: "1767225601020000000",
    status: "unset",
    attributes: { "http.request.method": "POST", "http.route": "/orders", "http.response.status_code": 400 },
    completeness: { ...COMPLETE },
    spans: [
      span(rootSpanId, NODE.root, "OrderRoutes.handleCreateOrder", undefined, "1767225601000000000", "1767225601020000000", [
        observed("e-customer-present", "1767225601001000000", "request.customer.present", "customer-present-2", false, API(15)),
        branch("e-catch", "1767225601010000000", "route:create:try", "catch", "catch (error)", "ValidationError", API(20), "error.type", "ValidationError"),
        exception("e-handled", "1767225601011000000", true, API(20)),
        observed("e-response", "1767225601019000000", "response.status", "status-400", 400, API(21)),
      ], "server", "unset"),
      span("2000000000000002", NODE.place, "OrderService.placeOrder", rootSpanId, "1767225601002000000", "1767225601009000000", [], "internal", "error"),
      span("2000000000000003", NODE.validate, "validateOrderRequest", "2000000000000002", "1767225601004000000", "1767225601008000000", [
        branch("e-customer", "1767225601005000000", "validate:customer", "then", "!request.customerId", true, VALIDATION(8), "customer.present", false),
        exception("e-thrown", "1767225601006000000", false, VALIDATION(9)),
      ], "internal", "error"),
      span("2000000000000004", NODE.errorResponse, "OrderRoutes.toErrorResponse", rootSpanId, "1767225601012000000", "1767225601017000000", [
        branch("e-validation", "1767225601013000000", "route:error-type", "then", "error instanceof ValidationError", true, API(41), "error.type", "ValidationError"),
      ]),
    ],
  };
}

function successVariantTrace(scenario: SuccessScenario): RequestTrace {
  const traceId = variantTraceId(scenario.ordinal);
  const rootSpanId = variantSpanId(scenario.ordinal, 1);
  const placeSpanId = variantSpanId(scenario.ordinal, 2);
  const start = variantStart(scenario.ordinal);
  const time = (offsetMs: number): string => nanoAt(start, offsetMs);
  const eventId = (name: string): string => variantEventId(scenario.ordinal, name);
  const valueId = (name: string): string => `value-${scenario.ordinal}-${name}`;
  const knownDiscount = scenario.discountCode === "WELCOME10" || scenario.discountCode === "LOYAL10";
  const discountCents = knownDiscount ? Math.round(scenario.subtotalCents * 0.1) : 0;
  const taxableCents = scenario.subtotalCents - discountCents;
  const taxCents = Math.round(taxableCents * 0.2);
  const totalCents = taxableCents + taxCents;
  const orderValueId = valueId("order");

  return {
    traceId,
    name: scenario.name,
    rootSpanId,
    startedAtUnixNano: time(0),
    endedAtUnixNano: time(scenario.durationMs),
    status: "ok",
    attributes: {
      "http.request.method": "POST",
      "http.route": "/orders",
      "http.response.status_code": 201,
      "order.customer.segment": scenario.customerSegment,
      "order.lines.count": scenario.lineCount,
      "order.quantity.total": scenario.totalQuantity,
      "order.discount.code": scenario.discountCode ?? "none",
    },
    completeness: { ...COMPLETE },
    spans: [
      span(rootSpanId, NODE.root, "OrderRoutes.handleCreateOrder", undefined, time(0), time(scenario.durationMs), [
        observed(eventId("request-segment"), time(1), "request.customer.segment", valueId("customer-segment"), scenario.customerSegment, API(15)),
        observed(eventId("response"), time(scenario.durationMs - 1), "response.status", valueId("status-201"), 201, API(19)),
      ], "server"),
      span(placeSpanId, NODE.place, "OrderService.placeOrder", rootSpanId, time(2), time(scenario.durationMs - 5)),
      span(variantSpanId(scenario.ordinal, 3), NODE.validate, "validateOrderRequest", placeSpanId, time(4), time(10), [
        branch(eventId("customer"), time(5), "validate:customer", "else", "!request.customerId", false, VALIDATION(8), "customer.present", true),
        branch(eventId("lines"), time(6), "validate:lines", "else", "request.lines.length === 0", false, VALIDATION(11), "request.lines.count", scenario.lineCount),
        observed(eventId("quantity"), time(7), "request.lines.quantity.total", valueId("quantity-total"), scenario.totalQuantity, VALIDATION(14)),
        {
          type: "loop.summary",
          eventId: eventId("lines-loop"),
          timeUnixNano: time(9),
          attributes: {},
          siteId: "validate:line-loop",
          label: "for request.lines",
          iterations: scenario.lineCount,
          emittedIterations: scenario.lineCount,
          truncated: false,
          source: VALIDATION(14),
        },
      ]),
      span(variantSpanId(scenario.ordinal, 4), NODE.price, "PricingService.price", placeSpanId, time(12), time(22), [
        branch(
          eventId("discount"),
          time(15),
          "price:discount",
          knownDiscount ? "else" : "then",
          "!code || !isKnownCode(code)",
          !knownDiscount,
          PRICING(28),
          "request.discountCode",
          scenario.discountCode ?? "none",
        ),
        observed(eventId("subtotal"), time(16), "money.subtotalCents", valueId("subtotal"), scenario.subtotalCents, PRICING(8)),
        observed(eventId("discount-value"), time(17), "money.discountCents", valueId("discount"), discountCents, PRICING(9), undefined, [valueId("subtotal")]),
        observed(eventId("tax"), time(20), "money.taxCents", valueId("tax"), taxCents, PRICING(13), undefined, [valueId("subtotal"), valueId("discount")]),
        observed(eventId("total"), time(21), "money.totalCents", valueId("total"), totalCents, PRICING(15), undefined, [valueId("subtotal"), valueId("discount"), valueId("tax")]),
      ]),
      span(variantSpanId(scenario.ordinal, 5), NODE.assemble, "OrderService.assemble", placeSpanId, time(23), time(30), [
        observed(eventId("order"), time(29), "order", orderValueId, "Order", { file: "src/services/orderService.ts", line: 36 }, undefined, [valueId("total")], { "field.names": ["id", "customerId", "lines", "subtotalCents", "discountCents", "taxCents", "totalCents", "createdAt"] }),
      ]),
      span(variantSpanId(scenario.ordinal, 6), NODE.save, "OrderRepository.save", placeSpanId, time(32), time(35), [
        observed(eventId("save-order"), time(33), "argument.order", orderValueId, "Order", { file: "src/repository/orderRepository.ts", line: 8 }, undefined, [orderValueId]),
      ]),
      span(variantSpanId(scenario.ordinal, 7), NODE.email, "EmailService.sendOrderConfirmation", placeSpanId, time(36), time(43), [
        observed(eventId("email-order"), time(37), "argument.order", orderValueId, "Order", { file: "src/notifications/emailService.ts", line: 6 }, undefined, [orderValueId]),
      ]),
    ],
  };
}

function validationFailureTrace(scenario: ValidationFailureScenario): RequestTrace {
  const rootSpanId = variantSpanId(scenario.ordinal, 1);
  const placeSpanId = variantSpanId(scenario.ordinal, 2);
  const start = variantStart(scenario.ordinal);
  const durationMs = 22 + (scenario.ordinal - 9);
  const time = (offsetMs: number): string => nanoAt(start, offsetMs);
  const eventId = (name: string): string => variantEventId(scenario.ordinal, name);
  const validationEvents: TimelineEvent[] = [
    branch(eventId("customer"), time(5), "validate:customer", "else", "!request.customerId", false, VALIDATION(8), "customer.present", true),
    branch(
      eventId("lines"),
      time(6),
      "validate:lines",
      scenario.lineCount === 0 ? "then" : "else",
      "request.lines.length === 0",
      scenario.lineCount === 0,
      VALIDATION(11),
      "request.lines.count",
      scenario.lineCount,
    ),
  ];

  if (scenario.lineCount > 0) {
    validationEvents.push({
      type: "loop.summary",
      eventId: eventId("lines-loop"),
      timeUnixNano: time(7),
      attributes: {},
      siteId: "validate:line-loop",
      label: "for request.lines",
      iterations: scenario.lineCount,
      emittedIterations: scenario.lineCount,
      truncated: false,
      source: VALIDATION(14),
    });
    validationEvents.push(...lineValidationFailureEvents(scenario, eventId, time));
  }
  validationEvents.push(exception(eventId("thrown"), time(scenario.lineCount === 0 ? 8 : 9), false, VALIDATION(scenario.throwLine), scenario.message));

  return {
    traceId: variantTraceId(scenario.ordinal),
    name: scenario.name,
    rootSpanId,
    startedAtUnixNano: time(0),
    endedAtUnixNano: time(durationMs),
    status: "unset",
    attributes: {
      "http.request.method": "POST",
      "http.route": "/orders",
      "http.response.status_code": 400,
      "order.customer.segment": scenario.customerSegment,
      "order.lines.count": scenario.lineCount,
      "order.quantity.total": scenario.totalQuantity,
      "validation.failure.site": scenario.siteId,
    },
    completeness: { ...COMPLETE },
    spans: [
      span(rootSpanId, NODE.root, "OrderRoutes.handleCreateOrder", undefined, time(0), time(durationMs), [
        observed(eventId("request-segment"), time(1), "request.customer.segment", `value-${scenario.ordinal}-customer-segment`, scenario.customerSegment, API(15)),
        branch(eventId("catch"), time(12), "route:create:try", "catch", "catch (error)", "ValidationError", API(20), "error.type", "ValidationError"),
        exception(eventId("handled"), time(13), true, API(20), scenario.message),
        observed(eventId("response"), time(durationMs - 1), "response.status", `value-${scenario.ordinal}-status-400`, 400, API(21)),
      ], "server", "unset"),
      span(placeSpanId, NODE.place, "OrderService.placeOrder", rootSpanId, time(2), time(11), [], "internal", "error"),
      span(variantSpanId(scenario.ordinal, 3), NODE.validate, "validateOrderRequest", placeSpanId, time(4), time(10), validationEvents, "internal", "error"),
      span(variantSpanId(scenario.ordinal, 4), NODE.errorResponse, "OrderRoutes.toErrorResponse", rootSpanId, time(14), time(19), [
        branch(eventId("validation-error"), time(15), "route:error-type", "then", "error instanceof ValidationError", true, API(41), "error.type", "ValidationError"),
      ]),
    ],
  };
}

/** The nested validator is sequential: later checks are reachable only after the earlier implicit
 * else paths. Emit that full observed prefix so expanding `assertLineIsSane` can reconstruct the
 * same path instead of showing only the final failing condition in isolation. */
function lineValidationFailureEvents(
  scenario: ValidationFailureScenario,
  eventId: (name: string) => string,
  time: (offsetMs: number) => string,
): BranchTakenEvent[] {
  const events: BranchTakenEvent[] = [];
  const skuFailed = scenario.siteId === "validate:sku";
  events.push(branch(
    eventId("line-sku"),
    time(8),
    "validate:sku",
    skuFailed ? "then" : "else",
    "!sku",
    skuFailed,
    VALIDATION(21),
    "line.sku.present",
    !skuFailed,
  ));
  if (skuFailed) return events;

  const quantityFailed = scenario.siteId === "validate:quantity";
  events.push(branch(
    eventId("line-quantity"),
    time(8),
    "validate:quantity",
    quantityFailed ? "then" : "else",
    "quantity <= 0",
    quantityFailed,
    VALIDATION(24),
    "line.quantity",
    quantityFailed ? 0 : 1,
  ));
  if (quantityFailed) return events;

  events.push(branch(
    eventId("line-price"),
    time(8),
    "validate:price",
    "then",
    "unitPriceCents < 0",
    true,
    VALIDATION(scenario.branchLine),
    "line.unitPriceCents",
    -1,
  ));
  return events;
}

function internalFailureTrace(): RequestTrace {
  const ordinal = 13;
  const rootSpanId = variantSpanId(ordinal, 1);
  const placeSpanId = variantSpanId(ordinal, 2);
  const start = variantStart(ordinal);
  const time = (offsetMs: number): string => nanoAt(start, offsetMs);
  const eventId = (name: string): string => variantEventId(ordinal, name);
  const valueId = (name: string): string => `value-${ordinal}-${name}`;

  return {
    traceId: variantTraceId(ordinal),
    name: "POST /orders — repository timeout",
    rootSpanId,
    startedAtUnixNano: time(0),
    endedAtUnixNano: time(45),
    status: "error",
    attributes: {
      "http.request.method": "POST",
      "http.route": "/orders",
      "http.response.status_code": 500,
      "order.customer.segment": "returning",
      "order.lines.count": 2,
      "order.quantity.total": 3,
      "order.discount.code": "none",
    },
    completeness: { ...COMPLETE },
    spans: [
      span(rootSpanId, NODE.root, "OrderRoutes.handleCreateOrder", undefined, time(0), time(45), [
        observed(eventId("request-segment"), time(1), "request.customer.segment", valueId("customer-segment"), "returning", API(15)),
        branch(eventId("catch"), time(33), "route:create:try", "catch", "catch (error)", "RepositoryTimeout", API(20), "error.type", "RepositoryTimeout"),
        exception(eventId("handled"), time(34), true, API(20), "repository timed out while saving the order", "RepositoryTimeout"),
        observed(eventId("response"), time(44), "response.status", valueId("status-500"), 500, API(21)),
      ], "server", "error"),
      span(placeSpanId, NODE.place, "OrderService.placeOrder", rootSpanId, time(2), time(32), [], "internal", "error"),
      span(variantSpanId(ordinal, 3), NODE.validate, "validateOrderRequest", placeSpanId, time(4), time(10), [
        branch(eventId("customer"), time(5), "validate:customer", "else", "!request.customerId", false, VALIDATION(8), "customer.present", true),
        branch(eventId("lines"), time(6), "validate:lines", "else", "request.lines.length === 0", false, VALIDATION(11), "request.lines.count", 2),
        {
          type: "loop.summary",
          eventId: eventId("lines-loop"),
          timeUnixNano: time(8),
          attributes: {},
          siteId: "validate:line-loop",
          label: "for request.lines",
          iterations: 2,
          emittedIterations: 2,
          truncated: false,
          source: VALIDATION(14),
        },
      ]),
      span(variantSpanId(ordinal, 4), NODE.price, "PricingService.price", placeSpanId, time(12), time(20), [
        branch(eventId("discount"), time(14), "price:discount", "then", "!code || !isKnownCode(code)", true, PRICING(28), "request.discountCode", "none"),
        observed(eventId("subtotal"), time(15), "money.subtotalCents", valueId("subtotal"), 5_000, PRICING(8)),
        observed(eventId("discount-value"), time(16), "money.discountCents", valueId("discount"), 0, PRICING(9), undefined, [valueId("subtotal")]),
        observed(eventId("tax"), time(18), "money.taxCents", valueId("tax"), 1_000, PRICING(13), undefined, [valueId("subtotal"), valueId("discount")]),
        observed(eventId("total"), time(19), "money.totalCents", valueId("total"), 6_000, PRICING(15), undefined, [valueId("subtotal"), valueId("discount"), valueId("tax")]),
      ]),
      span(variantSpanId(ordinal, 5), NODE.assemble, "OrderService.assemble", placeSpanId, time(21), time(27), [
        observed(eventId("order"), time(26), "order", valueId("order"), "Order", { file: "src/services/orderService.ts", line: 36 }, undefined, [valueId("total")]),
      ]),
      span(variantSpanId(ordinal, 6), NODE.save, "OrderRepository.save", placeSpanId, time(29), time(31), [
        observed(eventId("save-order"), time(29), "argument.order", valueId("order"), "Order", { file: "src/repository/orderRepository.ts", line: 8 }, undefined, [valueId("order")]),
        exception(eventId("repository-timeout"), time(30), false, { file: "src/repository/orderRepository.ts", line: 10 }, "repository timed out while saving the order", "RepositoryTimeout"),
      ], "internal", "error"),
      span(variantSpanId(ordinal, 7), NODE.errorResponse, "OrderRoutes.toErrorResponse", rootSpanId, time(35), time(41), [
        branch(eventId("validation-error"), time(36), "route:error-type", "else", "error instanceof ValidationError", false, API(41), "error.type", "RepositoryTimeout"),
      ]),
    ],
  };
}

function variantTraceId(ordinal: number): string {
  return ordinal.toString(16).padStart(32, "0");
}

function variantSpanId(ordinal: number, position: number): string {
  return ((BigInt(ordinal) << 48n) + BigInt(position)).toString(16).padStart(16, "0");
}

function variantEventId(ordinal: number, name: string): string {
  return `v${ordinal.toString(16).padStart(2, "0")}-${name}`;
}

function variantStart(ordinal: number): bigint {
  return TRACE_EPOCH_NANO + BigInt(ordinal - 1) * 1_000_000_000n;
}

function nanoAt(start: bigint, offsetMs: number): string {
  return (start + BigInt(offsetMs) * 1_000_000n).toString();
}

function span(spanId: string, nodeId: string, name: string, parentSpanId: string | undefined, startedAtUnixNano: string, endedAtUnixNano: string, events: TimelineEvent[] = [], kind: TimelineSpan["kind"] = "internal", status: TimelineSpan["status"] = "ok"): TimelineSpan {
  return { spanId, ...(parentSpanId ? { parentSpanId } : {}), nodeId, name, kind, startedAtUnixNano, endedAtUnixNano, status, attributes: { "meridian.node.id": nodeId }, events };
}

function branch(eventId: string, timeUnixNano: string, siteId: string, pathId: string, condition: string, outcome: TraceAttributeScalar, source: TraceSource, valueName?: string, value?: BranchTakenEvent["value"]): BranchTakenEvent {
  return { type: "branch.taken", eventId, timeUnixNano, attributes: {}, siteId, pathId, condition, outcome, source, ...(valueName === undefined ? {} : { valueName }), ...(value === undefined ? {} : { value }) };
}

function observed(eventId: string, timeUnixNano: string, name: string, valueId: string, value: DataObserveEvent["value"], source: TraceSource, siteId?: string, derivedFrom?: string[], attributes: DataObserveEvent["attributes"] = {}): DataObserveEvent {
  return { type: "data.observe", eventId, timeUnixNano, attributes, name, valueId, value, source, ...(siteId ? { siteId } : {}), ...(derivedFrom ? { derivedFrom } : {}) };
}

function exception(eventId: string, timeUnixNano: string, handled: boolean, source: TraceSource, message = "order is missing a customer", exceptionType = "ValidationError"): ExceptionTimelineEvent {
  return { type: "exception", eventId, timeUnixNano, attributes: {}, exceptionType, message, handled, source };
}

function retainKnownSpans(trace: RequestTrace, knownNodes: ReadonlySet<string>): RequestTrace {
  return { ...trace, spans: trace.spans.map((span) => retainRuntimeSpan(span, knownNodes)) };
}

function retainRuntimeSpan(span: TimelineSpan, knownNodes: ReadonlySet<string>): TimelineSpan {
  if (!span.nodeId || knownNodes.has(span.nodeId)) return span;
  const nodeId = span.nodeId;
  const { ["meridian.node.id"]: _mappedNodeId, ...attributes } = span.attributes;
  return { ...span, nodeId: undefined, attributes: { ...attributes, "meridian.unmapped.node.id": nodeId } };
}
