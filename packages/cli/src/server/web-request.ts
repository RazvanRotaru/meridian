/**
 * Reading and validating the POST /api/generate request.
 *
 * Kept apart from the router so the server module stays about routing. The body is size-capped
 * (a local tool, but still never an unbounded read) and the deterministic id deliberately omits
 * the token so the same repo maps to the same graph regardless of how it was authenticated.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  syntheticFieldWatchersSchema,
  syntheticInputOverridesSchema,
} from "@meridian/core";
import type {
  JsonValue,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
  SyntheticScenarioDescriptor,
} from "@meridian/core";
import type { SourceRequest } from "./clone";
import type { SyntheticExecutionTrust } from "./web-boot";
import { WebError } from "./web-error";

const MAX_BODY_BYTES = 64_000;

export interface GenerateRequest extends SourceRequest {
  token?: string;
  refresh?: boolean;
}

export interface SyntheticExecutionRequest {
  scenarioId: string;
  rootNodeId: string;
  input: JsonValue;
  inputOverrides: SyntheticInputOverride[];
  watchers: SyntheticFieldWatcher[];
}

export function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new WebError(413, "request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        rejectBody(new WebError(400, "request body is not valid JSON"));
      }
    });
    request.on("error", () => rejectBody(new WebError(400, "could not read request body")));
  });
}

export function parseGenerateRequest(body: unknown): GenerateRequest {
  if (typeof body !== "object" || body === null) {
    throw new WebError(400, "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  if (raw.kind !== "github" && raw.kind !== "path") {
    throw new WebError(400, "kind must be 'github' or 'path'");
  }
  if (typeof raw.value !== "string" || raw.value.trim() === "") {
    throw new WebError(400, "value is required");
  }
  return {
    kind: raw.kind,
    value: raw.value,
    ref: optionalString(raw.ref),
    subdir: optionalString(raw.subdir),
    token: optionalString(raw.token),
    refresh: raw.refresh === true,
  };
}

/** A deliberately small, JSON-only execution request. The shared body reader has already enforced
 * the 64 KB cap; this parser keeps scenario identity bounded and requires an explicit input value
 * (including `null`) so a missing payload can never silently select a runner default. */
export function parseSyntheticExecutionRequest(body: unknown): SyntheticExecutionRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WebError(400, "synthetic execution request must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.scenarioId !== "string" || raw.scenarioId.trim().length === 0 || raw.scenarioId.length > 256) {
    throw new WebError(400, "scenarioId must be a non-empty string of at most 256 characters");
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "input")) {
    throw new WebError(400, "input is required");
  }
  if (typeof raw.rootNodeId !== "string" || raw.rootNodeId.trim().length === 0 || raw.rootNodeId.length > 2_048) {
    throw new WebError(400, "rootNodeId must be a non-empty string of at most 2048 characters");
  }
  const inputOverrides = syntheticInputOverridesSchema.safeParse(raw.inputOverrides ?? []);
  if (!inputOverrides.success) {
    throw new WebError(400, "inputOverrides must contain bounded, unique synthetic input overrides");
  }
  const watchers = syntheticFieldWatchersSchema.safeParse(raw.watchers ?? []);
  if (!watchers.success) {
    throw new WebError(400, "watchers must contain bounded synthetic field watchers");
  }
  // `body` came from JSON.parse, so every present value is JSON-compatible by construction.
  return {
    scenarioId: raw.scenarioId.trim(),
    rootNodeId: raw.rootNodeId.trim(),
    input: raw.input as JsonValue,
    inputOverrides: inputOverrides.data,
    watchers: watchers.data,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export interface LocalSyntheticCoordinates {
  readonly scenarios: readonly SyntheticScenarioDescriptor[];
  readonly sourceFingerprint: string | null;
  readonly trust: SyntheticExecutionTrust | null;
}

/** A local id names one exact published graph and capability at one source identity. */
export function localArtifactId(
  sourceIdentity: string,
  artifactByteDigest: string,
  synthetic: LocalSyntheticCoordinates,
): string {
  return shortHash(JSON.stringify([
    sourceIdentity,
    artifactByteDigest,
    synthetic.scenarios,
    synthetic.sourceFingerprint,
    synthetic.trust,
  ]));
}

/**
 * Remote ids combine branch-neutral extraction identity with the exact selected-ref provenance.
 * `snapshotDigest` is deliberately not the byte digest of whichever ref first warmed the cache.
 */
export function remoteArtifactId(
  repositoryKey: string,
  commit: string,
  analysisKey: string,
  ref: string | undefined,
  snapshotDigest: string,
): string {
  return shortHash(JSON.stringify([
    repositoryKey,
    commit,
    analysisKey,
    remoteRefProvenance(ref),
    snapshotDigest,
  ]));
}

export function remoteRefProvenance(ref: string | undefined): string {
  return ref === undefined ? "HEAD" : `ref:${ref.trim()}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
