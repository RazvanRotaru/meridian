import { describe, expect, it } from "vitest";
import {
  EXTERNAL_CONTAINER_ID,
  externalTargetId,
  materializeBoundaryNodes,
  unresolvedTargetId,
} from "./boundary";
import { validateArtifact } from "./validate";
import { validArtifact } from "./testing/fixtures";
import type { GraphEdge, GraphNode } from "./types";

function node(id: string, kind: string, parentId?: string): GraphNode {
  return { id, kind, qualifiedName: id, displayName: id, parentId, location: { file: "a.ts", startLine: 1 } };
}

function externalEdge(source: string, target: string, resolution: GraphEdge["resolution"]): GraphEdge {
  return { id: `calls@${source}|${target}`, source, target, kind: "calls", resolution };
}

describe("materializeBoundaryNodes", () => {
  it("builds ecosystem-qualified external and unresolved target ids", () => {
    expect(externalTargetId("npm", "shared", "Client")).toBe("ext:npm/shared#Client");
    expect(externalTargetId("python", "shared", "Client")).toBe("ext:python/shared#Client");
    expect(unresolvedTargetId("npm")).toBe("unresolved:npm/?");
    expect(unresolvedTargetId("python")).toBe("unresolved:python/?");
  });

  it("is a no-op when no boundary targets exist", () => {
    const nodes = [node("ts:a.ts#A.f", "method", "ts:a.ts")];
    expect(materializeBoundaryNodes(nodes, [])).toBe(nodes);
  });

  it("creates an External container and a leaf per external/unresolved target", () => {
    const nodes = [node("ts:a.ts", "module"), node("ts:a.ts#A.f", "method", "ts:a.ts")];
    const edges = [
      externalEdge("ts:a.ts#A.f", "ext:npm/typescript/lib.es5.d.ts#Error", "external"),
      externalEdge("ts:a.ts#A.f", "unresolved:npm/?", "unresolved"),
    ];
    const added = materializeBoundaryNodes(nodes, edges).filter((entry) => !nodes.includes(entry));
    const container = added.find((entry) => entry.id === EXTERNAL_CONTAINER_ID);
    expect(container?.parentId).toBeNull();
    const leaves = added.filter((entry) => entry.parentId === EXTERNAL_CONTAINER_ID);
    expect(leaves.map((entry) => entry.kind).sort()).toEqual(["external", "unresolved"]);
    expect(leaves.find((entry) => entry.kind === "external")?.displayName).toBe("Error");
  });

  it("keeps the artifact valid with no warnings (boundary kinds are registered)", () => {
    const artifact = validArtifact();
    const source = artifact.nodes[3]!.id;
    const target = "ext:npm/typescript/lib.es5.d.ts#Error";
    artifact.edges.push(externalEdge(source, target, "external"));
    artifact.nodes = materializeBoundaryNodes(artifact.nodes, artifact.edges);
    const result = validateArtifact(artifact);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
