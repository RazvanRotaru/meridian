/**
 * Pure parsing of api.github.com JSON into narrow, whitelisted shapes the browser is allowed to
 * see. Repo names and descriptions are attacker-controllable, so nothing here forwards raw
 * response fields — only these typed projections leave the server, and only over `textContent`.
 */

import { asObject, optionalString, requireString } from "./json-fields";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SEARCH_RESULT_LIMIT = 20;
const LIST_RESULT_LIMIT = 30;

export interface RepoSummary {
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string | null;
  description: string | null;
  ownerAvatarUrl: string | null;
}

export interface GitHubUser {
  login: string;
  avatarUrl: string | null;
}

export type RepoQuery =
  | { kind: "exact"; owner: string; repo: string }
  | { kind: "search"; term: string };

export interface PullRequestRef {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface PullRequestFile {
  filename: string;
  status: string;
}

// Only github.com pull URLs — the files API is api.github.com, so an enterprise/GitLab host is a
// miss. The number is length-capped so a monstrous digit string can never overflow to a float.
const PULL_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d{1,15})(?:[/?#].*)?$/i;

/** A github.com pull-request URL -> its {owner, repo, prNumber}; anything else is null. */
export function parsePullRequestUrl(value: string): PullRequestRef | null {
  const match = PULL_URL.exec(value.trim());
  if (!match) {
    return null;
  }
  const prNumber = Number(match[3]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return null;
  }
  return { owner: match[1], repo: match[2].replace(/\.git$/, ""), prNumber };
}

/**
 * Project the `GET /pulls/{n}/files` array to whitelisted {filename, status}. Attacker-controlled
 * extra fields (patch, blob_url, …) are dropped; a non-object entry or a non-string filename is
 * skipped rather than thrown so one odd row can't sink the whole page.
 */
export function parsePullRequestFiles(json: unknown): PullRequestFile[] {
  if (!Array.isArray(json)) {
    return [];
  }
  const files: PullRequestFile[] = [];
  for (const entry of json) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const body = entry as Record<string, unknown>;
    const filename = optionalString(body, "filename");
    if (filename !== null) {
      files.push({ filename, status: optionalString(body, "status") ?? "" });
    }
  }
  return files;
}

/** An `owner/repo` (or github URL) becomes a direct lookup; anything else is a fuzzy search. */
export function classifyQuery(raw: string): RepoQuery | null {
  const term = raw.trim();
  if (term.length === 0) {
    return null;
  }
  const slug = repoSlug(term);
  if (slug) {
    return { kind: "exact", owner: slug.owner, repo: slug.repo };
  }
  return { kind: "search", term };
}

export function parseRepoResult(json: unknown): RepoSummary {
  return toRepoSummary(asObject(json));
}

export function parseSearchResults(json: unknown): RepoSummary[] {
  const items = asObject(json).items;
  if (!Array.isArray(items)) {
    return [];
  }
  return items.slice(0, SEARCH_RESULT_LIMIT).map((item) => toRepoSummary(asObject(item)));
}

/** `GET /user/repos` responds with a bare array, not search's `{items}` envelope. */
export function parseRepoList(json: unknown): RepoSummary[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.slice(0, LIST_RESULT_LIMIT).map((item) => toRepoSummary(asObject(item)));
}

export function parseUser(json: unknown): GitHubUser {
  const body = asObject(json);
  return { login: requireString(body, "login"), avatarUrl: httpsOrNull(optionalString(body, "avatar_url")) };
}

function repoSlug(term: string): { owner: string; repo: string } | null {
  const stripped = term
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (!OWNER_REPO.test(stripped)) {
    return null;
  }
  const [owner, repo] = stripped.split("/");
  return { owner, repo };
}

function toRepoSummary(body: Record<string, unknown>): RepoSummary {
  const owner = asObject(body.owner ?? {});
  return {
    fullName: requireString(body, "full_name"),
    isPrivate: body.private === true,
    defaultBranch: optionalString(body, "default_branch"),
    description: optionalString(body, "description"),
    ownerAvatarUrl: httpsOrNull(optionalString(owner, "avatar_url")),
  };
}

/** Only https URLs survive; a `javascript:`/`data:` avatar becomes null before it can be an src. */
function httpsOrNull(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
