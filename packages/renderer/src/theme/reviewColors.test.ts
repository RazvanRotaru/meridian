/**
 * The change-status palette mapping: every status resolves to its diff-conventional stroke + label,
 * and the "added" green stays distinct from the reviewed-tick green so a lit tick never reads as new.
 */

import { describe, expect, it } from "vitest";
import { changeStatusColor, REVIEW_COLORS } from "./reviewColors";
import type { ChangeStatus } from "../derive/changeStatus";

describe("changeStatusColor", () => {
  it("maps each status to its diff-conventional stroke and lowercase label", () => {
    expect(changeStatusColor("added")).toMatchObject({ stroke: "#3FB950", label: "added" });
    expect(changeStatusColor("modified")).toMatchObject({ stroke: "#D29922", label: "modified" });
    expect(changeStatusColor("removed")).toMatchObject({ stroke: "#F85149", label: "removed" });
    expect(changeStatusColor("renamed")).toMatchObject({ stroke: "#A371F7", label: "renamed" });
  });

  it("returns a matching tint fill for every status", () => {
    const statuses: ChangeStatus[] = ["added", "modified", "removed", "renamed"];
    for (const status of statuses) {
      expect(changeStatusColor(status).fill).toMatch(/^rgba\(/);
    }
  });

  it("keeps the added green distinct from the reviewed-tick green", () => {
    expect(changeStatusColor("added").stroke).not.toBe(REVIEW_COLORS.reviewed);
    expect(changeStatusColor("added").stroke).not.toBe(REVIEW_COLORS.selection);
  });
});
