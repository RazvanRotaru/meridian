/**
 * The GitHub HTTP client's paging behaviour for `listOwnRepos`. The load-bearing guarantees:
 * the affiliation covers org repos, a short page ends the walk (no wasted calls), and the page
 * count is bounded so a pathological account can never turn one sign-in into an unbounded crawl.
 */

import { describe, expect, it } from "vitest";
import { createGitHubClient } from "./github";

function repoPage(count: number, offset: number): unknown[] {
  return Array.from({ length: count }, (_unused, index) => ({ full_name: `org/repo-${offset + index}` }));
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
