import { describe, expect, expectTypeOf, it } from "vitest";
import {
  RELATION_CATALOG,
  RELATION_FAMILIES,
  RELATION_KIND_ORDER,
  RELATION_STYLE_TOKENS,
  defineRelationCatalog,
  isRelationKind,
  relationKindsForFamily,
  relationSpec,
} from "./relationCatalog";
import type { RelationKind } from "./relationCatalog";

describe("RELATION_CATALOG", () => {
  it("covers every built-in kind exactly once in stable display order", () => {
    expect(Object.keys(RELATION_CATALOG)).toEqual(RELATION_KIND_ORDER);
    expect(RELATION_KIND_ORDER).toHaveLength(16);
  });

  it("classifies composition without confusing construction with ownership", () => {
    expect(relationKindsForFamily("composition")).toEqual([
      "registers",
      "binds",
      "provides",
      "injects",
      "owns",
      "aliases",
    ]);
    expect(RELATION_CATALOG.instantiates).toEqual({
      label: "Instantiates",
      family: "construction",
      styleToken: "construction",
    });
  });

  it("keeps structural, behavioral, dependency, messaging, and UI families distinct", () => {
    expect(relationKindsForFamily("inheritance")).toEqual(["extends", "implements"]);
    expect(relationKindsForFamily("behavior")).toEqual(["calls"]);
    expect(relationKindsForFamily("dependency")).toEqual(["references", "imports"]);
    expect(relationKindsForFamily("messaging")).toEqual(["sends", "handles", "ipc"]);
    expect(relationKindsForFamily("ui")).toEqual(["renders"]);
  });

  it("assigns every kind a declared family and semantic style token", () => {
    for (const kind of RELATION_KIND_ORDER) {
      const spec = RELATION_CATALOG[kind];
      expect(RELATION_FAMILIES).toContain(spec.family);
      expect(RELATION_STYLE_TOKENS).toContain(spec.styleToken);
      expect(spec.label).not.toBe("");
    }
  });

  it("shares a style token where different exact kinds have the same visual role", () => {
    expect(RELATION_CATALOG.registers.styleToken).toBe("composition");
    expect(RELATION_CATALOG.injects.styleToken).toBe("composition");
    expect(RELATION_CATALOG.sends.styleToken).toBe("ipc");
    expect(RELATION_CATALOG.handles.styleToken).toBe("ipc");
  });
});

describe("relation catalog API", () => {
  it("narrows built-ins while tolerating an open artifact vocabulary", () => {
    const input: string = "calls";
    if (isRelationKind(input)) {
      expectTypeOf(input).toEqualTypeOf<RelationKind>();
    }
    expect(relationSpec(input)).toBe(RELATION_CATALOG.calls);
    expect(isRelationKind("custom-relation")).toBe(false);
    expect(relationSpec("custom-relation")).toBeUndefined();
  });

  it("lets a lens define extra kinds without weakening family or style-token types", () => {
    const catalog = defineRelationCatalog({
      subscribes: { label: "Subscribes", family: "messaging", styleToken: "ipc" },
    });

    expect(catalog.subscribes).toEqual({ label: "Subscribes", family: "messaging", styleToken: "ipc" });
    expectTypeOf<keyof typeof catalog>().toEqualTypeOf<"subscribes">();
  });
});
