import type { GenerateRequest } from "./web-request";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

export type ArtifactSource =
  | { kind: "github"; owner: string; repo: string; subdir?: string }
  | { kind: "other" };

export function artifactSourceFor(request: GenerateRequest): ArtifactSource {
  if (request.kind !== "github") {
    return { kind: "other" };
  }
  const repo = parseGitHubRepo(request.value);
  return repo ? { kind: "github", ...repo, subdir: request.subdir } : { kind: "other" };
}

export function stripExtractionSubdir<T extends { path: string }>(files: T[], subdir: string | undefined): T[] {
  const prefix = normalizedSubdir(subdir);
  if (!prefix) {
    return files;
  }
  return files.flatMap((file) => {
    const path = normalizedPath(file.path);
    if (!path.startsWith(`${prefix}/`)) {
      return [];
    }
    return [{ ...file, path: path.slice(prefix.length + 1) }];
  });
}

function parseGitHubRepo(value: string): { owner: string; repo: string } | null {
  const trimmed = value.trim().replace(/\.git$/i, "");
  if (OWNER_REPO.test(trimmed)) {
    return splitOwnerRepo(trimmed);
  }
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/i.test(url.protocol) || url.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    const parts = url.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
    return parts.length === 2 && OWNER_REPO.test(parts.join("/")) ? splitOwnerRepo(parts.join("/")) : null;
  } catch {
    return null;
  }
}

function splitOwnerRepo(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split("/");
  return { owner, repo };
}

function normalizedSubdir(subdir: string | undefined): string | null {
  const normalized = normalizedPath(subdir ?? "");
  return normalized.includes("..") || normalized.length === 0 ? null : normalized;
}

function normalizedPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
}
