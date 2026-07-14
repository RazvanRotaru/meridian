import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ObservedRequestRoute } from "../../derive/requestObservedRoute";
import { ObservedRouteStrip } from "./ObservedRouteStrip";

describe("ObservedRouteStrip", () => {
  it("renders the ordered call route and its exact captured decisions", () => {
    const markup = renderToStaticMarkup(
      <ObservedRouteStrip route={route()} labelForNode={(id) => id === "validate" ? "validateOrderRequest" : undefined} />,
    );

    expect(markup).toContain("OBSERVED ROUTE");
    expect(markup).toContain('<ol');
    expect(markup).toContain('aria-label="Observed request route"');
    expect(markup.indexOf("placeOrder")).toBeLessThan(markup.indexOf("validateOrderRequest"));
    expect(markup.indexOf("validateOrderRequest")).toBeLessThan(markup.indexOf("handleCreateOrder"));
    expect(markup).toContain("else");
    expect(markup).toContain("customer.present = true");
    expect(markup).toContain("catch");
    expect(markup).toContain("RepositoryTimeout");
    expect(markup).toContain("↪");
    expect(markup).toContain('aria-hidden="true"');
  });

  it("marks incomplete evidence as partial and hides an empty route", () => {
    expect(renderToStaticMarkup(<ObservedRouteStrip route={{ ...route(), complete: false }} />)).toContain("PARTIAL");
    expect(renderToStaticMarkup(<ObservedRouteStrip route={{ runs: [], observationCount: 0, complete: true }} />)).toBe("");
  });
});

function route(): ObservedRequestRoute {
  return {
    complete: true,
    observationCount: 2,
    runs: [{
      key: "place:start",
      spanId: "place",
      nodeId: "place",
      spanName: "OrderService.placeOrder",
      relation: "entry",
      observations: [],
    }, {
      key: "validate:start",
      spanId: "validate",
      nodeId: "validate",
      spanName: "validateOrderRequest",
      relation: "call",
      observations: [{
        key: "validate:event",
        kind: "branch",
        outcome: "else",
        evidence: "customer.present = true",
        detail: "!request.customerId → else · customer.present = true · src/validation/orderValidator.ts:8",
        tone: "observed",
      }],
    }, {
      key: "root:catch",
      spanId: "root",
      nodeId: "root",
      spanName: "OrderRoutes.handleCreateOrder",
      relation: "catch",
      observations: [{
        key: "root:event",
        kind: "branch",
        outcome: "catch",
        evidence: "error.type = RepositoryTimeout",
        detail: "catch (error) → catch · error.type = RepositoryTimeout · src/api/orderRoutes.ts:20",
        tone: "caught",
      }],
    }],
  };
}
