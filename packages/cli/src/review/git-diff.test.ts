/**
 * The pure, git-free half of the review diff: NUL-record parsing, extraction-root rebasing, base-ref
 * candidate order, and remote-URL normalization. The spawn plumbing itself is exercised by the live
 * smoke test, not here — these cover the string logic that turns git's raw bytes into ChangedFile[].
 */

import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "../errors";
import { normalizeRemote, parseNameStatusZ, parseUnifiedZeroHunks, rebaseToExtractionRoot, resolveBaseRef, withHunks } from "./git-diff";

const NUL = "\0";

describe("parseNameStatusZ", () => {
  it("maps A/M/D/T/U single-path records to statuses", () => {
    const output = ["A", "src/new.ts", "M", "src/mod.ts", "D", "src/gone.ts", "T", "src/typechange.ts", "U", "src/unmerged.ts"].join(NUL) + NUL;
    expect(parseNameStatusZ(output)).toEqual([
      { status: "added", path: "src/new.ts" },
      { status: "modified", path: "src/mod.ts" },
      { status: "deleted", path: "src/gone.ts" },
      { status: "modified", path: "src/typechange.ts" },
      { status: "modified", path: "src/unmerged.ts" },
    ]);
  });

  it("reads R<score> as a two-path rename keeping previousPath", () => {
    const output = ["R100", "src/old.ts", "src/new.ts"].join(NUL) + NUL;
    expect(parseNameStatusZ(output)).toEqual([{ status: "renamed", path: "src/new.ts", previousPath: "src/old.ts" }]);
  });

  it("reads C<score> as an add of the copy destination, dropping the source", () => {
    const output = ["C75", "src/orig.ts", "src/copy.ts"].join(NUL) + NUL;
    expect(parseNameStatusZ(output)).toEqual([{ status: "added", path: "src/copy.ts" }]);
  });

  it("splits mixed records and tolerates a missing trailing NUL", () => {
    const output = ["M", "a.ts", "R50", "b-old.ts", "b-new.ts", "A", "c.ts"].join(NUL);
    expect(parseNameStatusZ(output)).toEqual([
      { status: "modified", path: "a.ts" },
      { status: "renamed", path: "b-new.ts", previousPath: "b-old.ts" },
      { status: "added", path: "c.ts" },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });
});

describe("rebaseToExtractionRoot", () => {
  const files = [
    { status: "modified" as const, path: "packages/app/src/a.ts" },
    { status: "added" as const, path: "packages/app/src/b.ts" },
    { status: "modified" as const, path: "packages/other/c.ts" },
    { status: "deleted" as const, path: "README.md" },
  ];

  it("strips a subdir prefix and counts files outside the root as dropped", () => {
    const { kept, dropped } = rebaseToExtractionRoot(files, "packages/app");
    expect(kept).toEqual([
      { status: "modified", path: "src/a.ts" },
      { status: "added", path: "src/b.ts" },
    ]);
    expect(dropped).toBe(2);
  });

  it("keeps every file unchanged when the extraction root is the toplevel (empty prefix)", () => {
    const { kept, dropped } = rebaseToExtractionRoot(files, "");
    expect(kept).toEqual(files);
    expect(dropped).toBe(0);
  });

  it("rebases a rename's previousPath, and drops that field when the old path is outside the root", () => {
    const inside = rebaseToExtractionRoot([{ status: "renamed", path: "app/new.ts", previousPath: "app/old.ts" }], "app");
    expect(inside.kept).toEqual([{ status: "renamed", path: "new.ts", previousPath: "old.ts" }]);

    const outside = rebaseToExtractionRoot([{ status: "renamed", path: "app/new.ts", previousPath: "vendor/old.ts" }], "app");
    expect(outside.kept).toEqual([{ status: "renamed", path: "new.ts" }]);
  });

  it("accepts a prefix that already ends in a slash", () => {
    const { kept } = rebaseToExtractionRoot([{ status: "modified", path: "app/x.ts" }], "app/");
    expect(kept).toEqual([{ status: "modified", path: "x.ts" }]);
  });
});

describe("resolveBaseRef", () => {
  it("returns an explicit ref when it exists", async () => {
    await expect(resolveBaseRef(async (ref) => ref === "develop", "develop")).resolves.toBe("develop");
  });

  it("raises a usage error when the explicit ref is missing", async () => {
    const error = await resolveBaseRef(async () => false, "nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT.usage);
  });

  it("walks candidates in order origin/HEAD → origin/main → origin/master → main → master", async () => {
    const tried: string[] = [];
    const chosen = await resolveBaseRef(async (ref) => {
      tried.push(ref);
      return ref === "origin/master";
    });
    expect(chosen).toBe("origin/master");
    expect(tried).toEqual(["origin/HEAD", "origin/main", "origin/master"]);
  });

  it("raises a usage error when no candidate resolves", async () => {
    const error = await resolveBaseRef(async () => false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT.usage);
  });
});

describe("parseUnifiedZeroHunks", () => {
  it("extracts new-side line ranges per file", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,0 +4,2 @@ function foo() {",
      "+  const x = 1;",
      "+  const y = 2;",
      "@@ -20 +22 @@",
      "-  old",
      "+  new",
      "",
    ].join("\n");
    const map = parseUnifiedZeroHunks(patch);
    expect(map.get("src/a.ts")).toEqual([
      { start: 4, end: 5 },
      { start: 22, end: 22 },
    ]);
  });

  it("skips a whole-file deletion (/dev/null new side) but anchors a deletion-only hunk to its block", () => {
    const patch = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,5 +0,0 @@",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -10,2 +9,0 @@",
      "-  removed",
      "-  removed",
      "",
    ].join("\n");
    const map = parseUnifiedZeroHunks(patch);
    expect(map.has("gone.ts")).toBe(false);
    // A deletion sitting after new-side line 9 anchors to [9, 10] so the bordering block is attributed.
    expect(map.get("b.ts")).toEqual([{ start: 9, end: 10 }]);
  });

  it("does not mistake an added content line beginning with '++' for a file header", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -0,0 +5,1 @@",
      "+++ someVar; // a real added line, not a header",
      "@@ -20 +30 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    // Both hunks stay attributed to a.ts; the '+++ someVar' line is content, not a new section header.
    expect(parseUnifiedZeroHunks(patch).get("a.ts")).toEqual([
      { start: 5, end: 5 },
      { start: 30, end: 30 },
    ]);
  });

  it("reads a rename's new path from the +++ line", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1,2 @@",
      " unchanged",
      "+added",
      "",
    ].join("\n");
    expect(parseUnifiedZeroHunks(patch).get("new.ts")).toEqual([{ start: 1, end: 2 }]);
  });
});

describe("withHunks", () => {
  it("attaches hunks by path and leaves hunk-less files whole-file", () => {
    const files = [
      { path: "a.ts", status: "modified" as const },
      { path: "b.ts", status: "added" as const },
    ];
    const map = new Map([["a.ts", [{ start: 1, end: 2 }]]]);
    const [a, b] = withHunks(files, map);
    expect(a.hunks).toEqual([{ start: 1, end: 2 }]);
    expect(b.hunks).toBeUndefined();
  });
});

describe("normalizeRemote", () => {
  it("strips protocol, credentials, and .git, lowercasing only the host", () => {
    expect(normalizeRemote("https://x@GitHub.com/Acme/Shop.git")).toBe("github.com/Acme/Shop");
  });

  it("strips an embedded token", () => {
    expect(normalizeRemote("https://user:token123@github.com/a/b.git")).toBe("github.com/a/b");
  });

  it("handles the scp-style ssh shorthand", () => {
    expect(normalizeRemote("git@GitHub.com:acme/shop.git")).toBe("github.com/acme/shop");
  });

  it("handles an ssh:// URL and a trailing-slash bare url without .git", () => {
    expect(normalizeRemote("ssh://git@github.com/a/b.git")).toBe("github.com/a/b");
    expect(normalizeRemote("https://github.com/O/R/")).toBe("github.com/O/R");
  });
});
