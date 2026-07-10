/**
 * The pure api.github.com parsers. The load-bearing guarantees: an `owner/repo` (or github URL)
 * classifies as a direct lookup so a private repo always resolves, and every projection strips raw
 * fields down to a whitelist — non-https avatar URLs become null so they can never reach an `src`.
 */

import { describe, expect, it } from "vitest";
import {
  classifyQuery,
  parsePatchDetail,
  parsePullRequestFiles,
  parsePullRequestList,
  parseRepoList,
  parseRepoResult,
  parseSearchResults,
  parseUser,
} from "./github-parse";

describe("classifyQuery", () => {
  it("treats owner/repo and github URLs as an exact lookup", () => {
    expect(classifyQuery("UiPath/Autopilot")).toEqual({ kind: "exact", owner: "UiPath", repo: "Autopilot" });
    expect(classifyQuery("https://github.com/UiPath/Autopilot.git")).toEqual({ kind: "exact", owner: "UiPath", repo: "Autopilot" });
  });

  it("treats free text as a fuzzy search and blank input as nothing", () => {
    expect(classifyQuery("autopilot agents")).toEqual({ kind: "search", term: "autopilot agents" });
    expect(classifyQuery("   ")).toBeNull();
  });
});

describe("parseRepoResult", () => {
  it("projects a repo to the whitelisted summary", () => {
    const repo = parseRepoResult({
      full_name: "UiPath/Autopilot",
      private: true,
      default_branch: "main",
      description: "the thing",
      owner: { avatar_url: "https://avatars.githubusercontent.com/u/1" },
    });
    expect(repo).toEqual({
      fullName: "UiPath/Autopilot",
      isPrivate: true,
      defaultBranch: "main",
      description: "the thing",
      ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1",
    });
  });

  it("drops a non-https avatar url to null", () => {
    const repo = parseRepoResult({ full_name: "o/r", owner: { avatar_url: "javascript:alert(1)" } });
    expect(repo.ownerAvatarUrl).toBeNull();
    expect(repo.isPrivate).toBe(false);
  });
});

describe("parseSearchResults", () => {
  it("maps items and caps the list at twenty", () => {
    const items = Array.from({ length: 30 }, (_unused, index) => ({ full_name: `o/r${index}` }));
    const repos = parseSearchResults({ items });
    expect(repos).toHaveLength(20);
    expect(repos[0].fullName).toBe("o/r0");
  });

  it("returns an empty list when there are no items", () => {
    expect(parseSearchResults({})).toEqual([]);
  });
});

describe("parseRepoList", () => {
  it("maps a bare array and caps the list at one page (100)", () => {
    const items = Array.from({ length: 120 }, (_unused, index) => ({ full_name: `o/r${index}` }));
    const repos = parseRepoList(items);
    expect(repos).toHaveLength(100);
    expect(repos[0].fullName).toBe("o/r0");
  });

  it("returns an empty list for a non-array body", () => {
    expect(parseRepoList({ items: [{ full_name: "o/r" }] })).toEqual([]);
  });
});

describe("parsePullRequestList", () => {
  it("projects PRs to the whitelisted renderer shape", () => {
    const prs = parsePullRequestList([
      {
        number: 7,
        title: "Ship PR tab",
        user: { login: "daria", html_url: "https://evil.example" },
        head: { ref: "feature/prs", sha: "abc" },
        base: { ref: "main", sha: "def" },
        html_url: "https://github.com/org/repo/pull/7",
        updated_at: "2026-07-08T12:00:00Z",
        draft: true,
        state: "open",
        body: "not forwarded",
      },
    ]);
    expect(prs).toEqual([
      {
        number: 7,
        title: "Ship PR tab",
        author: "daria",
        headRef: "feature/prs",
        baseRef: "main",
        updatedAt: "2026-07-08T12:00:00Z",
        draft: true,
        state: "open",
        url: "https://github.com/org/repo/pull/7",
      },
    ]);
  });

  it("drops a non-https PR url rather than forwarding it", () => {
    const [pr] = parsePullRequestList([
      {
        number: 8,
        title: "No url",
        user: { login: "x" },
        head: { ref: "h" },
        base: { ref: "main" },
        html_url: "javascript:alert(1)",
        updated_at: "2026-07-08T12:00:00Z",
        state: "open",
      },
    ]);
    expect(pr.url).toBe("");
  });
});

describe("parsePullRequestFiles", () => {
  it("projects filenames, maps non-renderer statuses, and keeps line counts", () => {
    expect(
      parsePullRequestFiles([
        { filename: "src/new.ts", status: "copied", patch: "secret", additions: 12, deletions: 0 },
        { filename: "src/changed.ts", status: "changed", additions: 3, deletions: 7 },
        { filename: "src/weird.ts", status: "unknown" },
      ]),
    ).toEqual([
      { path: "src/new.ts", status: "added", additions: 12, deletions: 0 },
      { path: "src/changed.ts", status: "modified", additions: 3, deletions: 7 },
      { path: "src/weird.ts", status: "modified", additions: 0, deletions: 0 },
    ]);
  });
});

describe("parsePatchDetail", () => {
  // U3 context, one modification (- then +, plus an extra +), a pure addition, and a pure deletion.
  const patch = [
    "@@ -10,7 +10,8 @@ class Foo {",
    " context1",
    " context2",
    " context3",
    "-  const old = 1;",
    "+  const changed = 2;",
    "+  const added = 3;",
    " context4",
    " context5",
    " context6",
    "@@ -30,6 +31,7 @@",
    " c1",
    " c2",
    " c3",
    "+  brandNew();",
    " c4",
    " c5",
    " c6",
    "@@ -50,7 +55,6 @@",
    " d1",
    " d2",
    " d3",
    "-  gone();",
    " d4",
    " d5",
    " d6",
  ].join("\n");

  it("paints only the changed body lines, not the context-padded hunk header", () => {
    const detail = parsePatchDetail(patch);
    // The modification's two new lines (13-14) are `modified`; the lone insertion (34) is `added`;
    // the pure deletion contributes NO head line to paint.
    expect(detail.kinds).toEqual([
      { start: 13, end: 14, kind: "modified" },
      { start: 34, end: 34, kind: "added" },
    ]);
  });

  it("records each hunk's old/new spans for base→head line mapping", () => {
    expect(parsePatchDetail(patch).edits).toEqual([
      { oldStart: 10, oldLines: 7, newStart: 10, newLines: 8 },
      { oldStart: 30, oldLines: 6, newStart: 31, newLines: 7 },
      { oldStart: 50, oldLines: 7, newStart: 55, newLines: 6 },
    ]);
  });

  it("marks TIGHT changed-line ranges (body, not header) so an unchanged next declaration isn't flagged", () => {
    // Header ranges would be 10-17 / 31-37 / 55-60 (context-padded) and spill into whatever follows;
    // the tight ranges are exactly the changed new-side lines + a seam where a pure deletion sat.
    expect(parsePatchDetail(patch).hunks).toEqual([
      { start: 13, end: 14 }, // the modification
      { start: 34, end: 34 }, // the lone insertion
      { start: 58, end: 58 }, // the pure deletion's seam (the line it now precedes)
    ]);
  });

  it("also emits BASE-side ranges so a base-graph review marks nodes in base coordinates", () => {
    // Same edits, on the OLD side: the modification sat at base line 13; the insertion's seam is the
    // base line it followed (33); the deletion removed base line 53. These never drift with additions.
    expect(parsePatchDetail(patch).oldHunks).toEqual([
      { start: 13, end: 13 }, // the modified base line
      { start: 33, end: 33 }, // the insertion's base seam
      { start: 53, end: 53 }, // the deleted base line
    ]);
  });
});

describe("parseUser", () => {
  it("keeps the login and an https avatar", () => {
    expect(parseUser({ login: "RazvanRotaru", avatar_url: "https://avatars.githubusercontent.com/u/2" })).toEqual({
      login: "RazvanRotaru",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
    });
  });

  it("nulls a non-https avatar", () => {
    expect(parseUser({ login: "x", avatar_url: "http://insecure/a.png" }).avatarUrl).toBeNull();
  });
});
