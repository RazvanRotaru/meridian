import type { PrSessionSource } from "../state/prTypes";

/** Collision-safe browser-profile scope. It deliberately excludes every generated/revision id. */
export function canonicalPrReviewScope(source: PrSessionSource, prNumber: number): string | null {
  const repository = canonicalGitHubRepository(source.repository);
  const subdir = canonicalExtractionSubdir(source.subdir);
  if (repository === null || subdir === null || !Number.isSafeInteger(prNumber) || prNumber < 1) return null;
  return `github-pr:v1:${segment(repository)}:${segment(subdir)}:${prNumber}`;
}

function canonicalGitHubRepository(value: string): string | null {
  let candidate = value.trim().replace(/\.git$/i, "");
  const ssh = /^(?:git@)?github\.com[:/]([^/]+\/[^/]+)$/i.exec(candidate);
  if (ssh) candidate = ssh[1];
  try {
    if (/^https?:\/\//i.test(candidate)) {
      const url = new URL(candidate);
      if (url.hostname.toLowerCase() !== "github.com") return null;
      candidate = url.pathname.replace(/^\/+|\/+$/g, "");
    }
  } catch {
    return null;
  }
  const parts = candidate.split("/");
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))
    ? `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`
    : null;
}

function canonicalExtractionSubdir(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (normalized === "") return "";
  const parts = normalized.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..") ? parts.join("/") : null;
}

function segment(value: string): string {
  return `${value.length}:${value}`;
}
