import { describe, expect, it } from "vitest";
import { relationKindOf, withRelationKind } from "./relationEdge";

describe("relationKindOf", () => {
  it("prefers the canonical kind and accepts legacy dependency/category payloads", () => {
    expect(relationKindOf({ relationKind: "registers", depKind: "calls" })).toBe("registers");
    expect(relationKindOf({ depKind: "implements", category: "dep" })).toBe("implements");
    expect(relationKindOf({ category: "import" })).toBe("imports");
    expect(relationKindOf({ category: "ipc" })).toBe("ipc");
  });

  it("never treats a kindless dependency or flow edge as a call", () => {
    expect(relationKindOf({ category: "dep" })).toBeNull();
    expect(relationKindOf({ category: "flow" })).toBeNull();
  });

  it("writes canonical and compatibility fields together", () => {
    expect(withRelationKind({ category: "dep" }, "injects")).toEqual({
      category: "dep",
      relationKind: "injects",
      depKind: "injects",
    });
  });
});
