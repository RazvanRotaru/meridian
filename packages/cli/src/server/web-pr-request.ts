/**
 * Reading and validating the POST /api/pr/analyze request body.
 *
 * Kept apart from the handler (like web-request.ts is for /api/generate) so the streaming module
 * stays about the pipeline. Validation is the security boundary for the git argv: refs become
 * POSITIONAL `git fetch` arguments, which cannot be `--`-fenced like a clone URL can, so SAFE_REF
 * must reject anything that could read as an option (no leading `-`) or smuggle whitespace; the
 * PR number is forced to a positive integer BEFORE `pull/<n>/head` is ever built from it.
 */

import { WebError } from "./web-error";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface PrAnalyzeRequest {
  id: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
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
  if (!SAFE_REF.test(ref)) {
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
