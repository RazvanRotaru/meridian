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
import { join, resolve, sep } from "node:path";
import { resolveAgainst } from "../paths";
import { WebError } from "./web-error";
import { base64Auth, runGit } from "./git-exec";

export { base64Auth };

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SAFE_REF = /^[\w.\-/]+$/;
const SHELL_METACHARS = /[\s;&|`$<>()]/;

export interface SourceRequest {
  kind: "github" | "path";
  value: string;
  ref?: string;
  subdir?: string;
  /** When set, check out `refs/pull/<n>/head` instead of a branch (mutually exclusive with ref). */
  prNumber?: number;
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
    return `https://github.com/${trimmed.replace(/\.git$/, "")}.git`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return validateHttpGitUrl(trimmed);
  }
  throw new WebError(400, "enter owner/repo or an https git URL (ssh, file://, and shell characters are rejected)");
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

/**
 * `--branch` cannot name a pull ref, so a PR is fetched by its number: `git fetch origin
 * refs/pull/<n>/head` (run inside the clone). The token rides the same `http.extraHeader` as the
 * clone; the ref is built from a validated integer so nothing user-controlled reaches the argv.
 */
export function buildPullFetchArgs(prNumber: number, opts: { token?: string }): string[] {
  assertPullNumber(prNumber);
  const args: string[] = [];
  if (opts.token) {
    args.push("-c", `http.extraHeader=AUTHORIZATION: basic ${base64Auth(opts.token)}`);
  }
  args.push("-c", "core.longpaths=true");
  args.push("fetch", "--depth", "1", "origin", `refs/pull/${prNumber}/head`);
  return args;
}

/**
 * Detach-checkout the just-fetched pull head. `core.longpaths` is repeated (the clone's one-shot
 * `-c` didn't persist) because this is the worktree write that hits Windows' MAX_PATH, and
 * `advice.detachedHead=false` mutes git's detached-HEAD warning.
 */
export function buildCheckoutArgs(): string[] {
  return ["-c", "core.longpaths=true", "-c", "advice.detachedHead=false", "checkout", "FETCH_HEAD"];
}

function assertPullNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new WebError(400, "invalid pull-request number");
  }
}

/** Join a subdir onto the clone root, rejecting any `..` escape out of the repository. */
export function sanitizeSubdir(cloneDir: string, subdir?: string): string {
  const clean = subdir?.trim();
  if (!clean) {
    return cloneDir;
  }
  const root = resolve(cloneDir);
  const candidate = resolve(root, clean);
  const withinRoot = candidate === root || candidate.startsWith(root + sep);
  if (!withinRoot) {
    throw new WebError(400, "source subfolder escapes the repository");
  }
  return candidate;
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
  if (request.ref && !SAFE_REF.test(request.ref)) {
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
    await fetchInto(tmpRoot, url, request, token);
    const dir = sanitizeSubdir(tmpRoot, request.subdir);
    if (!isDirectory(dir)) {
      throw new WebError(400, "source subfolder was not found in the repository");
    }
    return { dir, target: request.value.trim(), cleanup: removeTmp };
  } catch (error) {
    removeTmp();
    throw error;
  }
}

/**
 * A branch source is a single shallow clone. A PR source shallow-clones the default branch, then
 * fetches `refs/pull/<n>/head` and detach-checks it out — the two-step dance `--branch` can't do.
 */
async function fetchInto(dir: string, url: string, request: SourceRequest, token?: string): Promise<void> {
  if (request.prNumber == null) {
    await runGit(buildCloneArgs(url, dir, { ref: request.ref, token }), { token });
    return;
  }
  await runGit(buildCloneArgs(url, dir, { token }), { token });
  await runGit(buildPullFetchArgs(request.prNumber, { token }), { token, cwd: dir });
  await runGit(buildCheckoutArgs(), { cwd: dir });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
