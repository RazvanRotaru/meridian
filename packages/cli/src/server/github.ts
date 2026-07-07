/**
 * The GitHub HTTP client: the only place that talks to github.com / api.github.com. Fixed hosts
 * (no user-controlled URL → no SSRF), the token travels in an Authorization header sent server-side
 * only and is never logged, and every request is time-boxed. Response *shaping* is delegated to the
 * pure parsers, so this thin IO layer — like `runGitClone` — is exercised by the live smoke test.
 */

import { WebError } from "./web-error";
import { classifyQuery, parseRepoList, parseRepoResult, parseSearchResults, parseUser } from "./github-parse";
import type { GitHubUser, RepoSummary } from "./github-parse";
import { interpretTokenResponse, parseDeviceCodeResponse, tokenRedeemBody } from "./github-auth";
import type { DeviceCode, TokenPoll } from "./github-auth";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_ROOT = "https://api.github.com";
const SCOPE = "repo";
const REQUEST_TIMEOUT_MS = 10_000;
const SEARCH_PER_PAGE = 20;
const LIST_PER_PAGE = 100;
const LIST_MAX_PAGES = 4;

export interface GitHubClient {
  requestDeviceCode(): Promise<DeviceCode>;
  redeemToken(deviceCode: string): Promise<TokenPoll>;
  getUser(token: string): Promise<GitHubUser>;
  searchRepos(token: string, query: string): Promise<RepoSummary[]>;
  listOwnRepos(token: string): Promise<RepoSummary[]>;
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
 * Every repo the token can clone — owned, invited, and organization — most recently pushed first.
 * The landing page fetches this once per sign-in and searches it client-side, so completeness
 * matters more than a tight cap; paging stops at LIST_MAX_PAGES (400 repos) as a sanity bound.
 */
async function listOwnRepos(fetchImpl: typeof fetch, token: string): Promise<RepoSummary[]> {
  const repos: RepoSummary[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      per_page: String(LIST_PER_PAGE),
      page: String(page),
      sort: "pushed",
      affiliation: "owner,collaborator,organization_member",
    });
    const batch = parseRepoList(await getApi(fetchImpl, `${API_ROOT}/user/repos?${params}`, token));
    repos.push(...batch);
    if (batch.length < LIST_PER_PAGE) {
      break;
    }
  }
  return repos;
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

async function getApi(fetchImpl: typeof fetch, url: string, token: string): Promise<unknown> {
  const response = await apiRequest(fetchImpl, url, token);
  if (!response.ok) {
    throw apiError(response.status);
  }
  return response.json();
}

async function getApiOrNull(fetchImpl: typeof fetch, url: string, token: string): Promise<unknown | null> {
  const response = await apiRequest(fetchImpl, url, token);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw apiError(response.status);
  }
  return response.json();
}

function apiRequest(fetchImpl: typeof fetch, url: string, token: string): Promise<Response> {
  return withTimeout((signal) =>
    fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "meridian",
      },
      signal,
    }),
  );
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
