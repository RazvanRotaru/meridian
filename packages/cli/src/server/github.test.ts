/**
 * The GitHub HTTP client's paging behaviour for `listOwnRepos`. The load-bearing guarantees:
 * the affiliation covers org repos, a short page ends the walk (no wasted calls), and the page
 * count is bounded so a pathological account can never turn one sign-in into an unbounded crawl.
 */

import { describe, expect, it } from "vitest";
import { createGitHubClient, DEFAULT_GITHUB_CLIENT_ID, resolveGitHubClientId } from "./github";

describe("resolveGitHubClientId", () => {
  it("always resolves a usable id and preserves override precedence", () => {
    expect(resolveGitHubClientId()).toBe(DEFAULT_GITHUB_CLIENT_ID);
    expect(resolveGitHubClientId("", "  Iv1.environment  ")).toBe("Iv1.environment");
    expect(resolveGitHubClientId("Iv1.cli", "Iv1.environment")).toBe("Iv1.cli");
  });
});

function repoPage(count: number, offset: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({ full_name: `org/repo-${offset + index}` }));
}

function prPage(count: number, offset: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({
    number: offset + index + 1,
    title: `PR ${offset + index + 1}`,
    user: { login: "daria" },
    head: { ref: `branch-${offset + index + 1}` },
    updated_at: "2026-07-08T12:00:00Z",
    state: "open",
  }));
}

function filePage(count: number, offset: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({ filename: `src/file-${offset + index}.ts`, status: "modified" }));
}

function fetchReturningPages(pages: unknown[][], seenUrls: string[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    seenUrls.push(String(url));
    const body = pages[seenUrls.length - 1] ?? [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe("listOwnRepos", () => {
  it("asks for org repos too and stops after a short page", async () => {
    const seenUrls: string[] = [];
    const client = createGitHubClient({
      clientId: "Iv1.test",
      fetchImpl: fetchReturningPages([repoPage(100, 0), repoPage(3, 100)], seenUrls),
    });
    const repos = await client.listOwnRepos("token");
    expect(repos).toHaveLength(103);
    expect(repos[100].fullName).toBe("org/repo-100");
    expect(seenUrls).toHaveLength(2);
    expect(seenUrls[0]).toContain("affiliation=owner%2Ccollaborator%2Corganization_member");
    expect(seenUrls[0]).toContain("page=1");
    expect(seenUrls[1]).toContain("page=2");
  });

  it("makes a single call when the first page is short", async () => {
    const seenUrls: string[] = [];
    const client = createGitHubClient({ clientId: "Iv1.test", fetchImpl: fetchReturningPages([repoPage(2, 0)], seenUrls) });
    expect(await client.listOwnRepos("token")).toHaveLength(2);
    expect(seenUrls).toHaveLength(1);
  });

  it("never pages past the bound even when every page is full", async () => {
    const seenUrls: string[] = [];
    const fullPages = Array.from({ length: 10 }, (_unused, index) => repoPage(100, index * 100));
    const client = createGitHubClient({ clientId: "Iv1.test", fetchImpl: fetchReturningPages(fullPages, seenUrls) });
    expect(await client.listOwnRepos("token")).toHaveLength(400);
    expect(seenUrls).toHaveLength(4);
  });
});

describe("listBranches", () => {
  it("lists clone-compatible branches for a public repo without authentication", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const client = createGitHubClient({
      clientId: "Iv1.test",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify([
          { name: "main" },
          { name: "feature/branch-picker" },
          { name: "unsupported branch" },
        ]), { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.listBranches({ owner: "open-source", repo: "project" })).resolves.toEqual([
      "main",
      "feature/branch-picker",
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("/repos/open-source/project/branches?");
    expect(seen[0].url).toContain("per_page=100");
    expect(seen[0].url).toContain("page=1");
    expect(seen[0].authorization).toBeNull();
  });

  it("uses the optional token and follows GitHub branch pagination", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const pages = [[{ name: "main" }], [{ name: "release/next" }]];
    const client = createGitHubClient({
      clientId: "Iv1.test",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const index = seen.length;
        seen.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
        const headers = index === 0 ? { link: '<https://api.github.com/next>; rel="next"' } : undefined;
        return new Response(JSON.stringify(pages[index]), { status: 200, headers });
      }) as typeof fetch,
    });

    await expect(client.listBranches({ owner: "private-org", repo: "project", token: "secret" })).resolves.toEqual([
      "main",
      "release/next",
    ]);
    expect(seen.map((entry) => entry.authorization)).toEqual(["Bearer secret", "Bearer secret"]);
    expect(seen[1].url).toContain("page=2");
  });

  it("bounds branch pagination", async () => {
    let calls = 0;
    const client = createGitHubClient({
      clientId: "Iv1.test",
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify([{ name: `branch-${calls}` }]), {
          status: 200,
          headers: { link: '<https://api.github.com/next>; rel="next"' },
        });
      }) as typeof fetch,
    });

    await expect(client.listBranches({ owner: "org", repo: "project" })).resolves.toHaveLength(4);
    expect(calls).toBe(4);
  });
});

describe("listPullRequests", () => {
  it("returns hasMore when GitHub gives a full PR page", async () => {
    const seenUrls: string[] = [];
    const client = createGitHubClient({ clientId: "Iv1.test", fetchImpl: fetchReturningPages([prPage(30, 0)], seenUrls) });
    const result = await client.listPullRequests({ owner: "org", repo: "repo", state: "open", page: 2, token: "token" });
    expect(result.hasMore).toBe(true);
    expect(result.prs).toHaveLength(30);
    expect(seenUrls[0]).toContain("/repos/org/repo/pulls?");
    expect(seenUrls[0]).toContain("state=open");
    expect(seenUrls[0]).toContain("per_page=30");
    expect(seenUrls[0]).toContain("page=2");
  });

  it("stops hasMore on a short PR page", async () => {
    const seenUrls: string[] = [];
    const client = createGitHubClient({ clientId: "Iv1.test", fetchImpl: fetchReturningPages([prPage(2, 0)], seenUrls) });
    await expect(client.listPullRequests({ owner: "org", repo: "repo", state: "closed", page: 1 })).resolves.toMatchObject({ hasMore: false });
  });
});

describe("fetchPullRequestFiles", () => {
  it("caps returned files at 3000 and marks the result truncated", async () => {
    const seenUrls: string[] = [];
    const pages = Array.from({ length: 30 }, (_unused, index) => filePage(100, index * 100));
    const client = createGitHubClient({ clientId: "Iv1.test", fetchImpl: fetchReturningPages(pages, seenUrls) });
    const result = await client.fetchPullRequestFiles({ owner: "org", repo: "repo", prNumber: 42, token: "token" });
    expect(result.files).toHaveLength(3000);
    expect(result.truncated).toBe(true);
    expect(seenUrls).toHaveLength(30);
    expect(seenUrls[29]).toContain("/repos/org/repo/pulls/42/files?");
    expect(seenUrls[29]).toContain("per_page=100");
    expect(seenUrls[29]).toContain("page=30");
  });
});
