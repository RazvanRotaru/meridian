/**
 * One private, immutable-on-publication snapshot for `meridian view`.
 *
 * The complete artifact exists in this process only while setup validates optional coverage and
 * writes the disk projection bundle. The returned descriptor contains paths and bounded metadata
 * only, so the long-lived HTTP server cannot accidentally retain the full graph.
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachIstanbulCoverage } from "../istanbul-coverage";
import { readJsonFile } from "../json-io";
import { resolveAgainst } from "../paths";
import { validateOrThrow } from "../validation";
import {
  GRAPH_PROJECTION_DIRECTORY,
  GRAPH_PROJECTION_FORMAT_VERSION,
  readGraphProjectionManifest,
  writeGraphProjectionBundle,
} from "./graph-projection-bundle";
import type { GraphGenerationSummary } from "./graph-generation-contract";
import {
  readSyntheticCapabilitySidecar,
  syntheticCapabilitySidecarPath,
  writeSyntheticCapabilitySidecar,
} from "./synthetic-capability-sidecar";

const SESSION_FORMAT_VERSION = 1;

export interface StandaloneViewSessionRequest {
  graphPath: string;
  cwd: string;
  sourceRoot: string | null;
  coveragePath?: string;
}

export interface StandaloneViewSession {
  readonly root: string;
  readonly artifactPath: string;
  readonly projectionDirectory: string;
  readonly graphSummary: GraphGenerationSummary;
  /** Resolved local source boundary used by source reads and optional synthetic execution. */
  readonly sourceRoot: string | null;
  readonly syntheticCapabilityPath: string;
  readonly scratchRoot: string;
  readonly warnings: readonly string[];
  cleanup(): void;
}

interface StandaloneSessionMetadata {
  formatVersion: typeof SESSION_FORMAT_VERSION;
  projectionFormatVersion: typeof GRAPH_PROJECTION_FORMAT_VERSION;
  projectionContentId: string;
  graphSummary: GraphGenerationSummary;
}

export function createStandaloneViewSession(request: StandaloneViewSessionRequest): StandaloneViewSession {
  const loaded = validateOrThrow(readJsonFile(request.graphPath), `graph ${request.graphPath}`).artifact;
  const artifact = request.coveragePath
    ? validateOrThrow(
        attachIstanbulCoverage(
          loaded,
          readJsonFile(request.coveragePath),
          request.sourceRoot ?? resolveAgainst(request.cwd, loaded.target.root),
        ),
        "graph with test coverage",
      ).artifact
    : loaded;

  const root = mkdtempSync(join(tmpdir(), "meridian-view-session-"));
  const stage = join(root, "snapshot-stage");
  const snapshot = join(root, "snapshot");
  const scratchRoot = join(root, "scratch");
  mkdirSync(stage, { mode: 0o700 });
  try {
    const stagedArtifactPath = join(stage, "artifact.json");
    writeFileSync(stagedArtifactPath, JSON.stringify(artifact), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const stagedProjectionDirectory = join(stage, GRAPH_PROJECTION_DIRECTORY);
    const manifest = writeGraphProjectionBundle(stagedProjectionDirectory, artifact);
    const synthetic = writeSyntheticCapabilitySidecar(stagedArtifactPath, request.sourceRoot, artifact);
    writeFileSync(join(stage, "metadata.json"), JSON.stringify({
      formatVersion: SESSION_FORMAT_VERSION,
      projectionFormatVersion: manifest.formatVersion,
      projectionContentId: manifest.contentId,
      graphSummary: manifest.graphSummary,
    } satisfies StandaloneSessionMetadata), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    // Rename is the publication boundary. Everything served from `snapshot` is immutable after
    // this point; per-request output is confined to the separate scratch directory.
    renameSync(stage, snapshot);
    mkdirSync(scratchRoot, { mode: 0o700 });
    const artifactPath = join(snapshot, "artifact.json");
    const projectionDirectory = join(snapshot, GRAPH_PROJECTION_DIRECTORY);
    const capabilityPath = syntheticCapabilitySidecarPath(artifactPath);
    const publishedManifest = readGraphProjectionManifest(projectionDirectory);
    const publishedCapability = readSyntheticCapabilitySidecar(capabilityPath);
    if (!publishedManifest
      || publishedManifest.contentId !== manifest.contentId
      || publishedCapability === null) {
      throw new Error("standalone view snapshot failed publication verification");
    }
    let cleaned = false;
    return Object.freeze({
      root,
      artifactPath,
      projectionDirectory,
      graphSummary: Object.freeze({ ...manifest.graphSummary }),
      sourceRoot: request.sourceRoot,
      syntheticCapabilityPath: capabilityPath,
      scratchRoot,
      warnings: Object.freeze(synthetic.warning ? [synthetic.warning] : []),
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        rmSync(root, { recursive: true, force: true });
      },
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
