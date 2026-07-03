/**
 * View-mode edge filtering: the "separate viewers". Call-flow keeps the behavioural graph and
 * drops the React composition wires; UI-composition keeps ONLY them. Hand-built edges (not a
 * real artifact) so the rule is pinned independently of any extractor's output.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge } from "@meridian/core";
import { selectEdgesForMode } from "./edgeSelection";

function edge(kind: string): GraphEdge {
  return { id: `${kind}@a|b`, source: "a", target: "b", kind };
}

// One of every well-known kind, including the composition kind and an off-whitelist "imports".
const MIXED: GraphEdge[] = [
  edge("calls"),
  edge("instantiates"),
  edge("extends"),
  edge("implements"),
  edge("references"),
  edge("renders"),
  edge("imports"),
];

describe("selectEdgesForMode", () => {
  it("'call' keeps the behavioural kinds and EXCLUDES renders", () => {
    const kinds = selectEdgesForMode(MIXED, "call").map((e) => e.kind);
    expect(kinds).toEqual(["calls", "instantiates", "extends", "implements", "references"]);
    expect(kinds).not.toContain("renders");
  });

  it("'ui' keeps ONLY renders", () => {
    const selected = selectEdgesForMode(MIXED, "ui");
    expect(selected.map((e) => e.kind)).toEqual(["renders"]);
  });

  it("returns an empty list when a mode's kinds are absent", () => {
    expect(selectEdgesForMode([edge("imports")], "ui")).toEqual([]);
    expect(selectEdgesForMode([edge("renders")], "call")).toEqual([]);
  });
});
