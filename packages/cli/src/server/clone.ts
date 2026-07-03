/**
 * Resolving a user-supplied source (GitHub repo or local path) to a directory to extract from.
 *
 * Security is the whole point of this module: GitHub input is parsed to an https URL through a
 * strict allowlist (owner/repo or an http(s) git URL — never ssh, file://, or shell
 * metacharacters), git runs via an argv array so nothing is shell-interpreted, and any auth
 * token travels only in an `http.extraHeader` (never the URL, never a log, never a response).
 * The spawn itself and stderr-scrubbing live in `git-exec`.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { resolveAgainst } from "../paths";
import { WebError } from "./web-error";
import { base64Auth, runGitClone } from "./git-exec";

export { base64Auth };

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SAFE_REF = /^[\w.\-/]+$/;
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
  args.push("clone", "--depth", "1", "--single-branch");
  if (opts.ref) {
    args.push("--branch", opts.ref);
  }
  args.push("--", url, targetDir);
  return args;
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
  const tmpRoot = mkdtempSync(join(tmpdir(), "blueprint-clone-"));
  const removeTmp = () => rmSync(tmpRoot, { recursive: true, force: true });
  // Any failure past the mkdtemp — clone, subdir escape, missing subdir — must remove the temp
  // clone; only a successful resolve hands the cleanup responsibility back to the caller.
  try {
    await runGitClone(buildCloneArgs(url, tmpRoot, { ref: request.ref, token }), token);
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
