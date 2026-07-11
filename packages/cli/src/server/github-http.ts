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

/** JSON POST to the GitHub API (the write path — reviews). Same headers/timeout as reads. */
export async function postApi(fetchImpl: typeof fetch, url: string, body: unknown, token?: string): Promise<unknown> {
  const response = await apiRequest(fetchImpl, url, token, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) {
    throw response.status === 422
      ? new WebError(422, "GitHub rejected the review (a comment may anchor outside the diff)")
      : apiError(response.status);
  }
  return response.json();
}

export function repoApi(owner: string, repo: string, path: string): string {
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
}

function apiRequest(
  fetchImpl: typeof fetch,
  url: string,
  token?: string,
  init?: { method: "POST"; body: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "meridian",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (init) {
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
