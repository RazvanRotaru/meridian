/** Strict, bounded JSON jobs accepted by the synthetic compiler/OCI worker bundle. */

import {
  boundedSyntheticJsonValueSchema,
  syntheticExecutionManifestEntrySchema,
  syntheticFieldWatchersSchema,
  syntheticInputOverridesSchema,
  validateArtifact,
} from "@meridian/core";
import type {
  GraphArtifact,
  JsonValue,
  SyntheticExecutionManifestEntry,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
} from "@meridian/core";
import { SyntheticExecutionError } from "./synthetic-error";
import type { SyntheticExecutionErrorCode } from "./synthetic-error";

const MAX_JOB_KEYS = 8;
const MAX_SCENARIO_ID = 256;
const SHA_256 = /^[0-9a-f]{64}$/;
export const SYNTHETIC_WORKER_ERROR_PREFIX = "__MERIDIAN_SYNTHETIC_WORKER_ERROR__=";
export const SYNTHETIC_ARTIFACT_FILE_RESULT_PREFIX = "__MERIDIAN_SYNTHETIC_ARTIFACT_FILE__=";

export interface SyntheticWorkerErrorEnvelope {
  ok: false;
  error: { code: SyntheticExecutionErrorCode; status: 400 | 404 | 409 | 422 | 500 };
}

export function syntheticWorkerErrorEnvelope(error: unknown): SyntheticWorkerErrorEnvelope {
  return {
    ok: false,
    error: error instanceof SyntheticExecutionError
      ? { code: error.code, status: error.status }
      : { code: "execution-failed", status: 422 },
  };
}

export function parseSyntheticWorkerError(stdout: string, boundary: "compiler" | "OCI"): SyntheticExecutionError | null {
  const marker = stdout.lastIndexOf(SYNTHETIC_WORKER_ERROR_PREFIX);
  if (marker < 0) return null;
  const line = stdout.slice(marker + SYNTHETIC_WORKER_ERROR_PREFIX.length).split(/\r?\n/, 1)[0];
  try {
    const envelope = JSON.parse(line) as unknown;
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return null;
    const top = envelope as Record<string, unknown>;
    if (Object.keys(top).length !== 2 || top.ok !== false || !isPlainRecord(top.error)) return null;
    const error = top.error;
    if (Object.keys(error).length !== 2
      || typeof error.code !== "string"
      || !ERROR_CODES.has(error.code as SyntheticExecutionErrorCode)
      || typeof error.status !== "number"
      || !ERROR_STATUSES.has(error.status)) return null;
    return new SyntheticExecutionError(
      error.code as SyntheticExecutionErrorCode,
      error.status as 400 | 404 | 409 | 422 | 500,
      `Synthetic ${boundary} worker reported a ${error.code} failure.`,
    );
  } catch {
    return null;
  }
}

const ERROR_CODES = new Set<SyntheticExecutionErrorCode>([
  "invalid-manifest", "invalid-request", "scenario-not-found", "unsupported-runtime",
  "unsupported-scenario", "compile-failed", "execution-failed", "invalid-result",
]);
const ERROR_STATUSES = new Set([400, 404, 409, 422, 500]);

export interface SyntheticCompilationJob {
  artifact: GraphArtifact;
  scenario: SyntheticExecutionManifestEntry;
}

export interface SyntheticOciJob {
  scenarioId: string;
  expectedRootId?: string;
  expectedSourceFingerprint: string;
  input?: JsonValue;
  inputOverrides?: SyntheticInputOverride[];
  watchers?: SyntheticFieldWatcher[];
}

export type SyntheticArtifactFileJob = SyntheticOciJob;

export function parseSyntheticCompilationJob(value: unknown): SyntheticCompilationJob {
  const record = exactRecord(value, ["artifact", "scenario"]);
  const artifact = validateArtifact(record.artifact);
  const scenario = syntheticExecutionManifestEntrySchema.safeParse(record.scenario);
  if (!artifact.ok || artifact.artifact === undefined || !scenario.success) invalidJob();
  return { artifact: artifact.artifact, scenario: scenario.data };
}

export function parseSyntheticOciJob(value: unknown): SyntheticOciJob {
  return parseSyntheticArtifactFileJob(value);
}

export function parseSyntheticArtifactFileJob(value: unknown): SyntheticArtifactFileJob {
  const record = exactRecord(value, [
    "scenarioId",
    "expectedRootId",
    "expectedSourceFingerprint",
    "input",
    "inputOverrides",
    "watchers",
  ]);
  const input = record.input === undefined ? undefined : boundedSyntheticJsonValueSchema.safeParse(record.input);
  const overrides = syntheticInputOverridesSchema.safeParse(record.inputOverrides ?? []);
  const watchers = syntheticFieldWatchersSchema.safeParse(record.watchers ?? []);
  if ((input !== undefined && !input.success)
    || !overrides.success
    || !watchers.success
    || typeof record.scenarioId !== "string"
    || record.scenarioId.length < 1
    || record.scenarioId.length > MAX_SCENARIO_ID
    || (record.expectedRootId !== undefined && (typeof record.expectedRootId !== "string" || record.expectedRootId.length > 4_096))
    || typeof record.expectedSourceFingerprint !== "string"
    || !SHA_256.test(record.expectedSourceFingerprint)) {
    invalidJob();
  }
  return {
    scenarioId: record.scenarioId,
    expectedRootId: record.expectedRootId as string | undefined,
    expectedSourceFingerprint: record.expectedSourceFingerprint,
    input: input?.data,
    inputOverrides: overrides.data,
    watchers: watchers.data,
  };
}

function exactRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) invalidJob();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > MAX_JOB_KEYS || keys.some((key) => !allowed.includes(key))) invalidJob();
  return record;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidJob(): never {
  throw new SyntheticExecutionError("invalid-request", 400, "Synthetic sandbox job is invalid.");
}
