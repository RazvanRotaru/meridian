/**
 * Wrapping an extractor's raw nodes/edges into a complete `GraphArtifact`.
 *
 * The extractor is a pure graph producer (ADR 0001): it never writes the header. This is the
 * one place that stamps schema version, provenance, target locator, and the never-default
 * telemetry contract that the renderer's ENV gate mirrors.
 */

import { basename } from "node:path";
import { SCHEMA_VERSION } from "@meridian/core";
import type { ExtractionResult, GraphArtifact, LanguageTag } from "@meridian/core";
import { nowIso } from "./clock";
import { generatorVersion } from "./version";

const TELEMETRY_CONTRACT: GraphArtifact["telemetry"] = {
  joinKey: "node.id",
  requiredRuntimeAttributes: ["service.name", "deployment.environment.name"],
  serviceDefaulting: "forbidden",
};

export interface HeaderInputs {
  absoluteRoot: string;
  rootRelativeToCwd: string;
  language: LanguageTag;
  extraction: ExtractionResult;
  /** Display name for the artifact; defaults to the root's basename (web passes the repo label). */
  name?: string;
}

export function buildArtifact(inputs: HeaderInputs): GraphArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(),
    generator: { name: "meridian", version: generatorVersion() },
    target: {
      name: inputs.name ?? basename(inputs.absoluteRoot),
      root: inputs.rootRelativeToCwd,
      language: inputs.language,
    },
    telemetry: TELEMETRY_CONTRACT,
    nodes: inputs.extraction.nodes,
    edges: inputs.extraction.edges,
  };
}
