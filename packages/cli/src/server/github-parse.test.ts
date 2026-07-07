/**
 * The pure api.github.com parsers. The load-bearing guarantees: an `owner/repo` (or github URL)
 * classifies as a direct lookup so a private repo always resolves, and every projection strips raw
 * fields down to a whitelist — non-https avatar URLs become null so they can never reach an `src`.
 */

import { describe, expect, it } from "vitest";
import {
  classifyQuery,
  parsePullRequestFiles,
  parsePullRequestUrl,
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
  it("maps a bare array and caps the list at thirty", () => {
    const items = Array.from({ length: 40 }, (_unused, index) => ({ full_name: `o/r${index}` }));
    const repos = parseRepoList(items);
    expect(repos).toHaveLength(30);
    expect(repos[0].fullName).toBe("o/r0");
  });

  it("returns an empty list for a non-array body", () => {
    expect(parseRepoList({ items: [{ full_name: "o/r" }] })).toEqual([]);
  });
});

describe("parsePullRequestUrl", () => {
  it("parses a github.com pull URL, tolerating a /files suffix and query/hash", () => {
    expect(parsePullRequestUrl("https://github.com/UiPath/Autopilot/pull/42")).toEqual({
      owner: "UiPath",
      repo: "Autopilot",
      prNumber: 42,
    });
    expect(parsePullRequestUrl("https://github.com/o/r/pull/7/files?w=1#diff")).toEqual({ owner: "o", repo: "r", prNumber: 7 });
  });

  it("rejects non-pull, non-github, and non-numeric inputs", () => {
    expect(parsePullRequestUrl("UiPath/Autopilot")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/o/r")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/o/r/pull/abc")).toBeNull();
    expect(parsePullRequestUrl("https://gitlab.com/o/r/pull/1")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/o/r/pull/0")).toBeNull();
  });
});

describe("parsePullRequestFiles", () => {
  it("keeps only filename + status and ignores attacker-controlled extra fields", () => {
    const files = parsePullRequestFiles([
      { filename: "src/a.ts", status: "modified", patch: "@@ evil @@", blob_url: "javascript:alert(1)" },
      { filename: "src/b.ts", status: "added" },
    ]);
    expect(files).toEqual([
      { filename: "src/a.ts", status: "modified" },
      { filename: "src/b.ts", status: "added" },
    ]);
  });

  it("skips non-object rows and rows without a string filename, and empties a non-array", () => {
    expect(parsePullRequestFiles([null, 3, { status: "removed" }, { filename: 5 }, { filename: "ok" }])).toEqual([
      { filename: "ok", status: "" },
    ]);
    expect(parsePullRequestFiles({ files: [] })).toEqual([]);
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
