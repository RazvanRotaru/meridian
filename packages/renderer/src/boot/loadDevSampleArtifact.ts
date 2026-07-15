/**
 * Load Vite's explicit non-injected sample artifact and gate it on schema MAJOR compatibility.
 *
 * Per ADR 0001's SemVer rule a reader accepts `MAJOR == reader` (and tolerates higher MINORs
 * as additive). We refuse a mismatched MAJOR loudly rather than render a graph whose shape we
 * cannot trust. Injected/server sessions must never call this module; they boot through bounded
 * graph projections exclusively.
 */

import type { GraphArtifact } from "@meridian/core";

// The schema is frozen at 1.x (ADR 0001); the renderer imports `@meridian/core` for TYPES
// only, so the supported major is a local literal rather than a bundled runtime const.
const SUPPORTED_MAJOR = 1;

export async function loadDevSampleArtifact(artifactUrl: string): Promise<GraphArtifact> {
  const response = await fetch(artifactUrl);
  if (!response.ok) {
    throw new Error(`dev sample graph fetch failed (${response.status}) from ${artifactUrl}`);
  }
  const artifact = (await response.json()) as GraphArtifact;
  assertSupportedSchema(artifact.schemaVersion);
  return artifact;
}

function assertSupportedSchema(schemaVersion: string): void {
  const major = majorOf(schemaVersion);
  if (major !== SUPPORTED_MAJOR) {
    throw new Error(
      `unsupported schema major ${major} (renderer supports ${SUPPORTED_MAJOR}.x): ${schemaVersion}`,
    );
  }
}

function majorOf(version: string): number {
  return Number.parseInt(version.split(".")[0] ?? "", 10);
}
