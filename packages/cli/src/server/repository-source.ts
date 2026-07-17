/**
 * Canonical repository identity, checkout containment, and local-source resolution.
 *
 * Security is the whole point of this module: GitHub input is parsed to an https URL through a
 * strict allowlist (owner/repo or an http(s) git URL — never ssh, file://, or shell
 * metacharacters). Remote materialization belongs exclusively to `RepositoryMirrorStore`; this
 * module never creates an independent clone.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
  /** The existing local directory to extract from. */
  dir: string;
  /** A human label for the artifact — never carries credentials. */
  target: string;
}

/** owner/repo or an http(s) git URL -> a clone URL. Everything else is rejected. */
export function parseGitHubSource(value: string): string {
  const trimmed = value.trim();
  if (OWNER_REPO.test(trimmed)) {
    // Keep this spelling stable: repository and artifact cache keys created before the shared
    // mirror layer include this URL verbatim. Mirror-only canonicalization lives below.
    return `https://github.com/${trimmed.replace(/\.git$/, "")}.git`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return validateHttpGitUrl(trimmed);
  }
  throw new WebError(400, "enter owner/repo or an https git URL (ssh, file://, and shell characters are rejected)");
}

/**
 * Ambient GitHub credentials are host-scoped: a user-entered GitLab or arbitrary HTTPS URL must
 * never receive GITHUB_TOKEN/GH_TOKEN/session credentials. A token explicitly supplied with that
 * generate request may target another HTTPS host (for GitHub Enterprise, GitLab, and similar).
 */
export function gitTokenForRemote(remoteUrl: string, token: string | undefined, explicit = false): string | undefined {
  if (!token) return undefined;
  const url = new URL(remoteUrl);
  if (url.protocol !== "https:") {
    if (explicit) throw new WebError(400, "a repository token can only be sent over https");
    return undefined;
  }
  return url.hostname.toLowerCase() === "github.com" || explicit ? token : undefined;
}

function validateHttpGitUrl(value: string): string {
  if (SHELL_METACHARS.test(value)) {
    throw new WebError(400, "URL contains illegal characters");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebError(400, "invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebError(400, "only http(s) git URLs are allowed");
  }
  if (url.username || url.password) {
    throw new WebError(400, "do not embed credentials in the URL; use the token field");
  }
  return url.toString();
}

/**
 * GitHub repository paths are case-insensitive, and its clone endpoint accepts the web URL,
 * trailing-slash, and `.git` spellings as the same project. Collapse only that well-known host so
 * shared mirrors converge without changing the spelling used by the persistent checkout and
 * artifact caches, or the identity of case-sensitive Git hosts.
 */
export function canonicalRepositoryUrl(remoteUrl: string): string {
  return canonicalGitHubCloneUrl(new URL(remoteUrl));
}

function canonicalGitHubCloneUrl(url: URL): string {
  if (url.hostname.toLowerCase() !== "github.com" || url.search || url.hash) {
    return url.toString();
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return url.toString();
  const owner = parts[0];
  const repository = parts[1]?.replace(/\.git$/i, "");
  if (!owner || !repository || !OWNER_REPO.test(`${owner}/${repository}`)) {
    return url.toString();
  }
  url.pathname = `/${owner.toLowerCase()}/${repository.toLowerCase()}.git`;
  return url.toString();
}

/** Resolve an existing subdir to a canonical directory contained by the canonical checkout root.
 * The second containment check is essential: a repository-controlled symlink can be lexically
 * inside the checkout while resolving to an arbitrary host path. */
export function sanitizeSubdir(checkoutDir: string, subdir?: string): string {
  let root: string;
  try {
    root = realpathSync.native(resolve(checkoutDir));
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

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function resolveLocalSource(value: string, cwd: string): ResolvedLocalSource {
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
