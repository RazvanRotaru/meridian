/**
 * The GitHub HTTP client. Fixed-host request helpers keep tokens server-side and time-box every
 * call; response shaping is delegated to the pure whitelisting parsers.
 */

import { StringDecoder } from "node:string_decoder";

import {
  classifyQuery,
  parseBranchList,
  parseCheckRuns,
  parsePullRequestComments,
  parsePullRequestFiles,
  parsePullRequestList,
  parsePullRequestReviews,
  parseRepoList,
  parseRepoResult,
  parseSearchResults,
  parseUser,
  toPrSummary,
} from "./github-parse";
import type { GitHubUser, PrChecks, PrDiscussionResult, PrFile, PrSummary, RepoSummary } from "./github-parse";
import { interpretTokenResponse, parseDeviceCodeResponse, tokenRedeemBody } from "./github-auth";
import type { DeviceCode, TokenPoll } from "./github-auth";
import { API_ROOT, getApi, getApiOrNull, getApiPage, mutateApi, postForm, repoApi } from "./github-http";
import { asObject } from "./json-fields";
import { submitPullRequestReviewWithFetch } from "./github-review";
import type { SubmitReviewRequest, SubmitReviewResult } from "./github-review";
import { enrichPullRequestsForViewer } from "./github-pr-viewer";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const SCOPE = "repo";

/**
 * Meridian's public OAuth app registration (Device Flow enabled). A caller may override the app
 * identity, but an absent or blank override always falls back here — sign-in is never disabled.
 */
export const DEFAULT_GITHUB_CLIENT_ID = "Ov23liC6UQi42iShRkP4";

export function resolveGitHubClientId(...overrides: readonly (string | undefined)[]): string {
  for (const override of overrides) {
    const value = override?.trim();
    if (value) {
      return value;
    }
  }
  return DEFAULT_GITHUB_CLIENT_ID;
}

const SEARCH_PER_PAGE = 20;
const LIST_PER_PAGE = 100;
const LIST_MAX_PAGES = 4;
const BRANCH_PER_PAGE = 100;
const BRANCH_MAX_PAGES = 4;
const PR_PER_PAGE = 30;
const PR_FILE_PER_PAGE = 100;
const PR_FILE_CAP = 3_000;
const PR_DISCUSSION_PER_PAGE = 100;
const CHECK_RUN_PER_PAGE = 100;

export interface GitHubClient {
  requestDeviceCode(): Promise<DeviceCode>;
  redeemToken(deviceCode: string): Promise<TokenPoll>;
  getUser(token: string): Promise<GitHubUser>;
  searchRepos(token: string, query: string): Promise<RepoSummary[]>;
  listOwnRepos(token: string): Promise<RepoSummary[]>;
  listBranches(request: BranchesRequest): Promise<string[]>;
  listPullRequests(request: PullRequestsRequest): Promise<PullRequestsResult>;
  fetchPullRequestFiles(request: PullRequestFilesRequest): Promise<PullRequestFilesResult>;
  submitPullRequestReview(request: SubmitReviewRequest): Promise<SubmitReviewResult>;
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
  includeViewerStatus?: boolean;
}

export interface BranchesRequest {
  owner: string;
  repo: string;
  token?: string;
}

export interface PullRequestsResult {
  prs: PrSummary[];
  hasMore: boolean;
  viewerLogin?: string;
}

export interface PullRequestRequest {
  owner: string;
  repo: string;
  number: number;
  token?: string;
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

export interface PullRequestDiscussionRequest {
  owner: string;
  repo: string;
  prNumber: number;
  token?: string;
}

export interface PullRequestCommentMutationRequest {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  body: string;
  token: string;
}

export interface CommitChecksRequest {
  owner: string;
  repo: string;
  sha: string;
  token?: string;
}

export function createGitHubClient(config: GitHubClientConfig): GitHubClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  return {
    requestDeviceCode: () => requestDeviceCode(fetchImpl, config.clientId),
    redeemToken: (deviceCode) => redeemToken(fetchImpl, config.clientId, deviceCode),
    getUser: (token) => getUser(fetchImpl, token),
    searchRepos: (token, query) => searchRepos(fetchImpl, token, query),
    listOwnRepos: (token) => listOwnRepos(fetchImpl, token),
    listBranches: (request) => listBranches(fetchImpl, request),
    listPullRequests: (request) => listPullRequestsWithFetch(fetchImpl, request),
    fetchPullRequestFiles: (request) => fetchPullRequestFilesWithFetch(fetchImpl, request),
    submitPullRequestReview: (request) => submitPullRequestReviewWithFetch(fetchImpl, request),
  };
}

export function listPullRequests(request: PullRequestsRequest): Promise<PullRequestsResult> {
  return listPullRequestsWithFetch(globalThis.fetch, request);
}

export async function fetchPullRequest(fetchImpl: typeof fetch, request: PullRequestRequest): Promise<PrSummary> {
  const json = await getApi(fetchImpl, repoApi(request.owner, request.repo, `/pulls/${request.number}`), request.token);
  return toPrSummary(asObject(json));
}

export function fetchPullRequestFiles(request: PullRequestFilesRequest): Promise<PullRequestFilesResult> {
  return fetchPullRequestFilesWithFetch(globalThis.fetch, request);
}

export async function fetchPullRequestDiscussion(request: PullRequestDiscussionRequest): Promise<PrDiscussionResult> {
  const commentsParams = new URLSearchParams({ per_page: String(PR_DISCUSSION_PER_PAGE) });
  const reviewsParams = new URLSearchParams({ per_page: String(PR_DISCUSSION_PER_PAGE) });
  const [commentPage, reviewPage] = await Promise.all([
    getApiPage(
      globalThis.fetch,
      repoApi(request.owner, request.repo, `/pulls/${request.prNumber}/comments?${commentsParams}`),
      request.token,
    ),
    getApiPage(
      globalThis.fetch,
      repoApi(request.owner, request.repo, `/pulls/${request.prNumber}/reviews?${reviewsParams}`),
      request.token,
    ),
  ]);
  return {
    comments: parsePullRequestComments(commentPage.json),
    reviews: parsePullRequestReviews(reviewPage.json),
    hasMore: commentPage.hasNext || reviewPage.hasNext,
  };
}

export async function editPullRequestComment(request: PullRequestCommentMutationRequest): Promise<void> {
  await mutateApi(
    globalThis.fetch,
    "PATCH",
    repoApi(request.owner, request.repo, `/pulls/comments/${request.commentId}`),
    { body: request.body },
    request.token,
  );
}

export async function replyToPullRequestComment(request: PullRequestCommentMutationRequest): Promise<void> {
  await mutateApi(
    globalThis.fetch,
    "POST",
    repoApi(request.owner, request.repo, `/pulls/${request.prNumber}/comments/${request.commentId}/replies`),
    { body: request.body },
    request.token,
  );
}

export async function fetchCommitChecks(request: CommitChecksRequest): Promise<PrChecks> {
  const params = new URLSearchParams({ per_page: String(CHECK_RUN_PER_PAGE) });
  const json = await getApi(
    globalThis.fetch,
    repoApi(request.owner, request.repo, `/commits/${request.sha}/check-runs?${params}`),
    request.token,
  );
  return parseCheckRuns(json);
}

export interface FileAtRefRequest {
  owner: string;
  repo: string;
  ref: string;
  path: string;
  token?: string;
}

export interface FileAtRefResult {
  code: string;
  truncated: boolean;
  /** Number of source rows represented by `code`; zero when GitHub returned no visible content. */
  lineCount: number;
}

/** One file's text content at a git ref (the PR head), for the review code panel. */
export function fetchFileAtRef(request: FileAtRefRequest): Promise<FileAtRefResult> {
  return fetchFileAtRefWithFetch(globalThis.fetch, request);
}

const FILE_AT_REF_MAX_BYTES = 2_000_000;

async function fetchFileAtRefWithFetch(fetchImpl: typeof fetch, request: FileAtRefRequest): Promise<FileAtRefResult> {
  // GitHub's Contents API keeps the path segments as `/` (encodeURIComponent per segment) and takes
  // the ref as a query param; a private repo's fetch rides the same token as every other call here.
  const segments = request.path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const params = new URLSearchParams({ ref: request.ref });
  const json = await getApiOrNull(fetchImpl, repoApi(request.owner, request.repo, `/contents/${segments}?${params}`), request.token);
  const raw = (json as { content?: unknown; encoding?: unknown } | null) ?? null;
  if (!raw || typeof raw.content !== "string" || raw.encoding !== "base64") {
    // Files over ~1MB come back without inline content; treat as unavailable rather than guessing.
    return { code: "", truncated: true, lineCount: 0 };
  }
  const bytes = Buffer.from(raw.content, "base64");
  const capped = bytes.length > FILE_AT_REF_MAX_BYTES;
  // A raw byte cap can bisect a multibyte code point. StringDecoder retains that incomplete tail
  // instead of injecting U+FFFD into source that was valid before truncation.
  const visible = capped
    ? new StringDecoder("utf8").write(bytes.subarray(0, FILE_AT_REF_MAX_BYTES))
    : bytes.toString("utf8");
  // A complete file's final line ending terminates its last source row; it is not an additional
  // empty row. Strip exactly one LF/CRLF so intentional blank lines remain. Never do this at the
  // byte cap because that newline may precede content we did not read.
  const code = capped ? visible : stripTerminalLineEnding(visible);
  return {
    code,
    truncated: capped,
    // `code === ""` is ambiguous after stripping a complete terminal newline: empty bytes are zero
    // rows, while a file containing only `\n` is one blank row. The original byte length preserves
    // that distinction. A capped prefix is never empty and reports the rows its visible text spans.
    lineCount: code.length > 0 ? code.split("\n").length : bytes.length > 0 ? 1 : 0,
  };
}

function stripTerminalLineEnding(text: string): string {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
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

/**
 * Branches visible to the optional token. Public repositories work without authentication; a
 * session/env/gh token lets the same call reach private repositories. Pagination is bounded so a
 * repository with an extreme branch count cannot make one picker request unbounded.
 */
async function listBranches(fetchImpl: typeof fetch, request: BranchesRequest): Promise<string[]> {
  const branches: string[] = [];
  for (let page = 1; page <= BRANCH_MAX_PAGES; page++) {
    const params = new URLSearchParams({ per_page: String(BRANCH_PER_PAGE), page: String(page) });
    const result = await getApiPage(
      fetchImpl,
      repoApi(request.owner, request.repo, `/branches?${params}`),
      request.token,
    );
    branches.push(...parseBranchList(result.json));
    if (!result.hasNext) {
      break;
    }
  }
  return branches;
}

async function listPullRequestsWithFetch(fetchImpl: typeof fetch, request: PullRequestsRequest): Promise<PullRequestsResult> {
  const params = new URLSearchParams({ state: request.state, per_page: String(PR_PER_PAGE), page: String(request.page) });
  const prs = parsePullRequestList(await getApi(fetchImpl, repoApi(request.owner, request.repo, `/pulls?${params}`), request.token));
  const result = { prs, hasMore: prs.length === PR_PER_PAGE };
  if (!request.includeViewerStatus || !request.token || prs.length === 0) {
    return result;
  }
  try {
    return { ...result, ...await enrichPullRequestsForViewer(fetchImpl, request.owner, request.repo, prs, request.token) };
  } catch {
    // Personalized status is progressive enhancement: a GraphQL permission/schema failure must
    // never make the ordinary REST-backed PR picker unusable.
    return result;
  }
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
