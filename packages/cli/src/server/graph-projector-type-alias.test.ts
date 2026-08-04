import { describe, expect, it } from "vitest";
import {
  GRAPH_PROJECTION_VERSION,
  SCHEMA_VERSION,
  validateArtifact,
  type GraphArtifact,
} from "@meridian/core";
import { projectCanonicalGraph } from "./graph-projector";

describe("graph projector type-alias references", () => {
  it("retains a referenced type alias and its declaration closure as boundary evidence", () => {
    const artifact: GraphArtifact = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: "2026-08-04T00:00:00.000Z",
      generator: { name: "test", version: "1" },
      target: { name: "fixture", root: ".", language: "typescript" },
      nodes: [
        node("pkg:.", "package", "."),
        node("m:web-search", "module", "src/WebSearchTool.ts", "pkg:."),
        node("method:web-search.constructor", "method", "src/WebSearchTool.ts", "m:web-search"),
        node("m:policy", "module", "src/IToolExecutionPolicyEvaluator.ts", "pkg:."),
        node(
          "type:ToolExecutionTargetAuthorizer",
          "typeAlias",
          "src/IToolExecutionPolicyEvaluator.ts",
          "m:policy",
        ),
      ],
      edges: [
        edge("imports", "m:web-search", "m:policy"),
        edge(
          "references",
          "method:web-search.constructor",
          "type:ToolExecutionTargetAuthorizer",
        ),
      ],
    };

    const projection = projectCanonicalGraph({
      artifact,
      seedArtifact: artifact,
      request: {
        version: GRAPH_PROJECTION_VERSION,
        graphId: "head",
        roots: { kind: "files", fileIds: ["m:web-search"] },
        requestedDepth: 0,
        prefetchDepth: 0,
      },
      generation: "a".repeat(64),
      loadedDepth: 0,
    });

    expect(projection.rootFileIds).toEqual(["m:web-search"]);
    expect(projection.loadedFileIds).toEqual(["m:web-search", "m:policy"]);
    expect(projection.nodes.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "pkg:.",
      "m:web-search",
      "method:web-search.constructor",
      "m:policy",
      "type:ToolExecutionTargetAuthorizer",
    ]));
    expect(projection.edges).toContainEqual(expect.objectContaining({
      kind: "references",
      source: "method:web-search.constructor",
      target: "type:ToolExecutionTargetAuthorizer",
      resolution: "resolved",
    }));
    expect(validateArtifact({
      schemaVersion: projection.schemaVersion,
      generatedAt: projection.generatedAt,
      generator: projection.generator,
      target: projection.target,
      nodes: projection.nodes,
      edges: projection.edges,
      extensions: projection.extensions,
    }).errors).toEqual([]);
  });
});

function node(
  id: string,
  kind: string,
  file: string,
  parentId: string | null = null,
) {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine: 1, endLine: 1 },
  };
}

function edge(kind: string, source: string, target: string) {
  return {
    id: `${kind}@${source}|${target}`,
    kind,
    source,
    target,
    resolution: "resolved" as const,
  };
}
