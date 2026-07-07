/**
 * The pull-comment projection and file grouping. The load-bearing guarantees: only whitelisted
 * fields survive (a non-github/non-https html_url becomes null, never an href), malformed items
 * are skipped instead of failing the batch, and subdir grouping rebases paths onto the extraction
 * root so comment paths join against node locations.
 */

import { describe, expect, it } from "vitest";
import { groupCommentsByFile, parsePullComments } from "./github-comments";
import type { PullComment } from "./github-comments";

const RAW_COMMENT = {
  path: "src/app/x.ts",
  body: "rename this",
  line: 12,
  user: { login: "reviewer" },
  html_url: "https://github.com/o/r/pull/7#discussion_r1",
  pull_request_url: "https://api.github.com/repos/o/r/pulls/7",
  created_at: "2026-07-01T10:00:00Z",
};

describe("parsePullComments", () => {
  it("projects only the whitelisted fields", () => {
    expect(parsePullComments([RAW_COMMENT])).toEqual([
      {
        file: "src/app/x.ts",
        author: "reviewer",
        body: "rename this",
        line: 12,
        prNumber: 7,
        url: "https://github.com/o/r/pull/7#discussion_r1",
        createdAt: "2026-07-01T10:00:00Z",
      },
    ]);
  });

  it("nulls a non-github html_url (javascript:, http:, foreign host)", () => {
    const urls = ["javascript:alert(1)", "http://github.com/x", "https://evil.example/x"];
    for (const html_url of urls) {
      expect(parsePullComments([{ ...RAW_COMMENT, html_url }])[0].url).toBeNull();
    }
  });

  it("falls back to original_line for outdated anchors, else null", () => {
    expect(parsePullComments([{ ...RAW_COMMENT, line: null, original_line: 9 }])[0].line).toBe(9);
    expect(parsePullComments([{ ...RAW_COMMENT, line: null }])[0].line).toBeNull();
  });

  it("skips items without a path or body, and non-arrays entirely", () => {
    expect(parsePullComments([{ ...RAW_COMMENT, path: "" }, { ...RAW_COMMENT, body: null }, "junk", null])).toEqual([]);
    expect(parsePullComments({ message: "rate limited" })).toEqual([]);
  });
});

describe("groupCommentsByFile", () => {
  const at = (file: string): PullComment => ({
    file,
    author: "a",
    body: "b",
    line: 1,
    prNumber: null,
    url: null,
    createdAt: null,
  });

  it("groups repo-relative paths as-is without a subdir", () => {
    const grouped = groupCommentsByFile([at("src/x.ts"), at("src/x.ts"), at("y.ts")]);
    expect(Object.keys(grouped).sort()).toEqual(["src/x.ts", "y.ts"]);
    expect(grouped["src/x.ts"]).toHaveLength(2);
  });

  it("rebases onto the subdir and drops comments outside it", () => {
    const grouped = groupCommentsByFile([at("src/app/x.ts"), at("docs/readme.md")], "src/app");
    expect(grouped).toEqual({ "x.ts": [{ ...at("x.ts") }] });
  });

  it("treats '', '.', and slash-decorated subdirs as no prefix / the same prefix", () => {
    expect(Object.keys(groupCommentsByFile([at("x.ts")], "."))).toEqual(["x.ts"]);
    expect(Object.keys(groupCommentsByFile([at("src/x.ts")], "/src/"))).toEqual(["x.ts"]);
    expect(Object.keys(groupCommentsByFile([at("src/x.ts")], "src\\"))).toEqual(["x.ts"]);
  });
});
