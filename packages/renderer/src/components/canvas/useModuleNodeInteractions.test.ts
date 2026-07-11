import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import {
  ghostGroupInteractionOf,
  shouldToggleGhostGroupClick,
  toggleExpandedGhostGroupIds,
} from "./useModuleNodeInteractions";

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({
  id,
  type,
  data,
  position: { x: 0, y: 0 },
});

describe("persistent ghost-group interaction helpers", () => {
  it("recognizes a real parent anchor and its disclosure state", () => {
    const parent = node("ts:AuthSession", "ghost", {
      ghostGroupId: "ts:AuthSession",
      ghostExpanded: true,
    });

    expect(ghostGroupInteractionOf(parent)).toEqual({ id: "ts:AuthSession", expanded: true });
    expect(ghostGroupInteractionOf(node("ts:AuthSession.signIn", "ghost"))).toBeNull();
    expect(ghostGroupInteractionOf(node("ts:AuthSession", "unit", { ghostGroupId: "ts:AuthSession" }))).toBeNull();
  });

  it("opens and closes the same stable parent id", () => {
    const opened = toggleExpandedGhostGroupIds(new Set(), "ts:AuthSession");
    expect([...opened]).toEqual(["ts:AuthSession"]);
    expect([...toggleExpandedGhostGroupIds(opened, "ts:AuthSession")]).toEqual([]);
  });

  it("handles a single/keyboard click but ignores the second constituent click of a double-click", () => {
    expect(shouldToggleGhostGroupClick(0)).toBe(true);
    expect(shouldToggleGhostGroupClick(1)).toBe(true);
    expect(shouldToggleGhostGroupClick(2)).toBe(false);
  });
});
