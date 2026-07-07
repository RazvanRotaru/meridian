/**
 * Pure parsing of api.github.com JSON into narrow, whitelisted shapes the browser is allowed to
 * see. Repo names and descriptions are attacker-controllable, so nothing here forwards raw
 * response fields — only these typed projections leave the server, and only over `textContent`.
 */

import { asObject, optionalString, requireString } from "./json-fields";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SEARCH_RESULT_LIMIT = 20;
const LIST_RESULT_LIMIT = 30;
const BRANCH_RESULT_LIMIT = 100;

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

/** `GET /repos/{owner}/{repo}/branches` responds with an array of `{ name }` objects. */
export function parseBranchList(json: unknown): string[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.slice(0, BRANCH_RESULT_LIMIT).flatMap((item) => {
    const name = isObjectLike(item) ? item.name : null;
    return typeof name === "string" && name.length > 0 ? [name] : [];
  });
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
