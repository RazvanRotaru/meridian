/**
 * The pure api.github.com parsers. The load-bearing guarantees: an `owner/repo` (or github URL)
 * classifies as a direct lookup so a private repo always resolves, and every projection strips raw
 * fields down to a whitelist — non-https avatar URLs become null so they can never reach an `src`.
 */

import { describe, expect, it } from "vitest";
import {
  classifyQuery,
  parseBranchList,
  parsePatchDetail,
  parsePullRequestComments,
  parsePullRequestFiles,
  parsePullRequestList,
  parseRepoList,
  parseRepoResult,
  parseRepoSlug,
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

describe("parseRepoSlug", () => {
  it("accepts only exact owner/repo identities", () => {
    expect(parseRepoSlug(" org/repo ")).toEqual({ owner: "org", repo: "repo" });
    expect(parseRepoSlug("https://github.com/org/repo.git")).toEqual({ owner: "org", repo: "repo" });
    expect(parseRepoSlug("https://github.com/org/repo.git/")).toEqual({ owner: "org", repo: "repo" });
    expect(parseRepoSlug("repo search words")).toBeNull();
    expect(parseRepoSlug("https://example.com/org/repo")).toBeNull();
  });
});

describe("parseBranchList", () => {
  it("keeps only branch names accepted by the repository fetch path", () => {
    expect(parseBranchList([
      { name: "main" },
      { name: "feature/dropdown" },
      { name: "release-1.2" },
      { name: "feature+picker@team" },
      { name: "@" },
      { name: "bad branch" },
      { name: "bad~branch" },
      { name: "--upload-pack=evil" },
      { name: "" },
      {},
    ])).toEqual(["main", "feature/dropdown", "release-1.2", "feature+picker@team", "@"]);
  });

  it("returns nothing for a non-list response and caps one GitHub page", () => {
    expect(parseBranchList({ branches: [] })).toEqual([]);
    expect(parseBranchList(Array.from({ length: 120 }, (_unused, index) => ({ name: `branch-${index}` })))).toHaveLength(100);
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
        head: { ref: "feature/prs", sha: "abc1234" },
        base: { ref: "main", sha: "def" },
        html_url: "https://github.com/org/repo/pull/7",
        updated_at: "2026-07-08T12:00:00Z",
        draft: true,
        state: "open",
        body: "  Explain the change.  ",
      },
    ]);
    expect(prs).toEqual([
      {
        number: 7,
        title: "Ship PR tab",
        body: "Explain the change.",
        author: "daria",
        headRef: "feature/prs",
        headSha: "abc1234",
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
      { path: "src/new.ts", status: "added", additions: 12, deletions: 0, diffComplete: false },
      { path: "src/changed.ts", status: "modified", additions: 3, deletions: 7, diffComplete: false },
      { path: "src/weird.ts", status: "modified", additions: 0, deletions: 0, diffComplete: false },
    ]);
  });

  it("preserves rename identity and verifies patch completeness against GitHub totals", () => {
    const [file] = parsePullRequestFiles([{
      filename: "src/new-name.ts",
      previous_filename: "src/old-name.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      patch: "@@ -4 +4 @@\n-old\n+new",
    }]);

    expect(file.previousPath).toBe("src/old-name.ts");
    expect(file.diffComplete).toBe(true);
    expect(file.contextHunks).toEqual([{ start: 4, end: 4 }]);
    expect(file.diffLines).toEqual([
      { kind: "deleted", oldLine: 4, newLine: null, beforeNewLine: 4, text: "old" },
      { kind: "added", oldLine: null, newLine: 4, beforeNewLine: 4, text: "new" },
    ]);
  });

  it("fails closed to whole-file metadata instead of exposing a partial patch", () => {
    const [file] = parsePullRequestFiles([{
      filename: "src/truncated.ts",
      status: "modified",
      additions: 2,
      deletions: 2,
      patch: "@@ -1,2 +1,2 @@\n-old\n+new",
    }]);

    expect(file).toEqual({
      path: "src/truncated.ts",
      status: "modified",
      additions: 2,
      deletions: 2,
      diffComplete: false,
    });
  });
});

describe("parsePullRequestComments", () => {
  it("projects LEFT/RIGHT sides strictly and strips every non-whitelisted field", () => {
    expect(parsePullRequestComments([
      {
        id: 101,
        path: "src/right.ts",
        line: 12,
        side: "RIGHT",
        body: "Head-side note",
        user: { login: "mina", avatar_url: "not forwarded" },
        updated_at: "2026-07-10T09:30:00Z",
        html_url: "https://github.com/org/repo/pull/7#discussion_r1",
        raw_secret: "not forwarded",
      },
      {
        id: 102,
        in_reply_to_id: 101,
        path: "src/left.ts",
        line: 4,
        side: "LEFT",
        body: "Base-side note",
        user: { login: "lee" },
        updated_at: "2026-07-10T09:31:00Z",
      },
      {
        id: 103,
        path: "src/unknown.ts",
        line: 0,
        side: "right",
        body: "Malformed coordinates",
        user: { login: "sam" },
        updated_at: "2026-07-10T09:32:00Z",
      },
    ])).toEqual([
      {
        id: 101,
        inReplyToId: null,
        path: "src/right.ts",
        line: 12,
        side: "RIGHT",
        body: "Head-side note",
        author: "mina",
        updatedAt: "2026-07-10T09:30:00Z",
        url: "https://github.com/org/repo/pull/7#discussion_r1",
      },
      {
        id: 102,
        inReplyToId: 101,
        path: "src/left.ts",
        line: 4,
        side: "LEFT",
        body: "Base-side note",
        author: "lee",
        updatedAt: "2026-07-10T09:31:00Z",
        url: "",
      },
      {
        id: 103,
        inReplyToId: null,
        path: "src/unknown.ts",
        line: null,
        side: null,
        body: "Malformed coordinates",
        author: "sam",
        updatedAt: "2026-07-10T09:32:00Z",
        url: "",
      },
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
    // One replacement line is `modified` and the unpaired new line is `added`. A pure deletion has
    // no surviving HEAD row to paint; its graph seam lives in `hunks` only.
    expect(detail.kinds).toEqual([
      { start: 13, end: 13, kind: "modified" },
      { start: 14, end: 14, kind: "added" },
      { start: 34, end: 34, kind: "added" },
    ]);
    expect(detail.removed).toEqual([
      { afterNewLine: 12, lines: ["  const old = 1;"] },
      { afterNewLine: 57, lines: ["  gone();"] },
    ]);
    expect(detail.removedTruncated).toBe(false);
  });

  it("records each exact edit run for base→head line mapping", () => {
    expect(parsePatchDetail(patch).edits).toEqual([
      { oldStart: 13, oldLines: 1, newStart: 13, newLines: 2 },
      { oldStart: 33, oldLines: 0, newStart: 34, newLines: 1 },
      { oldStart: 53, oldLines: 1, newStart: 58, newLines: 0 },
    ]);
  });

  it("retains context-padded hunk ranges separately for GitHub commentability", () => {
    expect(parsePatchDetail(patch).contextHunks).toEqual([
      { start: 10, end: 17 },
      { start: 31, end: 37 },
      { start: 55, end: 60 },
    ]);
    expect(parsePatchDetail("@@ -1,2 +0,0 @@\n-one\n-two").contextHunks).toEqual([]);
  });

  it("marks TIGHT changed-line ranges (body, not header) so an unchanged next declaration isn't flagged", () => {
    // Header ranges would be 10-17 / 31-37 / 55-60 (context-padded) and spill into whatever follows;
    // the tight ranges are exactly the changed new-side lines + a seam where a pure deletion sat.
    expect(parsePatchDetail(patch).hunks).toEqual([
      { start: 13, end: 14 }, // the modification
      { start: 34, end: 34 }, // the lone insertion
      { start: 58, end: 58 }, // the pure deletion's seam (the line it now precedes)
    ]);
    expect(parsePatchDetail("@@ -1,2 +0,0 @@\n-one\n-two").hunks).toEqual([{ start: 1, end: 1 }]);
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

  it("retains exact changed rows in patch order", () => {
    expect(parsePatchDetail(patch).diffLines).toEqual([
      { kind: "deleted", oldLine: 13, newLine: null, beforeNewLine: 13, text: "  const old = 1;" },
      { kind: "added", oldLine: null, newLine: 13, beforeNewLine: 13, text: "  const changed = 2;" },
      { kind: "added", oldLine: null, newLine: 14, beforeNewLine: 14, text: "  const added = 3;" },
      { kind: "added", oldLine: null, newLine: 34, beforeNewLine: 34, text: "  brandNew();" },
      { kind: "deleted", oldLine: 53, newLine: null, beforeNewLine: 58, text: "  gone();" },
    ]);
  });

  it("validates hunk body counts and exposes exact +/- totals", () => {
    expect(parsePatchDetail(patch)).toMatchObject({ complete: true, added: 3, deleted: 2 });
    expect(parsePatchDetail("@@ -1,2 +1,2 @@\n-old\n+new")).toMatchObject({ complete: false, added: 1, deleted: 1 });
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
