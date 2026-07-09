/**
 * The GitHub HTTP client. Fixed-host request helpers keep tokens server-side and time-box every
 * call; response shaping is delegated to the pure whitelisting parsers.
 */

import {
  classifyQuery,
  parsePullRequestFiles,
  parsePullRequestList,
  parseRepoList,
  parseRepoResult,
  parseSearchResults,
  parseUser,
} from "./github-parse";
import type { GitHubUser, PrFile, PrSummary, RepoSummary } from "./github-parse";
import { interpretTokenResponse, parseDeviceCodeResponse, tokenRedeemBody } from "./github-auth";
import type { DeviceCode, TokenPoll } from "./github-auth";
import { API_ROOT, getApi, getApiOrNull, postForm, repoApi } from "./github-http";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const SCOPE = "repo";
const SEARCH_PER_PAGE = 20;
const LIST_PER_PAGE = 100;
const LIST_MAX_PAGES = 4;
const PR_PER_PAGE = 30;
const PR_FILE_PER_PAGE = 100;
const PR_FILE_CAP = 3_000;

export interface GitHubClient {
  requestDeviceCode(): Promise<DeviceCode>;
  redeemToken(deviceCode: string): Promise<TokenPoll>;
  getUser(token: string): Promise<GitHubUser>;
  searchRepos(token: string, query: string): Promise<RepoSummary[]>;
  listOwnRepos(token: string): Promise<RepoSummary[]>;
  listPullRequests(request: PullRequestsRequest): Promise<PullRequestsResult>;
  fetchPullRequestFiles(request: PullRequestFilesRequest): Promise<PullRequestFilesResult>;
}

export interface GitHubClientConfig {
  clientId: string;
  fetchImpl?: typeof fetch;
}

export interface PullRequestsRequest {
  owner: string;
  repo: string;
  state: "open" | "closed";
  page: number;
  token?: string;
}

export interface PullRequestsResult {
  prs: PrSummary[];
  hasMore: boolean;
}

export interface PullRequestFilesRequest {
  owner: string;
  repo: string;
  prNumber: number;
  token?: string;
}

export interface PullRequestFilesResult {
  files: PrFile[];
  truncated: boolean;
}

export function createGitHubClient(config: GitHubClientConfig): GitHubClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  return {
    requestDeviceCode: () => requestDeviceCode(fetchImpl, config.clientId),
    redeemToken: (deviceCode) => redeemToken(fetchImpl, config.clientId, deviceCode),
    getUser: (token) => getUser(fetchImpl, token),
    searchRepos: (token, query) => searchRepos(fetchImpl, token, query),
    listOwnRepos: (token) => listOwnRepos(fetchImpl, token),
    listPullRequests: (request) => listPullRequestsWithFetch(fetchImpl, request),
    fetchPullRequestFiles: (request) => fetchPullRequestFilesWithFetch(fetchImpl, request),
  };
}

export function listPullRequests(request: PullRequestsRequest): Promise<PullRequestsResult> {
  return listPullRequestsWithFetch(globalThis.fetch, request);
}

export function fetchPullRequestFiles(request: PullRequestFilesRequest): Promise<PullRequestFilesResult> {
  return fetchPullRequestFilesWithFetch(globalThis.fetch, request);
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

async function listPullRequestsWithFetch(fetchImpl: typeof fetch, request: PullRequestsRequest): Promise<PullRequestsResult> {
  const params = new URLSearchParams({ state: request.state, per_page: String(PR_PER_PAGE), page: String(request.page) });
  const prs = parsePullRequestList(await getApi(fetchImpl, repoApi(request.owner, request.repo, `/pulls?${params}`), request.token));
  return { prs, hasMore: prs.length === PR_PER_PAGE };
}

async function fetchPullRequestFilesWithFetch(fetchImpl: typeof fetch, request: PullRequestFilesRequest): Promise<PullRequestFilesResult> {
  const files: PrFile[] = [];
  for (let page = 1; files.length < PR_FILE_CAP; page++) {
    const params = new URLSearchParams({ per_page: String(PR_FILE_PER_PAGE), page: String(page) });
    const batch = parsePullRequestFiles(await getApi(fetchImpl, repoApi(request.owner, request.repo, `/pulls/${request.prNumber}/files?${params}`), request.token));
    files.push(...batch.slice(0, PR_FILE_CAP - files.length));
    if (batch.length < PR_FILE_PER_PAGE) {
      return { files, truncated: false };
    }
  }
  return { files, truncated: true };
}
