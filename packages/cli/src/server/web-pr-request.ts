/**
 * Reading and validating the POST /api/pr/analyze request body.
 *
 * Kept apart from the handler (like web-request.ts is for /api/generate) so the streaming module
 * stays about the pipeline. Validation is the security boundary for the git argv: refs become
 * POSITIONAL `git fetch` arguments, which cannot be `--`-fenced like a clone URL can, so the shared
 * Git branch validator rejects anything that could read as an option (no leading `-`) or violate
 * `check-ref-format --branch`; the PR number is forced to a positive integer BEFORE
 * `pull/<n>/head` is ever built from it.
 */

import { isAllowedCloneRef } from "./git-ref";
import { WebError } from "./web-error";

/**
 * A complete PR graph is not a product delivery mode. The benchmark harness must opt in at both
 * boundaries: launch a loopback server in benchmark mode and mark each complete-control request.
 * The marker is intentionally versioned so an old harness cannot silently widen a newer server.
 */
export const PR_FULL_BASELINE_BENCHMARK_HEADER = "x-meridian-pr-full-baseline";
export const PR_FULL_BASELINE_BENCHMARK_CAPABILITY = "benchmark-v1";

export interface PrAnalyzeRequest {
  id: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
  /** Internal-only picker snapshot used by direct preparation; never trusted as the resolved SHA. */
  expectedHeadSha?: string;
  /** Bounded, incrementally expandable graph contract. Only the controlled benchmark opts out. */
  progressive?: boolean;
}

/**
 * Direct landing-page preparation names the repository instead of manufacturing a branch graph
 * merely to obtain its source descriptor. `headSha` is the picker snapshot when GitHub supplied
 * one; the server rejects a moved head before extraction rather than silently opening another
 * revision than the reader selected.
 */
export interface PrPrepareRequest {
  repository: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
  headSha?: string;
}

export function parsePrAnalyzeRequest(body: unknown): PrAnalyzeRequest {
  if (typeof body !== "object" || body === null) {
    throw new WebError(400, "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  return {
    id: requireString(raw.id, "id"),
    prNumber: requirePositiveInt(raw.prNumber, "prNumber"),
    baseRef: requireRef(raw.baseRef, "baseRef"),
    headRef: requireRef(raw.headRef, "headRef"),
    progressive: raw.progressive === undefined ? true : requireBoolean(raw.progressive, "progressive"),
  };
}

export function parsePrPrepareRequest(body: unknown): PrPrepareRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WebError(400, "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  const repository = requireString(raw.repository, "repository");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.endsWith(".git")) {
    throw new WebError(400, "repository must be an exact owner/repo");
  }
  const headSha = optionalCommit(raw.headSha);
  return {
    repository,
    prNumber: requirePositiveInt(raw.prNumber, "prNumber"),
    baseRef: requireRef(raw.baseRef, "baseRef"),
    headRef: requireRef(raw.headRef, "headRef"),
    ...(headSha === undefined ? {} : { headSha }),
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WebError(400, `${name} is required`);
  }
  return value.trim();
}

function requireRef(value: unknown, name: string): string {
  const ref = requireString(value, name);
  if (!isAllowedCloneRef(ref)) {
    throw new WebError(400, `${name} contains illegal characters`);
  }
  return ref;
}

function requirePositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WebError(400, `${name} must be a positive integer`);
  }
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new WebError(400, `${name} must be a boolean`);
  return value;
}

function optionalCommit(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value.trim())) {
    throw new WebError(400, "headSha must be a 40- or 64-character Git object id");
  }
  return value.trim().toLowerCase();
}
