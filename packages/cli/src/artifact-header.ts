/**
 * Wrapping an extractor's raw nodes/edges into a complete `GraphArtifact`.
 *
 * The extractor is a pure graph producer (ADR 0001): it never writes the header. This is the
 * one place that stamps schema version, provenance, target locator, and the never-default
 * telemetry contract that the renderer's ENV gate mirrors.
 */

import { basename } from "node:path";
import { LOGIC_FLOW_EXTENSION, PORTS_EXTENSION, SCHEMA_VERSION } from "@meridian/core";
import type {
  ChangedLineStats,
  ChangedRanges,
  ExtractionResult,
  GraphArtifact,
  GraphNode,
  JsonValue,
  LanguageTag,
} from "@meridian/core";
import { nowIso } from "./clock";
import { entryModulesExtension } from "./entry-points";
import { generatorVersion } from "./version";

/** Free-form extension key: the repo's declared application entry points, best-first (NodeId[]). */
const ENTRY_MODULES_EXTENSION = "entryModules";

/** Free-form extension key: `{ baseRef, files, stats }` when generated with `--changed-since` —
 * the base ref plus the diff line ranges (+ add/delete totals) per file for viewer markings/chips. */
const CHANGED_SINCE_EXTENSION = "changedSince";

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
  /** The `--changed-since` base ref + per-file line ranges and +/− totals for renderer diff UI. */
  changedSince?: { baseRef: string; files: ChangedRanges; stats: ChangedLineStats };
}

export function buildArtifact(inputs: HeaderInputs): GraphArtifact {
  const artifact: GraphArtifact = {
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
  const extensions = extensionsFor(inputs);
  if (Object.keys(extensions).length > 0) {
    artifact.extensions = extensions;
  }
  return artifact;
}

/**
 * Fold the artifact's optional side-channels into the `extensions` record: the extractor's
 * logic flows and the CLI-resolved entry modules. Each is omitted when it has nothing to add.
 */
function extensionsFor(inputs: HeaderInputs): Record<string, JsonValue> {
  const extensions: Record<string, JsonValue> = {};
  const flows = inputs.extraction.flows;
  if (flows && Object.keys(flows).length > 0) {
    extensions[LOGIC_FLOW_EXTENSION] = flows as unknown as JsonValue;
  }
  const ports = inputs.extraction.ports;
  if (ports && ports.length > 0) {
    extensions[PORTS_EXTENSION] = ports as unknown as JsonValue;
  }
  const entryModules = entryModulesExtension(inputs.absoluteRoot, moduleNodesOf(inputs.extraction));
  if (entryModules) {
    extensions[ENTRY_MODULES_EXTENSION] = entryModules;
  }
  if (inputs.changedSince) {
    extensions[CHANGED_SINCE_EXTENSION] = inputs.changedSince as unknown as JsonValue;
  }
  return extensions;
}

function moduleNodesOf(extraction: ExtractionResult): GraphNode[] {
  return extraction.nodes.filter((node) => node.kind === "module");
}
