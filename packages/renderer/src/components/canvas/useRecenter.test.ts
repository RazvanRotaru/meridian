import { describe, expect, it } from "vitest";
import { resolveRecenterNodes, shouldApplyRecenter } from "./useRecenter";

describe("shouldApplyRecenter", () => {
  it("ignores mount and cover/reveal changes while the signal is unchanged", () => {
    expect(shouldApplyRecenter(4, 4, true)).toBe(false);
    expect(shouldApplyRecenter(4, 4, false)).toBe(false);
  });

  it("runs only a new signal on the active surface", () => {
    expect(shouldApplyRecenter(4, 5, true)).toBe(true);
    expect(shouldApplyRecenter(4, 5, false)).toBe(false);
  });
});

describe("resolveRecenterNodes", () => {
  const present = new Set(["selected", "target"]);
  const hasNode = (id: string) => present.has(id);

  it("fits only an explicit target, independently of the current selection", () => {
    expect(resolveRecenterNodes("target", ["selected"], hasNode)).toEqual([{ id: "target" }]);
  });

  it("cancels an explicit request whose target is no longer rendered", () => {
    expect(resolveRecenterNodes("missing", ["selected"], hasNode)).toBeNull();
  });

  it("keeps normal recenter's present-selection and whole-graph fallbacks", () => {
    expect(resolveRecenterNodes(null, ["missing", "selected"], hasNode)).toEqual([{ id: "selected" }]);
    expect(resolveRecenterNodes(null, ["missing"], hasNode)).toBeUndefined();
    expect(resolveRecenterNodes(null, [], hasNode)).toBeUndefined();
  });
});
