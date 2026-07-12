import { describe, expect, it } from "vitest";
import { relationColor, withRelationLineStyle } from "./relationTheme";
import { REL_COLORS } from "./mapPalette";
import { BOUNDARY_DASH_PATTERN } from "../layout/edgeBoundary";

describe("relation theme", () => {
  it("realizes catalog roles while preserving exact inheritance colours", () => {
    expect(relationColor("registers")).toBe(relationColor("binds"));
    expect(relationColor("extends")).toBe(REL_COLORS.extends);
    expect(relationColor("implements")).toBe(REL_COLORS.implements);
    expect(relationColor("unknown-adapter-kind")).toBeNull();
  });

  it("uses a semantic inheritance dash unless the edge is a boundary", () => {
    expect(withRelationLineStyle({}, { relationKind: "extends" })).toMatchObject({ strokeDasharray: "3 3" });
    expect(withRelationLineStyle({ strokeDasharray: BOUNDARY_DASH_PATTERN }, { relationKind: "extends", outsideView: true }))
      .toMatchObject({ strokeDasharray: BOUNDARY_DASH_PATTERN });
  });
});
