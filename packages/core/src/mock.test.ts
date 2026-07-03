import { describe, expect, it } from "vitest";
import { buildMockOverlay, mockMetricsForNode } from "./mock";
import { overlaySchema } from "./overlay";
import { validArtifact } from "./testing/fixtures";

describe("mock overlay generator", () => {
  it("is deterministic for the same env, node, and seed", () => {
    expect(mockMetricsForNode("staging", "ts:src/a.ts#A.b")).toEqual(mockMetricsForNode("staging", "ts:src/a.ts#A.b"));
  });

  it("produces a different profile per environment", () => {
    const staging = mockMetricsForNode("staging", "ts:src/a.ts#A.b");
    const dev = mockMetricsForNode("dev", "ts:src/a.ts#A.b");
    expect(staging).not.toEqual(dev);
  });

  it("keeps latency percentiles monotonic", () => {
    for (const node of ["ts:a", "ts:b#x", "ts:c#y.z"]) {
      const { latencyMs } = mockMetricsForNode("staging", node);
      expect(latencyMs.p50).toBeLessThanOrEqual(latencyMs.p95);
      expect(latencyMs.p95).toBeLessThanOrEqual(latencyMs.p99);
    }
  });

  it("caps the error rate at 25%", () => {
    for (let index = 0; index < 200; index += 1) {
      const { errorRate } = mockMetricsForNode("prod", `ts:src/n${index}.ts#N.m`);
      expect(errorRate).toBeGreaterThanOrEqual(0);
      expect(errorRate).toBeLessThanOrEqual(0.25);
    }
  });

  it("keys every node and validates against the overlay schema", () => {
    const graph = validArtifact();
    const overlay = buildMockOverlay(graph, "staging");
    expect(Object.keys(overlay.metricsByNodeId).sort()).toEqual(graph.nodes.map((node) => node.id).sort());
    expect(overlaySchema.safeParse(overlay).success).toBe(true);
  });

  it("produces byte-identical overlays across runs", () => {
    const graph = validArtifact();
    expect(JSON.stringify(buildMockOverlay(graph, "staging"))).toBe(JSON.stringify(buildMockOverlay(graph, "staging")));
  });
});
