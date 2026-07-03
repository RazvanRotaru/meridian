/**
 * Regression: a parentId cycle (tolerated by the lenient viewer) must not hang the lift walk.
 * If liftEndpoint lacked its visited guard this test would time out rather than fail fast.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge } from "@meridian/core";
import { liftEdges } from "./liftEdges";

function callsEdge(source: string, target: string): GraphEdge {
  return { id: `calls@${source}|${target}`, source, target, kind: "calls", weight: 1 };
}

describe("liftEdges cycle safety", () => {
  it("terminates on a parentId cycle instead of spinning forever", () => {
    const parentOf = new Map<string, string | null>([
      ["ts:a", "ts:b"],
      ["ts:b", "ts:a"],
      ["ts:root", null],
    ]);
    const visible = new Set(["ts:root"]);
    const edges = [callsEdge("ts:a", "ts:root")];
    // Source "ts:a" can never reach a visible ancestor, so the edge drops — but it MUST return.
    expect(liftEdges(edges, visible, parentOf)).toEqual([]);
  });
});
