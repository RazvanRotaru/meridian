/**
 * Fixed-host GitHub HTTP helpers. Tokens only travel in server-side Authorization headers, and
 * errors never interpolate URLs or credentials.
 */

import { WebError } from "./web-error";

export const API_ROOT = "https://api.github.com";

const REQUEST_TIMEOUT_MS = 10_000;

export async function postForm(fetchImpl: typeof fetch, url: string, body: Record<string, string>): Promise<unknown> {
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

export async function getApi(fetchImpl: typeof fetch, url: string, token?: string): Promise<unknown> {
  const response = await apiRequest(fetchImpl, url, token);
  if (!response.ok) {
    throw apiError(response.status);
  }
  return response.json();
}

/** One GitHub collection page plus the only pagination metadata callers may expose. */
export async function getApiPage(
  fetchImpl: typeof fetch,
  url: string,
  token?: string,
): Promise<{ json: unknown; hasNext: boolean }> {
  const response = await apiRequest(fetchImpl, url, token);
  if (!response.ok) {
    throw apiError(response.status);
  }
  return { json: await response.json(), hasNext: linkHasNext(response.headers.get("link")) };
}

export async function getApiOrNull(fetchImpl: typeof fetch, url: string, token?: string): Promise<unknown | null> {
  const response = await apiRequest(fetchImpl, url, token);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw apiError(response.status);
  }
  return response.json();
}

/** JSON POST to the GitHub API for review creation. Same headers/timeout as reads. */
export async function postApi(fetchImpl: typeof fetch, url: string, body: unknown, token?: string): Promise<unknown> {
  const response = await apiRequest(fetchImpl, url, token, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) {
    throw response.status === 422 ? await reviewValidationError(response) : apiError(response.status);
  }
  return response.json();
}

/** Whitelisted GitHub review-validation categories. The kind drives safe recovery while the
 * message can be returned to the browser without reflecting arbitrary provider response text. */
export class GitHubReviewValidationError extends WebError {
  readonly kind: "anchor" | "pending-review" | "other";

  constructor(kind: GitHubReviewValidationError["kind"], message: string) {
    super(422, message);
    this.name = "GitHubReviewValidationError";
    this.kind = kind;
  }
}

/** JSON mutation for GitHub resources other than review creation. */
export async function mutateApi(
  fetchImpl: typeof fetch,
  method: "POST" | "PATCH",
  url: string,
  body: unknown,
  token: string,
): Promise<unknown> {
  const response = await apiRequest(fetchImpl, url, token, { method, body: JSON.stringify(body) });
  if (!response.ok) {
    throw response.status === 422 ? new WebError(422, "GitHub rejected the comment") : apiError(response.status);
  }
  return response.json();
}

/** GraphQL mutation used for review-thread features the REST create-review payload cannot express. */
export async function postGraphql(
  fetchImpl: typeof fetch,
  body: unknown,
  token: string,
): Promise<unknown> {
  const response = await apiRequest(fetchImpl, `${API_ROOT}/graphql`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw apiError(response.status);
  }
  const json = await response.json() as unknown;
  const errors = typeof json === "object" && json !== null
    ? (json as Record<string, unknown>).errors
    : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new WebError(502, "GitHub could not attach a file-level review comment");
  }
  return json;
}

/** Delete one newly-created pending review during transactional rollback. */
export async function deleteApi(fetchImpl: typeof fetch, url: string, token: string): Promise<void> {
  const response = await apiRequest(fetchImpl, url, token, { method: "DELETE" });
  if (!response.ok) {
    throw apiError(response.status);
  }
}

export function repoApi(owner: string, repo: string, path: string): string {
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
}

function apiRequest(
  fetchImpl: typeof fetch,
  url: string,
  token?: string,
  init?: { method: "POST" | "PATCH" | "DELETE"; body?: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "meridian",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return withTimeout((signal) => fetchImpl(url, { ...init, headers, signal }));
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

async function reviewValidationError(response: Response): Promise<GitHubReviewValidationError> {
  const details = await validationMessages(response);
  if (details.some((message) => /user can only have one pending review per pull request/i.test(message))) {
    return new GitHubReviewValidationError(
      "pending-review",
      "GitHub rejected the review: User can only have one pending review per pull request",
    );
  }
  if (details.some(isReviewAnchorValidation)) {
    return new GitHubReviewValidationError(
      "anchor",
      "GitHub rejected an inline comment because its line must be part of the current pull request diff",
    );
  }
  return new GitHubReviewValidationError("other", "GitHub rejected the review (validation failed)");
}

async function validationMessages(response: Response): Promise<string[]> {
  try {
    const value = await response.json() as unknown;
    if (typeof value !== "object" || value === null) {
      return [];
    }
    const record = value as Record<string, unknown>;
    const errors = Array.isArray(record.errors) ? record.errors : [];
    return [record.message, ...errors.flatMap(validationMessage)].filter((message): message is string => typeof message === "string");
  } catch {
    return [];
  }
}

function validationMessage(value: unknown): unknown[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [record.message];
}

function isReviewAnchorValidation(message: string): boolean {
  return /(?:line|start line).*(?:must be part of|is not part of).*(?:diff|hunk)/i.test(message)
    || /diff hunk (?:can(?:not|'t)|must not) be blank/i.test(message);
}

function linkHasNext(link: string | null): boolean {
  return link?.split(",").some((part) => /(?:^|;)\s*rel="?next"?(?:;|$)/i.test(part)) ?? false;
}

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
