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
  return partitionExtractionSubdir(files, subdir).inside;
}

export function partitionExtractionSubdir<T extends { path: string }>(
  files: T[],
  subdir: string | undefined,
): { inside: T[]; outside: T[] } {
  const prefix = normalizedSubdir(subdir);
  if (!prefix) {
    return { inside: files, outside: [] };
  }
  const inside: T[] = [];
  const outside: T[] = [];
  for (const file of files) {
    const path = normalizedPath(file.path);
    if (!path.startsWith(`${prefix}/`)) {
      outside.push(file);
      continue;
    }
    inside.push({ ...file, path: path.slice(prefix.length + 1) });
  }
  return { inside, outside };
}

/** The exact normalized prefix used for extraction filtering, safe to expose as the session label. */
export function canonicalExtractionSubdir(subdir: string | undefined): string {
  return normalizedSubdir(subdir) ?? "";
}

/** Deepest repo-root directory shared by candidate files. Unsafe parent segments never suggest a root. */
export function deepestCommonDirectory(files: readonly { path: string }[]): string {
  const directories = files.flatMap((file) => {
    const segments = file.path.replace(/\\/g, "/").split("/");
    if (segments.includes("..")) {
      return [];
    }
    const normalized = segments.filter((segment) => segment.length > 0 && segment !== ".");
    return [normalized.slice(0, -1)];
  });
  if (directories.length === 0) {
    return "";
  }
  return directories.slice(1).reduce(commonPrefix, directories[0]).join("/");
}

/** The inverse of stripExtractionSubdir, for WRITES: a browser path back to repo-root-relative. */
export function restoreExtractionSubdir(path: string, subdir: string | undefined): string {
  const prefix = normalizedSubdir(subdir);
  const normalized = normalizedPath(path);
  return prefix ? `${prefix}/${normalized}` : normalized;
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
  return normalized.split("/").includes("..") || normalized.length === 0 ? null : normalized;
}

function normalizedPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
}

function commonPrefix(left: string[], right: string[]): string[] {
  const length = Math.min(left.length, right.length);
  let shared = 0;
  while (shared < length && left[shared] === right[shared]) {
    shared += 1;
  }
  return left.slice(0, shared);
}
