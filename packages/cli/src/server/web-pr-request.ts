/** Strict request boundary for POST /api/pr/prepare. */

import { isAllowedBranchRef } from "./git-ref";
import { canonicalExtractionSubdir } from "./web-source";
import type { ArtifactSource } from "./web-source";
import { WebError } from "./web-error";

const ALLOWED_FIELDS = new Set(["owner", "repo", "subdir", "prNumber", "baseRef", "headRef"]);
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

export interface PrPrepareRequest {
  owner: string;
  repo: string;
  subdir?: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
}

export function parsePrPrepareRequest(body: unknown): PrPrepareRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WebError(400, "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(field)) throw new WebError(400, `unexpected request field '${field}'`);
  }
  const owner = repositoryPart(raw.owner, "owner");
  const repo = repositoryPart(raw.repo, "repo").replace(/\.git$/i, "");
  if (!repo) throw new WebError(400, "repo is required");
  const subdir = extractionSubdir(raw.subdir);
  return {
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase(),
    ...(subdir ? { subdir } : {}),
    prNumber: positiveInteger(raw.prNumber, "prNumber"),
    baseRef: branch(raw.baseRef, "baseRef"),
    headRef: branch(raw.headRef, "headRef"),
  };
}

export function sourceForPrPrepare(request: PrPrepareRequest): Extract<ArtifactSource, { kind: "github" }> {
  return {
    kind: "github",
    owner: request.owner,
    repo: request.repo,
    ...(request.subdir ? { subdir: request.subdir } : {}),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new WebError(400, `${name} is required`);
  return value.trim();
}

function repositoryPart(value: unknown, name: string): string {
  const part = requiredString(value, name);
  if (!REPOSITORY_PART.test(part) || part === "." || part === ".." || part.includes("/")) {
    throw new WebError(400, `${name} contains illegal characters`);
  }
  return part;
}

function extractionSubdir(value: unknown): string {
  if (value === undefined) return "";
  const raw = requiredString(value, "subdir");
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)
    || raw.split("/").includes("..")) {
    throw new WebError(400, "subdir escapes the repository");
  }
  return canonicalExtractionSubdir(raw);
}

function branch(value: unknown, name: string): string {
  const ref = requiredString(value, name);
  if (!isAllowedBranchRef(ref)) throw new WebError(400, `${name} contains illegal characters`);
  return ref;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WebError(400, `${name} must be a positive integer`);
  }
  return value;
}
