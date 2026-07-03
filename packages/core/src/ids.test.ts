import { describe, expect, it } from "vitest";
import { buildNodeId, collapseLocals, normalizeScopeSeparators, parseNodeId } from "./ids";

describe("node-id grammar", () => {
  it("round-trips a module id with no qualname", () => {
    const id = buildNodeId({ lang: "ts", modulePath: "src/services/orderService.ts" });
    expect(id).toBe("ts:src/services/orderService.ts");
    expect(parseNodeId(id)).toEqual({ lang: "ts", modulePath: "src/services/orderService.ts" });
  });

  it("round-trips a method id with a qualname", () => {
    const id = buildNodeId({ lang: "ts", modulePath: "src/a.ts", qualname: "OrderService.placeOrder" });
    expect(id).toBe("ts:src/a.ts#OrderService.placeOrder");
    expect(parseNodeId(id)).toEqual({ lang: "ts", modulePath: "src/a.ts", qualname: "OrderService.placeOrder" });
  });

  it("round-trips a disambiguating ordinal", () => {
    const id = buildNodeId({ lang: "ts", modulePath: "src/a.ts", qualname: "overloaded", ordinal: 2 });
    expect(id).toBe("ts:src/a.ts#overloaded~2");
    expect(parseNodeId(id)).toEqual({ lang: "ts", modulePath: "src/a.ts", qualname: "overloaded", ordinal: 2 });
  });

  it("parses an external pseudo-id used as an edge target", () => {
    expect(parseNodeId("ext:typescript/lib.es5.d.ts#Error")).toEqual({
      lang: "ext",
      modulePath: "typescript/lib.es5.d.ts",
      qualname: "Error",
    });
  });

  it("normalizes native scope separators to dots", () => {
    expect(normalizeScopeSeparators("Foo::bar#baz$qux")).toBe("Foo.bar.baz.qux");
  });

  it("collapses python <locals> segments", () => {
    expect(collapseLocals("login.<locals>._helper")).toBe("login._helper");
  });
});
