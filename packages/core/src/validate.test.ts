import { describe, expect, it } from "vitest";
import { validateArtifact } from "./validate";
import { validArtifact } from "./testing/fixtures";

function codes(input: unknown): string[] {
  return validateArtifact(input).errors.map((issue) => issue.code);
}

describe("validateArtifact", () => {
  it("accepts the worked example with no errors or warnings", () => {
    const result = validateArtifact(validArtifact());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects a structurally malformed artifact at tier 1", () => {
    expect(codes({ schemaVersion: "1.0.0" })).toContain("SCHEMA");
  });

  it("rejects duplicate node ids", () => {
    const artifact = validArtifact();
    artifact.nodes.push({ ...artifact.nodes[1]! });
    expect(codes(artifact)).toContain("DUPLICATE_NODE_ID");
  });

  it("rejects a dangling parentId", () => {
    const artifact = validArtifact();
    artifact.nodes[2]!.parentId = "ts:src/ghost.ts";
    expect(codes(artifact)).toContain("DANGLING_PARENT");
  });

  it("rejects a parentId cycle", () => {
    const artifact = validArtifact();
    artifact.nodes[2]!.parentId = "ts:src/services/orderService.ts#OrderService.placeOrder";
    expect(codes(artifact)).toContain("PARENT_CYCLE");
  });

  it("rejects a resolved edge whose target is not a node", () => {
    const artifact = validArtifact();
    const ghost = "ts:src/ghost.ts#Ghost.method";
    artifact.edges[0]!.target = ghost;
    artifact.edges[0]!.id = `calls@${artifact.edges[0]!.source}|${ghost}`;
    expect(codes(artifact)).toContain("DANGLING_EDGE_TARGET");
  });

  it("rejects an edge id that does not match the deterministic format", () => {
    const artifact = validArtifact();
    artifact.edges[0]!.id = "calls@ts:wrong|ts:wrong";
    expect(codes(artifact)).toContain("EDGE_ID_MISMATCH");
  });

  it("rejects a weight that disagrees with the call-site count", () => {
    const artifact = validArtifact();
    artifact.edges[0]!.weight = 5;
    expect(codes(artifact)).toContain("WEIGHT_MISMATCH");
  });

  it("rejects telemetry that permits service defaulting", () => {
    const artifact = validArtifact();
    (artifact.telemetry as { serviceDefaulting: string }).serviceDefaulting = "allowed";
    expect(validateArtifact(artifact).ok).toBe(false);
  });

  it("warns, but does not fail, on an unregistered node kind", () => {
    const artifact = validArtifact();
    artifact.nodes[3]!.kind = "coroutine";
    const result = validateArtifact(artifact);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toContain("UNKNOWN_NODE_KIND");
  });
});
