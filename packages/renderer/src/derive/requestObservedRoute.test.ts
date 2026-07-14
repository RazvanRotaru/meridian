import { describe, expect, it } from "vitest";
import type { RequestTrace, TimelineEvent, TimelineSpan } from "@meridian/core";
import { deriveObservedRequestRoute } from "./requestObservedRoute";

const ROOT = "ts:src/api/orderRoutes.ts#OrderRoutes.handleCreateOrder";
const PLACE = "ts:src/services/orderService.ts#OrderService.placeOrder";
const VALIDATE = "ts:src/validation/orderValidator.ts#validateOrderRequest";
const PRICE = "ts:src/pricing/pricingService.ts#PricingService.price";
const ASSEMBLE = "ts:src/services/orderService.ts#OrderService.assemble";
const SAVE = "ts:src/repository/orderRepository.ts#OrderRepository.save";
const ERROR_RESPONSE = "ts:src/api/orderRoutes.ts#OrderRoutes.toErrorResponse";

describe("deriveObservedRequestRoute", () => {
  it("reconstructs the timeout request as call runs, concrete decisions, and a parent catch resume", () => {
    const route = deriveObservedRequestRoute(timeoutTrace());

    expect(route.complete).toBe(true);
    expect(route.observationCount).toBe(8);
    expect(route.runs.map((run) => [
      run.spanName,
      run.relation,
      run.observations.map((observation) => [observation.outcome, observation.evidence]),
    ])).toEqual([
      ["OrderRoutes.handleCreateOrder", "entry", []],
      ["OrderService.placeOrder", "call", []],
      ["validateOrderRequest", "call", [
        ["else", "customer.present = true"],
        ["else", "request.lines.count = 2"],
        ["loop ×2", "for request.lines"],
      ]],
      ["PricingService.price", "next", [["then", "request.discountCode = none"]]],
      ["OrderService.assemble", "next", []],
      ["OrderRepository.save", "next", [["threw", "RepositoryTimeout"]]],
      ["OrderRoutes.handleCreateOrder", "catch", [
        ["catch", "error.type = RepositoryTimeout"],
        ["caught", "RepositoryTimeout"],
      ]],
      ["OrderRoutes.toErrorResponse", "call", [["else", "error.type = RepositoryTimeout"]]],
    ]);
  });

  it("is deterministic when producers reverse span and per-span event arrays", () => {
    const request = timeoutTrace();
    const reversed = {
      ...request,
      spans: [...request.spans].reverse().map((span) => ({ ...span, events: [...span.events].reverse() })),
    };

    expect(deriveObservedRequestRoute(reversed)).toEqual(deriveObservedRequestRoute(request));
  });

  it("retains false, zero, and empty-string branch values instead of falling back to outcomes", () => {
    const route = deriveObservedRequestRoute(trace([
      span("root", "run", undefined, 0, 10, [
        branch("a", 1, "else", "a", false, "flag", false),
        branch("b", 2, "else", "b", false, "count", 0),
        branch("c", 3, "else", "c", false, "text", ""),
        branch("d", 4, "then", "d", true),
      ]),
    ]));

    expect(route.runs[0]?.observations.map((observation) => observation.evidence)).toEqual([
      "flag = false",
      "count = 0",
      "text = ",
      "outcome = true",
    ]);
  });

  it("ignores data observations and async handoffs without inventing decisions", () => {
    const events: TimelineEvent[] = [{
      type: "data.observe",
      eventId: "data",
      timeUnixNano: time(1),
      attributes: {},
      name: "total",
      valueId: "total-1",
      value: 42,
    }, {
      type: "async.handoff",
      eventId: "async",
      timeUnixNano: time(2),
      attributes: {},
      mode: "awaited",
      siteId: "site:async",
      source: { file: "src/run.ts", line: 2 },
    }];
    const route = deriveObservedRequestRoute(trace([span("root", "run", undefined, 0, 10, events)], false));

    expect(route.runs).toHaveLength(1);
    expect(route.runs[0]?.observations).toEqual([]);
    expect(route.observationCount).toBe(0);
    expect(route.complete).toBe(false);
  });

  it("keeps tied events stable by event id and preserves truncated loop evidence", () => {
    const route = deriveObservedRequestRoute(trace([
      span("root", "run", undefined, 0, 10, [
        exception("z", 3, false, "Boom"),
        {
          type: "loop.summary",
          eventId: "a",
          timeUnixNano: time(3),
          attributes: {},
          siteId: "site:loop",
          label: "for items",
          iterations: 20,
          emittedIterations: 3,
          truncated: true,
          source: { file: "src/run.ts", line: 3 },
        },
      ]),
    ]));

    expect(route.runs[0]?.observations.map((observation) => observation.outcome)).toEqual(["loop ×20", "threw"]);
    expect(route.runs[0]?.observations[0]?.detail).toContain("3/20 captured · truncated");
  });

  it("does not imply sequential causality between overlapping sibling spans", () => {
    const route = deriveObservedRequestRoute(trace([
      span("root", "root", undefined, 0, 20, []),
      span("child-a", "childA", "root", 1, 12, []),
      span("child-b", "childB", "root", 5, 10, []),
    ]));

    expect(route.runs.map((run) => run.relation)).toEqual(["entry", "call", "separate"]);
  });

  it("keeps equal-time parents before children even when the child id sorts first", () => {
    const route = deriveObservedRequestRoute(trace([
      span("z-parent", "parent", undefined, 0, 20, []),
      span("a-child", "child", "z-parent", 0, 10, []),
    ]));

    expect(route.runs.map((run) => [run.spanName, run.relation])).toEqual([
      ["parent", "entry"],
      ["child", "call"],
    ]);
  });

  it("does not label a parent event as a resume while the preceding child is still running", () => {
    const route = deriveObservedRequestRoute(trace([
      span("root", "root", undefined, 0, 20, [branch("catch", 5, "catch", "catch (error)", "Boom")]),
      span("child", "child", "root", 1, 10, []),
    ]));

    expect(route.runs.map((run) => [run.spanName, run.relation])).toEqual([
      ["root", "entry"],
      ["child", "call"],
      ["root", "separate"],
    ]);
  });
});

function timeoutTrace(): RequestTrace {
  const root = "000d000000000001";
  const place = "000d000000000002";
  return trace([
    span(root, "OrderRoutes.handleCreateOrder", undefined, 0, 45, [
      branch("catch", 33, "catch", "catch (error)", "RepositoryTimeout", "error.type", "RepositoryTimeout"),
      exception("handled", 34, true, "RepositoryTimeout"),
    ], ROOT, "error"),
    span(place, "OrderService.placeOrder", root, 2, 32, [], PLACE, "error"),
    span("000d000000000003", "validateOrderRequest", place, 4, 10, [
      branch("customer", 5, "else", "!request.customerId", false, "customer.present", true),
      branch("lines", 6, "else", "request.lines.length === 0", false, "request.lines.count", 2),
      {
        type: "loop.summary",
        eventId: "lines-loop",
        timeUnixNano: time(8),
        attributes: {},
        siteId: "validate:line-loop",
        label: "for request.lines",
        iterations: 2,
        emittedIterations: 2,
        truncated: false,
        source: { file: "src/validation/orderValidator.ts", line: 14 },
      },
    ], VALIDATE),
    span("000d000000000004", "PricingService.price", place, 12, 20, [
      branch("discount", 14, "then", "!code || !isKnownCode(code)", true, "request.discountCode", "none"),
    ], PRICE),
    span("000d000000000005", "OrderService.assemble", place, 21, 27, [], ASSEMBLE),
    span("000d000000000006", "OrderRepository.save", place, 29, 31, [
      exception("repository-timeout", 30, false, "RepositoryTimeout"),
    ], SAVE, "error"),
    span("000d000000000007", "OrderRoutes.toErrorResponse", root, 35, 41, [
      branch("validation-error", 36, "else", "error instanceof ValidationError", false, "error.type", "RepositoryTimeout"),
    ], ERROR_RESPONSE),
  ], true, "POST /orders — repository timeout");
}

function trace(spans: TimelineSpan[], complete = true, name = "request"): RequestTrace {
  return {
    traceId: "0000000000000000000000000000000d",
    name,
    rootSpanId: spans[0]?.spanId ?? "000d000000000001",
    startedAtUnixNano: time(0),
    endedAtUnixNano: time(50),
    status: "error",
    attributes: {},
    spans,
    completeness: { complete, droppedSpans: complete ? 0 : 1, droppedEvents: 0, droppedValues: 0 },
  };
}

function span(
  spanId: string,
  name: string,
  parentSpanId: string | undefined,
  startMs: number,
  endMs: number,
  events: TimelineEvent[],
  nodeId?: string,
  status: TimelineSpan["status"] = "ok",
): TimelineSpan {
  return {
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    ...(nodeId === undefined ? {} : { nodeId }),
    name,
    kind: parentSpanId === undefined ? "server" : "internal",
    startedAtUnixNano: time(startMs),
    endedAtUnixNano: time(endMs),
    status,
    attributes: {},
    events,
  };
}

function branch(
  eventId: string,
  atMs: number,
  pathId: string,
  condition: string,
  outcome: boolean | number | string,
  valueName?: string,
  value?: boolean | number | string,
): TimelineEvent {
  return {
    type: "branch.taken",
    eventId,
    timeUnixNano: time(atMs),
    attributes: {},
    siteId: `site:${eventId}`,
    pathId,
    condition,
    outcome,
    source: { file: "src/run.ts", line: atMs },
    ...(valueName === undefined ? {} : { valueName }),
    ...(value === undefined ? {} : { value }),
  };
}

function exception(eventId: string, atMs: number, handled: boolean, exceptionType: string): TimelineEvent {
  return {
    type: "exception",
    eventId,
    timeUnixNano: time(atMs),
    attributes: {},
    handled,
    exceptionType,
    message: "repository timed out while saving the order",
    source: { file: "src/run.ts", line: atMs },
  };
}

function time(offsetMs: number): string {
  return (1_767_225_600_000_000_000n + BigInt(offsetMs) * 1_000_000n).toString();
}
