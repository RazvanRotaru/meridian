import { describe, expect, it } from "vitest";
import {
  measureServicePartition,
  partitionServiceGraph,
  servicePartitionObjectiveScore,
  type ServiceAffinityEdge,
} from "./balancedServicePartition";

describe("partitionServiceGraph", () => {
  it("cuts the weak bridge between dense service communities", () => {
    const edges = [
      ...clique(["chat-a", "chat-b", "chat-c"], 5),
      ...clique(["file-a", "file-b", "file-c"], 5),
      edge("chat-c", "file-a", 0.2),
    ];

    const result = partitionServiceGraph(
      ["chat-a", "chat-b", "chat-c", "file-a", "file-b", "file-c"],
      edges,
      3,
      { minimumGroupSize: 3, maximumGroupSize: 3 },
    );

    expect(result.groups).toEqual([
      ["chat-a", "chat-b", "chat-c"],
      ["file-a", "file-b", "file-c"],
    ]);
    expect(result.metrics).toMatchObject({
      cutWeight: 0.2,
      cutEdgeCount: 1,
      quotientEdgeCount: 1,
      disconnectedGroupCount: 0,
    });
  });

  it("honours feasible size bounds and avoids a singleton tail", () => {
    const ids = Array.from({ length: 7 }, (_, index) => `s${index}`);
    const result = partitionServiceGraph(ids, chain(ids, 1), 3);

    expect(result.groups.map((group) => group.length).sort()).toEqual([3, 4]);
    expect(Math.min(...result.groups.map((group) => group.length))).toBeGreaterThan(1);
    expect(result.groups.flat().sort()).toEqual(ids);
  });

  it("prioritizes the maximum and reports a relaxed minimum when both bounds are infeasible", () => {
    const ids = Array.from({ length: 16 }, (_, index) => `s${index.toString().padStart(2, "0")}`);
    const result = partitionServiceGraph(ids, chain(ids, 1), 12, {
      minimumGroupSize: 9,
      maximumGroupSize: 15,
    });

    expect(result.groups.map((group) => group.length)).toEqual([8, 8]);
    expect(result.bounds).toEqual({ minimum: 8, maximum: 15 });
  });

  it("is invariant to lead and affinity iteration order and aggregates duplicate edges", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const edges = [
      edge("a", "b", 2), edge("a", "b", 3), edge("b", "c", 4),
      edge("d", "e", 5), edge("e", "f", 4), edge("c", "d", 0.1),
      edge("unknown", "a", 100), edge("a", "a", 100), edge("b", "f", -1),
    ];

    const forward = partitionServiceGraph(ids, edges, 3, {
      minimumGroupSize: 3,
      maximumGroupSize: 3,
    });
    const reversed = partitionServiceGraph([...ids].reverse(), [...edges].reverse().map((item) => ({
      a: item.b,
      b: item.a,
      weight: item.weight,
    })), 3, { minimumGroupSize: 3, maximumGroupSize: 3 });

    expect(reversed).toEqual(forward);
    expect(forward.groups).toEqual([["a", "b", "c"], ["d", "e", "f"]]);
  });

  it("keeps grown regions connected where a connected balanced partition is available", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `n${index.toString().padStart(2, "0")}`);
    const edges = [
      ...chain(ids, 1),
      edge("n00", "n05", 3),
      edge("n06", "n11", 3),
    ];
    const result = partitionServiceGraph(ids, edges, 4, {
      minimumGroupSize: 3,
      maximumGroupSize: 5,
    });

    expect(result.metrics.extraConnectedComponents).toBe(0);
    expect(result.metrics.connectedGroupCount).toBe(result.groupCount);
  });

  it("can optimize raw crossing-edge count instead of affinity magnitude", () => {
    const ids = ["a", "b", "c", "d"];
    const edges = [
      edge("a", "b", 8),
      edge("a", "c", 3),
      edge("b", "d", 3),
    ];
    const byWeight = partitionServiceGraph(ids, edges, 2, {
      minimumGroupSize: 2,
      maximumGroupSize: 2,
      objective: { cutWeight: 1, cutEdgeCount: 0 },
      preserveConnectedness: false,
    });
    const byCount = partitionServiceGraph(ids, edges, 2, {
      minimumGroupSize: 2,
      maximumGroupSize: 2,
      objective: { cutWeight: 0, cutEdgeCount: 1 },
      preserveConnectedness: false,
    });

    expect(byWeight.groups).toEqual([["a", "b"], ["c", "d"]]);
    expect(byWeight.metrics).toMatchObject({ cutWeight: 6, cutEdgeCount: 2 });
    expect(byCount.groups).toEqual([["a", "c"], ["b", "d"]]);
    expect(byCount.metrics).toMatchObject({ cutWeight: 8, cutEdgeCount: 1 });
    expect(byCount.objectiveScore).toBe(1);
  });

  it("measures weighted cuts, quotient bundles, and disconnected groups", () => {
    const metrics = measureServicePartition(
      [["a", "c"], ["b"], ["d"]],
      [edge("a", "b", 2), edge("b", "c", 3), edge("c", "d", 5)],
    );

    expect(metrics).toEqual({
      cutWeight: 10,
      cutEdgeCount: 3,
      quotientEdgeCount: 2,
      connectedGroupCount: 2,
      disconnectedGroupCount: 1,
      extraConnectedComponents: 1,
    });
    expect(servicePartitionObjectiveScore(metrics, {
      cutWeight: 2,
      cutEdgeCount: 1,
      quotientEdgeCount: 4,
    })).toBe(31);
  });

  it("returns an empty partition and rejects invalid sizing inputs", () => {
    expect(partitionServiceGraph([], [], 12)).toEqual({
      groups: [],
      metrics: {
        cutWeight: 0,
        cutEdgeCount: 0,
        quotientEdgeCount: 0,
        connectedGroupCount: 0,
        disconnectedGroupCount: 0,
        extraConnectedComponents: 0,
      },
      objectiveScore: 0,
      targetGroupSize: 12,
      groupCount: 0,
      bounds: { minimum: 0, maximum: 0 },
    });
    expect(() => partitionServiceGraph(["a"], [], 0)).toThrow(/targetGroupSize/);
    expect(() => partitionServiceGraph(["a"], [], 1, {
      objective: { cutWeight: -1 },
    })).toThrow(/cutWeight/);
  });
});

function edge(a: string, b: string, weight: number): ServiceAffinityEdge {
  return { a, b, weight };
}

function chain(ids: readonly string[], weight: number): ServiceAffinityEdge[] {
  return ids.slice(1).map((id, index) => edge(ids[index], id, weight));
}

function clique(ids: readonly string[], weight: number): ServiceAffinityEdge[] {
  const edges: ServiceAffinityEdge[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      edges.push(edge(ids[i], ids[j], weight));
    }
  }
  return edges;
}
