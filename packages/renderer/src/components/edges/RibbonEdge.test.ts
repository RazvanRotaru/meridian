import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import { ribbonCrossesBoundary } from "./RibbonEdge";

const member = (id: string, data: Record<string, unknown>): Edge => ({ id, source: "a", target: "b", data });

describe("ribbonCrossesBoundary", () => {
  it.each(["crossPackage", "outsideView"] as const)("dashes the whole cable when any strand carries %s", (flag) => {
    expect(ribbonCrossesBoundary([member("solid", {}), member("boundary", { [flag]: true })])).toBe(true);
  });

  it("does not treat the legacy/geometric crossFrame signal as dash semantics", () => {
    expect(ribbonCrossesBoundary([member("grouped", { crossFrame: true })])).toBe(false);
  });
});
