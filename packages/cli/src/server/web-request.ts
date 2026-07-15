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
import type { JsonValue, SyntheticFieldWatcher, SyntheticInputOverride } from "@meridian/core";
import type { SourceRequest } from "./clone";
import { WebError } from "./web-error";

const MAX_BODY_BYTES = 64_000;
const GENERATE_KEYS = new Set(["kind", "value", "ref", "subdir", "token", "refresh"]);
const SYNTHETIC_KEYS = new Set(["scenarioId", "rootNodeId", "input", "inputOverrides", "watchers"]);

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
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WebError(400, "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !GENERATE_KEYS.has(key))) {
    throw new WebError(400, "generate request contains an unknown field");
  }
  if (raw.kind !== "github" && raw.kind !== "path") {
    throw new WebError(400, "kind must be 'github' or 'path'");
  }
  if (typeof raw.value !== "string" || raw.value.trim() === "") {
    throw new WebError(400, "value is required");
  }
  assertOptionalString(raw, "ref");
  assertOptionalString(raw, "subdir");
  assertOptionalString(raw, "token");
  if (raw.refresh !== undefined && typeof raw.refresh !== "boolean") {
    throw new WebError(400, "refresh must be a boolean");
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
  if (Object.keys(raw).some((key) => !SYNTHETIC_KEYS.has(key))) {
    throw new WebError(400, "synthetic execution request contains an unknown field");
  }
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

function assertOptionalString(record: Record<string, unknown>, key: "ref" | "subdir" | "token"): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
    throw new WebError(400, `${key} must be a non-empty string when provided`);
  }
}

/** Deterministic 96-bit id from source plus supplied analysis identity — token deliberately excluded. */
export function artifactId(request: GenerateRequest, commit = "", analysisKey = ""): string {
  const key = [request.kind, request.value, request.ref ?? "", request.subdir ?? "", commit, analysisKey].join(" ");
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/** Remote graph ids use canonical cache identity so equivalent repository spellings converge. */
export function remoteArtifactId(
  repositoryKey: string,
  commit: string,
  analysisKey: string,
  generationId: string,
  branch = "",
): string {
  return createHash("sha256")
    .update([repositoryKey, commit, analysisKey, generationId, branch].join(" "))
    .digest("hex")
    .slice(0, 24);
}
