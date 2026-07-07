/**
 * The PR-files IO path exercised through the client with a fake fetch: pagination to a short page,
 * the 3000-file cap + truncation flag, the fixed api.github.com host, and the Authorization header
 * that is present with a token but omitted for an anonymous public-PR request.
 */

import { describe, expect, it } from "vitest";
import { createGitHubClient } from "./github";

interface Call {
  url: string;
  headers: Record<string, string>;
}

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

// A fetch that serves `total` synthetic changed files, 100 per page, recording every call.
function pagedFetch(total: number, calls: Call[]): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string> });
    const perPage = Number(url.searchParams.get("per_page")) || 100;
    const start = (Number(url.searchParams.get("page")) || 1) - 1;
    const count = Math.max(0, Math.min(perPage, total - start * perPage));
    const page = Array.from({ length: count }, (_unused, i) => ({ filename: `src/f${start * perPage + i}.ts`, status: "modified" }));
    return jsonResponse(page);
  }) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch) {
  return createGitHubClient({ clientId: "Iv1.test", fetchImpl });
}

describe("fetchPullRequestFiles", () => {
  it("walks pages until a short page and returns every filename untruncated", async () => {
    const calls: Call[] = [];
    const result = await client(pagedFetch(250, calls)).fetchPullRequestFiles({ owner: "o", repo: "r", prNumber: 3, token: "gho_x" });
    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(250);
    expect(result.files[0]).toBe("src/f0.ts");
    expect(calls).toHaveLength(3); // 100 + 100 + 50
  });

  it("caps at 3000 files, flags truncation, and never fetches a 31st page", async () => {
    const calls: Call[] = [];
    const result = await client(pagedFetch(5000, calls)).fetchPullRequestFiles({ owner: "o", repo: "r", prNumber: 9, token: "gho_x" });
    expect(result.files).toHaveLength(3000);
    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(30);
  });

  it("hits the fixed api.github.com host with a Bearer header when a token is given", async () => {
    const calls: Call[] = [];
    await client(pagedFetch(1, calls)).fetchPullRequestFiles({ owner: "o", repo: "r", prNumber: 4, token: "gho_secret" });
    expect(calls[0].url.startsWith("https://api.github.com/repos/o/r/pulls/4/files")).toBe(true);
    expect(calls[0].headers.authorization).toBe("Bearer gho_secret");
  });

  it("omits the Authorization header for a public PR with no token", async () => {
    const calls: Call[] = [];
    const result = await client(pagedFetch(2, calls)).fetchPullRequestFiles({ owner: "o", repo: "r", prNumber: 4 });
    expect(result.files).toEqual(["src/f0.ts", "src/f1.ts"]);
    expect(calls[0].headers.authorization).toBeUndefined();
  });
});
