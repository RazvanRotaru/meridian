/**
 * Validating a user-supplied source and resolving local paths for extraction.
 *
 * Security is the whole point of this module: GitHub input is parsed to an https URL through a
 * strict allowlist (owner/repo or an http(s) git URL — never ssh, file://, or shell
 * metacharacters). Persistent remote preparation is owned by `WebRepositoryMirror`; this module
 * intentionally has no second clone path.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAgainst } from "../paths";
import { WebError } from "./web-error";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SHELL_METACHARS = /[\s;&|`$<>()]/;

export interface SourceRequest {
  kind: "github" | "path";
  value: string;
  ref?: string;
  subdir?: string;
}

export interface ResolvedLocalSource {
  /** The local directory to extract from. */
  dir: string;
  /** A human label for the artifact — never carries credentials. */
  target: string;
}

/** owner/repo or an http(s) git URL -> a clone URL. Everything else is rejected. */
export function parseGitHubSource(value: string): string {
  const trimmed = value.trim();
  if (OWNER_REPO.test(trimmed)) {
    return canonicalGitRemoteUrl(`https://github.com/${trimmed.replace(/\.git$/i, "")}.git`);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return canonicalGitRemoteUrl(trimmed);
  }
  throw new WebError(400, "enter owner/repo or an https git URL (ssh, file://, and shell characters are rejected)");
}

export function canonicalGitRemoteUrl(
  value: string,
  options: { allowFile?: boolean } = {},
): string {
  if (SHELL_METACHARS.test(value)) {
    throw new WebError(400, "URL contains illegal characters");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebError(400, "invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && !(options.allowFile && url.protocol === "file:")) {
    throw new WebError(400, "only http(s) git URLs are allowed");
  }
  if (url.username || url.password) {
    throw new WebError(400, "do not embed credentials in the URL; use the token field");
  }
  if (url.search || url.hash) {
    throw new WebError(400, "repository URLs must not contain a query string or fragment");
  }
  if (url.hostname === "github.com") {
    const components = url.pathname.split("/").filter(Boolean);
    if (components.length === 2) {
      const repo = components[1]!.replace(/\.git$/i, "");
      return `https://github.com/${components[0]!.toLowerCase()}/${repo.toLowerCase()}.git`;
    }
  }
  return url.protocol === "file:" ? pathToFileURL(resolve(fileURLToPath(url))).href : url.toString();
}

/** Resolve an existing subdir to a canonical directory contained by the canonical clone root.
 * The second containment check is essential: a repository-controlled symlink can be lexically
 * inside the checkout while resolving to an arbitrary host path. */
export function sanitizeSubdir(cloneDir: string, subdir?: string): string {
  let root: string;
  try {
    root = realpathSync.native(resolve(cloneDir));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new WebError(400, "repository checkout is unavailable");
  }
  const clean = subdir?.trim();
  const lexical = clean ? resolve(root, clean) : root;
  if (!isPathWithin(root, lexical)) {
    throw new WebError(400, "source subfolder escapes the repository");
  }
  let candidate: string;
  try {
    candidate = realpathSync.native(lexical);
    if (!statSync(candidate).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new WebError(400, "source subfolder was not found in the repository");
  }
  if (!isPathWithin(root, candidate)) {
    throw new WebError(400, "source subfolder escapes the repository through a symbolic link");
  }
  return candidate;
}

/** Resolve an extraction subdirectory with lexical and canonical containment checks. */
export function resolveExtractionSubdir(cloneDir: string, subdir?: string): string {
  return sanitizeSubdir(cloneDir, subdir);
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function resolveLocalSource(request: SourceRequest, cwd: string): ResolvedLocalSource {
  if (request.kind !== "path") {
    throw new Error("remote sources must be prepared through WebRepositoryMirror");
  }
  return resolveLocalPath(request.value, cwd);
}

function resolveLocalPath(value: string, cwd: string): ResolvedLocalSource {
  const dir = resolveAgainst(cwd, value.trim());
  if (!isDirectory(dir)) {
    throw new WebError(400, `local path is not a directory: ${value}`);
  }
  return { dir, target: value.trim() };
}

/** The human label for the artifact: the repo the reader entered, plus the analyzed subfolder when
 * one was chosen (e.g. "UiPath/Autopilot/src/packages"). A pure display string — never credentials
 * (the value is the user-entered owner/repo or git URL, the subdir the relative path they picked). */
export function sourceLabel(value: string, subdir?: string): string {
  const repo = value.trim();
  const sub = subdir?.trim().replace(/^[/\\]+|[/\\]+$/g, "");
  return sub ? `${repo}/${sub}` : repo;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
