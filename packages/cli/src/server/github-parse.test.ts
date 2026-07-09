/**
 * The pure api.github.com parsers. The load-bearing guarantees: an `owner/repo` (or github URL)
 * classifies as a direct lookup so a private repo always resolves, and every projection strips raw
 * fields down to a whitelist — non-https avatar URLs become null so they can never reach an `src`.
 */

import { describe, expect, it } from "vitest";
import {
  classifyQuery,
  parsePatchHunks,
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
        updated_at: "2026-07-08T12:00:00Z",
        draft: true,
        state: "open",
        body: "not forwarded",
      },
    ]);
    expect(prs).toEqual([
      { number: 7, title: "Ship PR tab", author: "daria", headRef: "feature/prs", updatedAt: "2026-07-08T12:00:00Z", draft: true, state: "open" },
    ]);
  });
});

describe("parsePullRequestFiles", () => {
  it("projects filenames and maps non-renderer statuses", () => {
    expect(
      parsePullRequestFiles([
        { filename: "src/new.ts", status: "copied", patch: "secret" },
        { filename: "src/changed.ts", status: "changed" },
        { filename: "src/weird.ts", status: "unknown" },
      ]),
    ).toEqual([
      { path: "src/new.ts", status: "added" },
      { path: "src/changed.ts", status: "modified" },
      { path: "src/weird.ts", status: "modified" },
    ]);
  });

  it("carries parsed patch hunks and the rename pre-image, but never raw patch text", () => {
    expect(
      parsePullRequestFiles([
        {
          filename: "src/a.ts",
          status: "renamed",
          previous_filename: "src/old.ts",
          patch: "@@ -1,2 +1,4 @@\n-old\n+new\n+more\n@@ -10,0 +12,2 @@\n+x\n+y\n secret-context",
        },
      ]),
    ).toEqual([
      { path: "src/a.ts", status: "renamed", previousPath: "src/old.ts", hunks: [{ start: 1, end: 4 }, { start: 12, end: 13 }] },
    ]);
  });
});

describe("parsePatchHunks", () => {
  it("reads new-side ranges from hunk headers, anchoring pure deletions to a 1-line span", () => {
    expect(
      parsePatchHunks("@@ -3,4 +3,6 @@ context\n body\n@@ -20,3 +25,0 @@\n-gone\n@@ -40 +50 @@\n+one"),
    ).toEqual([
      { start: 3, end: 8 }, // +3,6 → lines 3..8
      { start: 25, end: 26 }, // +25,0 pure deletion → anchored [25, 26]
      { start: 50, end: 50 }, // +50 (count omitted ⇒ 1) → single line 50
    ]);
  });

  it("returns no ranges for a patch with no hunk headers", () => {
    expect(parsePatchHunks("just some text, no @@ markers")).toEqual([]);
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
