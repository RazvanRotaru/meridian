/**
 * Fetch the graph artifact and gate it on schema MAJOR compatibility.
 *
 * Per ADR 0001's SemVer rule a reader accepts `MAJOR == reader` (and tolerates higher MINORs
 * as additive). We refuse a mismatched MAJOR loudly rather than render a graph whose shape we
 * cannot trust. Tier-1/Tier-2 deep validation is the CLI's job at `generate` time.
 */

import type { GraphArtifact } from "@meridian/core";

// The schema is frozen at 1.x (ADR 0001); the renderer imports `@meridian/core` for TYPES
// only, so the supported major is a local literal rather than a bundled runtime const.
const SUPPORTED_MAJOR = 1;

export async function loadArtifact(graphUrl: string): Promise<GraphArtifact> {
  const response = await fetch(graphUrl);
  if (!response.ok) {
    throw new Error(`graph fetch failed (${response.status}) from ${graphUrl}`);
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
