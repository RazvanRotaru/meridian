/**
 * Small immutable capability metadata written while the extraction child still owns the graph.
 *
 * The long-lived server reads only this bounded sidecar. It never decodes artifact.json merely to
 * decide whether synthetic execution may be advertised. The execution workers independently
 * reload and validate the artifact and recompute the source fingerprint before compiling code.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  syntheticScenarioDescriptorSchema,
  type GraphArtifact,
  type SyntheticScenarioDescriptor,
} from "@meridian/core";
import { loadSyntheticScenarios, syntheticSourceFingerprint } from "./synthetic-execution";

export const SYNTHETIC_CAPABILITY_SIDECAR_FILE = "synthetic-capability.json";
export const MAX_SYNTHETIC_CAPABILITY_SIDECAR_BYTES = 1024 * 1024;
export const INVALID_SYNTHETIC_CAPABILITY_WARNING =
  "Synthetic execution was disabled because the scenario manifest is invalid.";

const SHA = /^[0-9a-f]{7,64}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const SIDECAR_KEYS = [
  "version",
  "state",
  "scenarios",
  "sourceFingerprint",
  "artifactCommit",
  "warning",
] as const;
const SCENARIO_KEYS = new Set(["id", "label", "rootId", "description", "defaultInput"]);

export type SyntheticCapabilityState = "ready" | "absent" | "invalid";

export interface SyntheticCapabilitySidecar {
  readonly version: 1;
  readonly state: SyntheticCapabilityState;
  readonly scenarios: SyntheticScenarioDescriptor[];
  readonly sourceFingerprint: string | null;
  /** Exact immutable revision recorded by extraction, when the artifact has VCS provenance. */
  readonly artifactCommit: string | null;
  /** A deliberately generic warning; never contains parser diagnostics or filesystem paths. */
  readonly warning: string | null;
}

export interface InspectedSyntheticCapabilitySidecar {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly capability: SyntheticCapabilitySidecar;
}

export function syntheticCapabilitySidecarPath(artifactPath: string): string {
  return join(dirname(artifactPath), SYNTHETIC_CAPABILITY_SIDECAR_FILE);
}

/**
 * Build and publish one sidecar beside artifact.json. Manifest/config errors disable only this
 * optional capability; the graph remains valid and the safe warning is folded into extraction.
 */
export function writeSyntheticCapabilitySidecar(
  artifactPath: string,
  sourceRoot: string | null,
  artifact: GraphArtifact,
): SyntheticCapabilitySidecar {
  const artifactCommit = normalizedCommit(artifact.target.vcs?.commit);
  let capability: SyntheticCapabilitySidecar;
  if (sourceRoot === null) {
    capability = absentCapability(artifactCommit);
  } else try {
    const scenarios = loadSyntheticScenarios(sourceRoot);
    capability = scenarios.length === 0
      ? absentCapability(artifactCommit)
      : {
          version: 1,
          state: "ready",
          scenarios,
          sourceFingerprint: syntheticSourceFingerprint(sourceRoot, artifact),
          artifactCommit,
          warning: null,
        };
  } catch {
    capability = invalidCapability(artifactCommit);
  }

  let serialized = `${JSON.stringify(capability)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SYNTHETIC_CAPABILITY_SIDECAR_BYTES) {
    capability = invalidCapability(artifactCommit);
    serialized = `${JSON.stringify(capability)}\n`;
  }
  writeFileSync(syntheticCapabilitySidecarPath(artifactPath), serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return capability;
}

/** Read and strictly validate one bounded sidecar. Invalid, oversized, or symlinked files fail closed. */
export function readSyntheticCapabilitySidecar(path: string): SyntheticCapabilitySidecar | null {
  return inspectSyntheticCapabilitySidecar(path)?.capability ?? null;
}

/** Read once so snapshot publication can bind the exact validated bytes by digest. */
export function inspectSyntheticCapabilitySidecar(path: string): InspectedSyntheticCapabilitySidecar | null {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()
      || entry.size < 1 || entry.size > MAX_SYNTHETIC_CAPABILITY_SIDECAR_BYTES) return null;
    const raw = readFileSync(path);
    if (raw.byteLength < 1 || raw.byteLength > MAX_SYNTHETIC_CAPABILITY_SIDECAR_BYTES) return null;
    const capability = parseSyntheticCapabilitySidecar(JSON.parse(raw.toString("utf8")));
    if (!capability) return null;
    return {
      path,
      bytes: raw.byteLength,
      sha256: createHash("sha256").update(raw).digest("hex"),
      capability,
    };
  } catch {
    return null;
  }
}

export function parseSyntheticCapabilitySidecar(value: unknown): SyntheticCapabilitySidecar | null {
  if (!isRecord(value) || !hasExactKeys(value, SIDECAR_KEYS) || value.version !== 1) return null;
  if (value.state !== "ready" && value.state !== "absent" && value.state !== "invalid") return null;
  if (!Array.isArray(value.scenarios) || value.scenarios.length > 256) return null;
  const scenarios: SyntheticScenarioDescriptor[] = [];
  const ids = new Set<string>();
  for (const candidate of value.scenarios) {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => !SCENARIO_KEYS.has(key))) return null;
    const parsed = syntheticScenarioDescriptorSchema.safeParse(candidate);
    if (!parsed.success || ids.has(parsed.data.id)) return null;
    ids.add(parsed.data.id);
    scenarios.push(parsed.data);
  }
  const sourceFingerprint = value.sourceFingerprint;
  const artifactCommit = value.artifactCommit;
  const warning = value.warning;
  if (sourceFingerprint !== null && (typeof sourceFingerprint !== "string" || !SHA_256.test(sourceFingerprint))) return null;
  if (artifactCommit !== null && (typeof artifactCommit !== "string" || !SHA.test(artifactCommit))) return null;
  if (warning !== null && (typeof warning !== "string" || Buffer.byteLength(warning, "utf8") > 512)) return null;

  if (value.state === "ready") {
    if (scenarios.length === 0 || typeof sourceFingerprint !== "string" || warning !== null) return null;
  } else if (scenarios.length !== 0 || sourceFingerprint !== null) {
    return null;
  } else if (value.state === "absent" ? warning !== null : warning !== INVALID_SYNTHETIC_CAPABILITY_WARNING) {
    return null;
  }
  return Object.freeze({
    version: 1,
    state: value.state,
    scenarios: Object.freeze(scenarios.map((scenario) => Object.freeze({ ...scenario }))) as unknown as SyntheticScenarioDescriptor[],
    sourceFingerprint,
    artifactCommit,
    warning,
  });
}

function absentCapability(artifactCommit: string | null): SyntheticCapabilitySidecar {
  return { version: 1, state: "absent", scenarios: [], sourceFingerprint: null, artifactCommit, warning: null };
}

function invalidCapability(artifactCommit: string | null): SyntheticCapabilitySidecar {
  return {
    version: 1,
    state: "invalid",
    scenarios: [],
    sourceFingerprint: null,
    artifactCommit,
    warning: INVALID_SYNTHETIC_CAPABILITY_WARNING,
  };
}

function normalizedCommit(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const commit = value.trim().toLowerCase();
  return SHA.test(commit) ? commit : null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
