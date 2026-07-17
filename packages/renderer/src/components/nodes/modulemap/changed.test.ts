import { describe, expect, it } from "vitest";
import { borderFor, type NodeDiff } from "./changed";

describe("changed node visual ownership", () => {
  it("keeps a selected base-only deleted node red with a separate neutral selection halo", () => {
    const base: React.CSSProperties = {
      border: "1px solid #3FB7C455",
      background: "#111820",
    };
    const selected: React.CSSProperties = {
      ...base,
      border: "2px solid #3FB7C4",
      boxShadow: "0 0 0 2px #DCE6F2",
    };
    const deleted: NodeDiff = {
      changed: true,
      inside: 0,
      status: "deleted",
      hasDiff: true,
    };

    expect(borderFor(base, selected, true, deleted)).toMatchObject({
      border: "1px solid #3FB7C455",
      borderColor: "#E5484D",
      backgroundImage: "linear-gradient(0deg, #E5484D2E, #E5484D2E)",
      boxShadow: "0 0 0 1px #E5484D66, 0 0 0 2px #DCE6F2",
    });
  });

  it("keeps ordinary selected and resting nodes on their existing styles", () => {
    const base: React.CSSProperties = { borderColor: "#303B48" };
    const selected: React.CSSProperties = { borderColor: "#3FB7C4", boxShadow: "0 0 0 2px #DCE6F2" };
    const unchanged: NodeDiff = { changed: false, inside: 0, hasDiff: false };

    expect(borderFor(base, selected, true, unchanged)).toBe(selected);
    expect(borderFor(base, selected, false, unchanged)).toBe(base);
  });
});
