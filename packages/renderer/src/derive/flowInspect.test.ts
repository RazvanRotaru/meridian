/**
 * Logic-flow inspection derivations. Fixtures are hand-built (a minimal GraphIndex shaped just
 * enough: outEdges + nodesById) so the rules — dedup, external tagging, recursive target
 * collection, ghost subtraction, containment reversal — are pinned independently of any extractor.
 */

import { describe, expect, it } from "vitest";
import type { EdgeResolution, GraphEdge, GraphNode, FlowStep, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { buildFlowContainmentIndex, calleesOf, flowCallTargets, ghostCallees, transitiveCallers } from "./flowInspect";

function node(id: string, kind: string, displayName: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName, location: { file: "f.ts", startLine: 1 } } as GraphNode;
}

function edge(source: string, target: string, resolution: GraphEdge["resolution"], kind = "calls"): GraphEdge {
  return { id: `${kind}@${source}|${target}`, source, target, kind, resolution };
}

/** A GraphIndex with only the maps the inspector reads; the rest is unused here. */
function fakeIndex(nodes: GraphNode[], edges: GraphEdge[]): GraphIndex {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const existing = outEdges.get(e.source);
    if (existing) {
      existing.push(e);
    } else {
      outEdges.set(e.source, [e]);
    }
  }
  return { nodesById, outEdges } as unknown as GraphIndex;
}

const call = (target: string | null, resolution: EdgeResolution, label = "c"): FlowStep =>
  ({ kind: "call", label, target, resolution });

describe("calleesOf", () => {
  it("dedups repeated targets, taking label/kind from the target node", () => {
    const index = fakeIndex(
      [node("ts:m#A", "function", "A"), node("ts:m#B", "method", "B")],
      [edge("ts:m#A", "ts:m#B", "resolved"), edge("ts:m#A", "ts:m#B", "resolved", "instantiates")],
    );
    const callees = calleesOf(index, "ts:m#A");
    expect(callees).toEqual([{ id: "ts:m#B", resolution: "resolved", kind: "method", label: "B" }]);
  });

  it("tags ext:/unresolved: pseudo-targets as external with a stripped label", () => {
    const index = fakeIndex(
      [node("ts:m#A", "function", "A")],
      [edge("ts:m#A", "ext:lib#Thing", "external"), edge("ts:m#A", "unresolved:?", "unresolved")],
    );
    expect(calleesOf(index, "ts:m#A")).toEqual([
      { id: "ext:lib#Thing", resolution: "external", kind: "external", label: "lib#Thing" },
      { id: "unresolved:?", resolution: "unresolved", kind: "external", label: "?" },
    ]);
  });

  it("falls back to the raw id when a resolved target node is missing", () => {
    const index = fakeIndex([], [edge("ts:m#A", "ts:m#Gone", "resolved")]);
    expect(calleesOf(index, "ts:m#A")).toEqual([
      { id: "ts:m#Gone", resolution: "resolved", kind: "calls", label: "ts:m#Gone" },
    ]);
  });

  it("returns empty for a node with no out-edges", () => {
    expect(calleesOf(fakeIndex([], []), "ts:m#nobody")).toEqual([]);
  });

  it("does not treat structural or resource relations as callees", () => {
    const index = fakeIndex(
      [node("ts:m#A", "function", "A"), node("promise:m#ready", "promise", "ready")],
      [
        edge("ts:m#A", "promise:m#ready", "resolved", "returnsPromise"),
        edge("ts:m#A", "ts:m#B", "resolved", "references"),
      ],
    );
    expect(calleesOf(index, "ts:m#A")).toEqual([]);
  });
});

describe("flowCallTargets", () => {
  it("recurses loop bodies and branch paths, ignoring unresolved and null targets", () => {
    const steps: FlowStep[] = [
      call("ts:m#A", "resolved"),
      call("ext:lib#X", "external"),
      call(null, "unresolved"),
      { kind: "loop", label: "for", body: [call("ts:m#B", "resolved")] },
      {
        kind: "branch",
        label: "if",
        paths: [
          { label: "then", body: [call("ts:m#C", "resolved")] },
          { label: "else", body: [call("ts:m#A", "resolved")] },
        ],
      },
    ];
    expect(flowCallTargets(steps)).toEqual(new Set(["ts:m#A", "ts:m#B", "ts:m#C"]));
  });

  it("returns empty for an empty flow", () => {
    expect(flowCallTargets([])).toEqual(new Set());
  });
});

describe("ghostCallees", () => {
  it("excludes in-flow targets and floats resolved callees ahead of external ones", () => {
    const index = fakeIndex(
      [node("ts:m#A", "function", "A"), node("ts:m#Seen", "function", "Seen"), node("ts:m#Hidden", "function", "Hidden")],
      [
        edge("ts:m#A", "ts:m#Seen", "resolved"),
        edge("ts:m#A", "ext:lib#Z", "external"),
        edge("ts:m#A", "ts:m#Hidden", "resolved"),
      ],
    );
    const ghosts = ghostCallees(index, "ts:m#A", new Set(["ts:m#Seen"]));
    expect(ghosts.map((g) => g.id)).toEqual(["ts:m#Hidden", "ext:lib#Z"]);
  });
});

describe("buildFlowContainmentIndex", () => {
  it("maps each resolved target to the sorted flow roots that call it", () => {
    const flows: LogicFlows = {
      "ts:m#rootB": [call("ts:m#shared", "resolved")],
      "ts:m#rootA": [
        { kind: "loop", label: "for", body: [call("ts:m#shared", "resolved")] },
        call("ts:m#only", "resolved"),
      ],
    };
    const containment = buildFlowContainmentIndex(flows);
    expect(containment.get("ts:m#shared")).toEqual(["ts:m#rootA", "ts:m#rootB"]);
    expect(containment.get("ts:m#only")).toEqual(["ts:m#rootA"]);
  });

  it("returns an empty map for no flows", () => {
    expect(buildFlowContainmentIndex({})).toEqual(new Map());
  });
});

describe("transitiveCallers", () => {
  // A→B→C→A: A calls B, B calls C, C calls A. The containment index REVERSES that (target → its
  // direct callers), so a backward BFS from C surfaces B at 1 hop and A at 2 — and the edge back to
  // A (the cycle) must NOT revisit C (the BFS seed) or loop forever.
  const containment = buildFlowContainmentIndex({
    "ts:m#A": [call("ts:m#B", "resolved")],
    "ts:m#B": [call("ts:m#C", "resolved")],
    "ts:m#C": [call("ts:m#A", "resolved")],
  });

  it("keys each reachable caller by its MIN hop count, excluding the target and closing the cycle", () => {
    const callers = transitiveCallers(containment, "ts:m#C", 5);
    expect(callers.get("ts:m#B")).toBe(1); // direct caller
    expect(callers.get("ts:m#A")).toBe(2); // indirect: caller of the caller
    expect(callers.has("ts:m#C")).toBe(false); // the target itself is never its own caller
    expect(callers.size).toBe(2); // the cycle back to C adds nothing
  });

  it("bounds the walk at maxDepth", () => {
    const callers = transitiveCallers(containment, "ts:m#C", 1);
    expect(callers.get("ts:m#B")).toBe(1);
    expect(callers.has("ts:m#A")).toBe(false); // A is 2 hops away, beyond maxDepth 1
  });

  // A→B→C (A calls B, B calls C): reversed, C's caller is B at depth 1 and A at depth 2. This is the
  // regression guard that a linear chain still keys the OLD depths when nothing is made transparent.
  const chain = buildFlowContainmentIndex({
    "ts:m#A": [call("ts:m#B", "resolved")],
    "ts:m#B": [call("ts:m#C", "resolved")],
  });

  it("keeps the old depths when no caller is transparent", () => {
    const callers = transitiveCallers(chain, "ts:m#C", 4);
    expect(callers.get("ts:m#B")).toBe(1);
    expect(callers.get("ts:m#A")).toBe(2);
  });

  it("absorbs a transparent caller — its callers rise to the freed depth, it isn't emitted", () => {
    // B is the charted flow (transparent): a FREE hop. So A, B's own caller, reads depth 1 (not 2),
    // and B itself never appears in the caller set.
    const callers = transitiveCallers(chain, "ts:m#C", 4, new Set(["ts:m#B"]));
    expect(callers.get("ts:m#A")).toBe(1);
    expect(callers.has("ts:m#B")).toBe(false);
  });
});
