import { describe, expect, it } from "vitest";
import {
  bunchMqPartition,
  bunchMqQuality,
  cpmQuality,
  leidenCpmPartition,
  type DirectedCommunityEdge,
  type UndirectedCommunityEdge,
} from "./serviceCommunityPartitioners";

describe("leidenCpmPartition", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const edges: UndirectedCommunityEdge[] = [
    { a: "a", b: "b", weight: 3 },
    { a: "b", b: "c", weight: 3 },
    { a: "a", b: "c", weight: 3 },
    { a: "d", b: "e", weight: 3 },
    { a: "e", b: "f", weight: 3 },
    { a: "d", b: "f", weight: 3 },
    { a: "c", b: "d", weight: 0.1 },
  ];

  it("finds dense CPM communities separated by a weak bridge", () => {
    expect(leidenCpmPartition(ids, edges, { resolution: 0.8, seed: 7 })).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("is deterministic and independent of node/edge iteration order", () => {
    const forward = leidenCpmPartition(ids, edges, { resolution: 0.8, seed: 19 });
    const reverse = leidenCpmPartition([...ids].reverse(), [...edges].reverse().map((edge) => ({
      a: edge.b,
      b: edge.a,
      weight: edge.weight,
    })), { resolution: 0.8, seed: 19 });
    expect(reverse).toEqual(forward);
  });

  it("returns a complete partition and does not reduce CPM quality from singletons", () => {
    const partition = leidenCpmPartition(ids, edges, { resolution: 0.8, seed: 3 });
    expect(partition.flat().sort()).toEqual(ids);
    expect(new Set(partition.flat()).size).toBe(ids.length);
    expect(cpmQuality(ids, edges, partition, 0.8)).toBeGreaterThanOrEqual(
      cpmQuality(ids, edges, ids.map((id) => [id]), 0.8),
    );
  });

  it("keeps every non-singleton community connected", () => {
    const partition = leidenCpmPartition(ids, edges, { resolution: 0.8, seed: 11 });
    const neighbours = new Map(ids.map((id) => [id, new Set<string>()]));
    edges.forEach((edge) => {
      neighbours.get(edge.a)!.add(edge.b);
      neighbours.get(edge.b)!.add(edge.a);
    });
    for (const community of partition) {
      const allowed = new Set(community);
      const reached = new Set<string>([community[0]]);
      const queue = [community[0]];
      while (queue.length > 0) {
        const node = queue.shift()!;
        for (const neighbour of neighbours.get(node) ?? []) {
          if (allowed.has(neighbour) && !reached.has(neighbour)) {
            reached.add(neighbour);
            queue.push(neighbour);
          }
        }
      }
      expect([...reached].sort()).toEqual([...community].sort());
    }
  });
});

describe("Bunch MQ", () => {
  const ids = ["a", "b", "c", "d"];
  const edges: DirectedCommunityEdge[] = [
    { source: "a", target: "b" },
    { source: "b", target: "a" },
    { source: "c", target: "d" },
    { source: "d", target: "c" },
    { source: "b", target: "c" },
  ];

  it("computes the published internal / (internal + half external) objective", () => {
    // Each pair has internal=2 and external=1, hence 2 * (2 / 2.5) = 1.6.
    expect(bunchMqQuality(ids, edges, [["a", "b"], ["c", "d"]])).toBeCloseTo(1.6);
    expect(bunchMqQuality(ids, edges, [ids])).toBeCloseTo(1);
    expect(bunchMqQuality(ids, edges, ids.map((id) => [id]))).toBe(0);
  });

  it("hill-climbs to cohesive, loosely coupled modules", () => {
    const partition = bunchMqPartition(ids, edges);
    expect(partition).toEqual([["a", "b"], ["c", "d"]]);
    expect(bunchMqQuality(ids, edges, partition)).toBeGreaterThan(
      bunchMqQuality(ids, edges, [ids]),
    );
  });

  it("is deterministic under input reordering and respects the optional hard size cap", () => {
    const forward = bunchMqPartition(ids, edges, { maxClusterSize: 2 });
    const reverse = bunchMqPartition([...ids].reverse(), [...edges].reverse(), { maxClusterSize: 2 });
    expect(reverse).toEqual(forward);
    expect(forward.every((community) => community.length <= 2)).toBe(true);
  });

  it("leaves nodes without dependency evidence as honest singletons", () => {
    expect(bunchMqPartition(["a", "b"], [])).toEqual([["a"], ["b"]]);
  });
});
