/**
 * Resolving a user-supplied source (GitHub repo or local path) to a directory to extract from.
 *
 * Security is the whole point of this module: GitHub input is parsed to an https URL through a
 * strict allowlist (owner/repo or an http(s) git URL — never ssh, file://, or shell
 * metacharacters), git runs via an argv array so nothing is shell-interpreted, and any auth
 * token travels only in an `http.extraHeader` (never the URL, never a log, never a response).
 * The spawn itself and stderr-scrubbing live in `git-exec`.
 */

import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveAgainst } from "../paths";
import { WebError } from "./web-error";
import { base64Auth, runGitClone } from "./git-exec";
import { isAllowedCloneRef } from "./git-ref";

export { base64Auth };

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SHELL_METACHARS = /[\s;&|`$<>()]/;

export interface SourceRequest {
  kind: "github" | "path";
  value: string;
  ref?: string;
  subdir?: string;
}

export interface ResolvedSource {
  /** The directory to extract from (clone root joined with any sanitized subdir). */
  dir: string;
  /** A human label for the artifact — never carries credentials. */
  target: string;
  /** Remove any temp clone; a no-op for local paths. */
  cleanup(): void;
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

/**
 * The full argv passed after `git`. A token becomes a `-c http.extraHeader` (placed before the
 * subcommand, as git requires) so it never lands in the URL; `--` fences the URL from option
 * parsing. This is pure so the auth-arg construction can be unit-tested without a network.
 */
export function buildCloneArgs(url: string, targetDir: string, opts: { ref?: string; token?: string }): string[] {
  const args: string[] = [];
  if (opts.token) {
    args.push("-c", `http.extraHeader=AUTHORIZATION: basic ${base64Auth(opts.token)}`);
  }
  // Windows checkout dies at MAX_PATH (260 chars) without this; git on other platforms ignores it.
  args.push("-c", "core.longpaths=true");
  args.push("clone", "--depth", "1", "--single-branch");
  if (opts.ref) {
    args.push("--branch", opts.ref);
  }
  args.push("--", url, targetDir);
  return args;
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

/** Backwards-compatible name used by the remote cache path. `sanitizeSubdir` now performs both
 * lexical and canonical containment checks itself. */
export function resolveExtractionSubdir(cloneDir: string, subdir?: string): string {
  return sanitizeSubdir(cloneDir, subdir);
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function resolveSource(request: SourceRequest, cwd: string, token?: string): Promise<ResolvedSource> {
  if (request.kind === "path") {
    return resolveLocalPath(request.value, cwd);
  }
  return cloneGitHub(request, token);
}

function resolveLocalPath(value: string, cwd: string): ResolvedSource {
  const dir = resolveAgainst(cwd, value.trim());
  if (!isDirectory(dir)) {
    throw new WebError(400, `local path is not a directory: ${value}`);
  }
  return { dir, target: value.trim(), cleanup: () => {} };
}

async function cloneGitHub(request: SourceRequest, token?: string): Promise<ResolvedSource> {
  if (request.ref && !isAllowedCloneRef(request.ref)) {
    throw new WebError(400, "branch contains illegal characters");
  }
  const url = parseGitHubSource(request.value);
  // realpath expands Windows 8.3 short names (a short-form %TEMP% is common). A short-name root
  // makes ts-morph's long-name file paths look outside the project, and extraction finds nothing.
  const tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "blueprint-clone-")));
  const removeTmp = () => rmSync(tmpRoot, { recursive: true, force: true });
  // Any failure past the mkdtemp — clone, subdir escape, missing subdir — must remove the temp
  // clone; only a successful resolve hands the cleanup responsibility back to the caller.
  try {
    await runGitClone(buildCloneArgs(url, tmpRoot, { ref: request.ref, token }), token);
    const dir = resolveExtractionSubdir(tmpRoot, request.subdir);
    return { dir, target: sourceLabel(request.value, request.subdir), cleanup: removeTmp };
  } catch (error) {
    removeTmp();
    throw error;
  }
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
