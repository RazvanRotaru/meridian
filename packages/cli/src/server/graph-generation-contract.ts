import type { GraphArtifact } from "@meridian/core";

/** Bounded immutable metadata shared below cache, lifecycle, and transport layers. */
export interface GraphGenerationSummary {
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

/** Build bounded generation metadata without retaining the graph artifact. */
export function graphSummaryFor(artifact: GraphArtifact): GraphGenerationSummary {
  return Object.freeze({
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    nodeCount: artifact.nodes.length,
    edgeCount: artifact.edges.length,
  });
}
