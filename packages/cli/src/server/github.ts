/**
 * The GitHub HTTP client: the only place that talks to github.com / api.github.com. Fixed hosts
 * (no user-controlled URL → no SSRF), the token travels in an Authorization header sent server-side
 * only and is never logged, and every request is time-boxed. Response *shaping* is delegated to the
 * pure parsers, so this thin IO layer — like `runGit` — is exercised by the live smoke test.
 */

import { WebError } from "./web-error";
import { classifyQuery, parsePullRequestFiles, parseRepoList, parseRepoResult, parseSearchResults, parseUser } from "./github-parse";
import type { GitHubUser, RepoSummary } from "./github-parse";
import { interpretTokenResponse, parseDeviceCodeResponse, tokenRedeemBody } from "./github-auth";
import type { DeviceCode, TokenPoll } from "./github-auth";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_ROOT = "https://api.github.com";
const SCOPE = "repo";
const REQUEST_TIMEOUT_MS = 10_000;
const SEARCH_PER_PAGE = 20;
const LIST_PER_PAGE = 30;
const PR_FILES_PER_PAGE = 100;
const PR_FILES_CAP = 3000;
const PR_FILES_MAX_PAGES = PR_FILES_CAP / PR_FILES_PER_PAGE;

export interface PullRequestFilesRequest {
  owner: string;
  repo: string;
  prNumber: number;
  /** Bearer token; omitted for a public PR (a private one 404s without it). */
  token?: string;
}

export interface PullRequestFiles {
  /** Repo-root-relative filenames, capped at PR_FILES_CAP. */
  files: string[];
  /** True when the cap was hit and more files may exist beyond it. */
  truncated: boolean;
}

export interface GitHubClient {
  requestDeviceCode(): Promise<DeviceCode>;
  redeemToken(deviceCode: string): Promise<TokenPoll>;
  getUser(token: string): Promise<GitHubUser>;
  searchRepos(token: string, query: string): Promise<RepoSummary[]>;
  listOwnRepos(token: string): Promise<RepoSummary[]>;
  fetchPullRequestFiles(request: PullRequestFilesRequest): Promise<PullRequestFiles>;
}

export interface GitHubClientConfig {
  clientId: string;
  fetchImpl?: typeof fetch;
}

export function createGitHubClient(config: GitHubClientConfig): GitHubClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  return {
    requestDeviceCode: () => requestDeviceCode(fetchImpl, config.clientId),
    redeemToken: (deviceCode) => redeemToken(fetchImpl, config.clientId, deviceCode),
    getUser: (token) => getUser(fetchImpl, token),
    searchRepos: (token, query) => searchRepos(fetchImpl, token, query),
    listOwnRepos: (token) => listOwnRepos(fetchImpl, token),
    fetchPullRequestFiles: (request) => fetchPullRequestFiles(fetchImpl, request),
  };
}

async function requestDeviceCode(fetchImpl: typeof fetch, clientId: string): Promise<DeviceCode> {
  return parseDeviceCodeResponse(await postForm(fetchImpl, DEVICE_CODE_URL, { client_id: clientId, scope: SCOPE }));
}

async function redeemToken(fetchImpl: typeof fetch, clientId: string, deviceCode: string): Promise<TokenPoll> {
  return interpretTokenResponse(await postForm(fetchImpl, TOKEN_URL, tokenRedeemBody(clientId, deviceCode)));
}

async function getUser(fetchImpl: typeof fetch, token: string): Promise<GitHubUser> {
  return parseUser(await getApi(fetchImpl, `${API_ROOT}/user`, token));
}

async function searchRepos(fetchImpl: typeof fetch, token: string, query: string): Promise<RepoSummary[]> {
  const classified = classifyQuery(query);
  if (!classified) {
    return [];
  }
  if (classified.kind === "exact") {
    return exactRepo(fetchImpl, token, classified.owner, classified.repo);
  }
  return fuzzyRepos(fetchImpl, token, classified.term);
}

async function exactRepo(fetchImpl: typeof fetch, token: string, owner: string, repo: string): Promise<RepoSummary[]> {
  const url = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const json = await getApiOrNull(fetchImpl, url, token);
  return json ? [parseRepoResult(json)] : [];
}

async function fuzzyRepos(fetchImpl: typeof fetch, token: string, term: string): Promise<RepoSummary[]> {
  const params = new URLSearchParams({ q: term, per_page: String(SEARCH_PER_PAGE), sort: "updated" });
  return parseSearchResults(await getApi(fetchImpl, `${API_ROOT}/search/repositories?${params}`, token));
}

/**
 * Repos the user owns or was personally invited to, most recently pushed first. Deliberately NOT
 * `organization_member`: busy org repos would bury the user's own under the 30-item cap.
 */
async function listOwnRepos(fetchImpl: typeof fetch, token: string): Promise<RepoSummary[]> {
  const params = new URLSearchParams({ per_page: String(LIST_PER_PAGE), sort: "pushed", affiliation: "owner,collaborator" });
  return parseRepoList(await getApi(fetchImpl, `${API_ROOT}/user/repos?${params}`, token));
}

/**
 * The changed-file list for a PR: 100 per page, walking until a short page ends it or the
 * PR_FILES_CAP is hit. Overflowing the cap (or exhausting the page budget) sets `truncated`.
 */
async function fetchPullRequestFiles(fetchImpl: typeof fetch, request: PullRequestFilesRequest): Promise<PullRequestFiles> {
  const { owner, repo, prNumber, token } = request;
  const base = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/files`;
  const files: string[] = [];
  for (let page = 1; page <= PR_FILES_MAX_PAGES; page++) {
    const batch = parsePullRequestFiles(await getApi(fetchImpl, `${base}?per_page=${PR_FILES_PER_PAGE}&page=${page}`, token));
    const room = PR_FILES_CAP - files.length;
    if (batch.length > room) {
      for (const file of batch.slice(0, room)) files.push(file.filename);
      return { files, truncated: true };
    }
    for (const file of batch) files.push(file.filename);
    if (batch.length < PR_FILES_PER_PAGE) {
      return { files, truncated: false };
    }
  }
  return { files, truncated: true };
}

async function postForm(fetchImpl: typeof fetch, url: string, body: Record<string, string>): Promise<unknown> {
  const response = await withTimeout((signal) =>
    fetchImpl(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal,
    }),
  );
  return response.json();
}

async function getApi(fetchImpl: typeof fetch, url: string, token?: string): Promise<unknown> {
  const response = await apiRequest(fetchImpl, url, token);
  if (!response.ok) {
    throw apiError(response.status);
  }
  return response.json();
}

async function getApiOrNull(fetchImpl: typeof fetch, url: string, token?: string): Promise<unknown | null> {
  const response = await apiRequest(fetchImpl, url, token);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw apiError(response.status);
  }
  return response.json();
}

// The Authorization header is added only when a token is present, so a public PR's files list
// works anonymously while every signed-in call still carries its Bearer credential.
function apiRequest(fetchImpl: typeof fetch, url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "meridian",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return withTimeout((signal) => fetchImpl(url, { headers, signal }));
}

function apiError(status: number): WebError {
  if (status === 401) {
    return new WebError(401, "GitHub rejected the session token; sign in again");
  }
  if (status === 403) {
    return new WebError(403, "GitHub API access was refused (rate limit or missing scope)");
  }
  return new WebError(502, `GitHub API request failed (status ${status})`);
}

// The message is deliberately fixed — it must never interpolate the URL or token into an error.
async function withTimeout(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } catch {
    throw new WebError(504, "GitHub request timed out or could not be reached");
  } finally {
    clearTimeout(timer);
  }
}
