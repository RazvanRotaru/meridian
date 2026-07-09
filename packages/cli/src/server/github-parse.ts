/**
 * Pure parsing of api.github.com JSON into narrow, whitelisted shapes the browser is allowed to
 * see. Repo names and descriptions are attacker-controllable, so nothing here forwards raw
 * response fields — only these typed projections leave the server, and only over `textContent`.
 */

import type { LineRange } from "@meridian/core";
import { asObject, numberOr, optionalString, requireNumber, requireString } from "./json-fields";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SEARCH_RESULT_LIMIT = 20;
/** One full page of `GET /user/repos` — the pagination loop in github.ts caps the total. */
const LIST_RESULT_LIMIT = 100;
const PR_LIST_RESULT_LIMIT = 30;
const PR_FILE_RESULT_LIMIT = 100;

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

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  headRef: string;
  baseRef: string;
  updatedAt: string;
  draft: boolean;
  state: "open" | "closed";
  url: string;
}

export interface PrFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  /** New-side changed line ranges parsed from the file's unified-diff patch; omitted when GitHub
   * ships no patch (binary, or a diff too large to include) ⇒ downstream treats the whole file as
   * changed. Lets the PR-review graph name the exact code blocks a PR touched, not just the files. */
  hunks?: LineRange[];
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

export function parsePullRequestList(json: unknown): PrSummary[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.slice(0, PR_LIST_RESULT_LIMIT).map((item) => toPrSummary(asObject(item)));
}

export function parsePullRequestFiles(json: unknown): PrFile[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.slice(0, PR_FILE_RESULT_LIMIT).map((item) => toPrFile(asObject(item)));
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

function toPrSummary(body: Record<string, unknown>): PrSummary {
  return {
    number: Math.trunc(requireNumber(body, "number")),
    title: requireString(body, "title"),
    author: requireString(asObject(body.user ?? {}), "login"),
    headRef: requireString(asObject(body.head ?? {}), "ref"),
    baseRef: optionalString(asObject(body.base ?? {}), "ref") ?? "",
    updatedAt: requireString(body, "updated_at"),
    draft: body.draft === true,
    state: body.state === "closed" ? "closed" : "open",
    url: httpsOrNull(optionalString(body, "html_url")) ?? "",
  };
}

function toPrFile(body: Record<string, unknown>): PrFile {
  const file: PrFile = {
    path: requireString(body, "filename"),
    status: prFileStatus(body.status),
    additions: Math.max(0, Math.trunc(numberOr(body.additions, 0))),
    deletions: Math.max(0, Math.trunc(numberOr(body.deletions, 0))),
  };
  const patch = optionalString(body, "patch");
  const hunks = patch ? parsePatchHunks(patch) : [];
  if (hunks.length > 0) {
    file.hunks = hunks;
  }
  return file;
}

/**
 * New-side changed line ranges from a unified-diff patch, read from its hunk headers alone
 * (`@@ -a,b +c,d @@`): `c` is the new-side start, `d` the line count (absent ⇒ 1). A `+c,0` header
 * is a pure deletion — anchored to a 1-line span at `c` so a delete-only edit still names the block
 * it sits in (mirrors the local `meridian review` diff parser). Ranges are 1-based and inclusive.
 */
export function parsePatchHunks(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of patch.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      continue;
    }
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    ranges.push(count === 0 ? { start, end: start + 1 } : { start, end: start + count - 1 });
  }
  return ranges;
}

function prFileStatus(status: unknown): PrFile["status"] {
  if (status === "added" || status === "modified" || status === "removed" || status === "renamed") {
    return status;
  }
  if (status === "copied") {
    return "added";
  }
  return "modified";
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
