import { chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changedSinceMetadata,
  parseNameStatusManifest,
  parseUnifiedDiff,
  parseUnifiedDiffWithStats,
  validatedRef,
} from "./git-diff";
import { parsePatchDetail } from "./server/github-parse";

const DIFF = [
  "diff --git a/src/orderService.ts b/src/orderService.ts",
  "index 1111111..2222222 100644",
  "--- a/src/orderService.ts",
  "+++ b/src/orderService.ts",
  "@@ -10,2 +10,3 @@ export function priceOrder(",
  "-  const subtotal = total;",
  "-  return subtotal;",
  "+  const rounded = round(total);",
  "+  return rounded;",
  "+  audit(rounded);",
  "@@ -30 +31 @@ function round(",
  "-  return Math.round(value);",
  "+  return Math.round(value * 100) / 100;",
  "diff --git a/src/removed.ts b/src/removed.ts",
  "deleted file mode 100644",
  "--- a/src/removed.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const removed = true;",
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "similarity index 90%",
  "--- a/src/old-name.ts",
  "+++ b/src/new-name.ts",
  "@@ -5,0 +6,2 @@",
  "+export const flag = true;",
  "+export const enabled = true;",
  "@@ -20,3 +22,0 @@",
  "-export const oldOne = 1;",
  "-export const oldTwo = 2;",
  "-export const oldThree = 3;",
].join("\n");

const NAME_STATUS = [
  "M", "src/orderService.ts",
  "D", "src/removed.ts",
  "R090", "src/old-name.ts", "src/new-name.ts",
  "",
].join("\0");

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseUnifiedDiff", () => {
  it("collects new-side ranges per file, keyed root-relative", () => {
    expect(parseUnifiedDiff(DIFF)["src/orderService.ts"]).toEqual([
      { start: 10, end: 12 },
      { start: 31, end: 31 },
    ]);
  });

  it("skips deleted files entirely (no new-side path to tag)", () => {
    expect(parseUnifiedDiff(DIFF)["src/removed.ts"]).toBeUndefined();
  });

  it("keys a rename by its new path and marks a pure-deletion hunk as the seam", () => {
    expect(parseUnifiedDiff(DIFF)["src/new-name.ts"]).toEqual([
      { start: 6, end: 7 },
      { start: 23, end: 23 }, // +22,0 names the preceding line; the next-row cursor is 23.
    ]);
  });

  it("clamps a deletion at the top of a file to line 1", () => {
    const top = ["+++ b/x.ts", "@@ -1,2 +0,0 @@", "-one", "-two"].join("\n");
    expect(parseUnifiedDiff(top)["x.ts"]).toEqual([{ start: 1, end: 1 }]);
  });

  it("returns an empty record for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual({});
  });
});

describe("parseUnifiedDiffWithStats", () => {
  it("collects per-file +added/-deleted totals from hunk headers", () => {
    const parsed = parseUnifiedDiffWithStats(DIFF);
    expect(parsed.stats["src/orderService.ts"]).toEqual({ added: 4, deleted: 3 });
    expect(parsed.stats["src/new-name.ts"]).toEqual({ added: 2, deleted: 3 });
  });

  it("classifies line spans as added/modified/deleted for renderer highlighting", () => {
    const parsed = parseUnifiedDiffWithStats(DIFF);
    expect(parsed.kinds["src/orderService.ts"]).toEqual([
      { start: 10, end: 11, kind: "modified" },
      { start: 12, end: 12, kind: "added" },
      { start: 31, end: 31, kind: "modified" },
    ]);
    expect(parsed.kinds["src/new-name.ts"]).toEqual([{ start: 6, end: 7, kind: "added" }]);
  });

  it("retains exact +/- rows in patch order with old/new cursor coordinates", () => {
    const rows = parseUnifiedDiffWithStats(DIFF).diffLines["src/new-name.ts"];
    expect(rows).toEqual([
      { kind: "added", oldLine: null, newLine: 6, beforeNewLine: 6, text: "export const flag = true;" },
      { kind: "added", oldLine: null, newLine: 7, beforeNewLine: 7, text: "export const enabled = true;" },
      { kind: "deleted", oldLine: 20, newLine: null, beforeNewLine: 23, text: "export const oldOne = 1;" },
      { kind: "deleted", oldLine: 21, newLine: null, beforeNewLine: 23, text: "export const oldTwo = 2;" },
      { kind: "deleted", oldLine: 22, newLine: null, beforeNewLine: 23, text: "export const oldThree = 3;" },
    ]);
  });

  it("keeps unpaired additions green after a replacement in the same hunk", () => {
    const mixedHunk = [
      "diff --git a/src/settings.ts b/src/settings.ts",
      "--- a/src/settings.ts",
      "+++ b/src/settings.ts",
      "@@ -10 +10,4 @@",
      "-const previous = true;",
      "+const current = true;",
      "+function logPatchFailure() {",
      "+  reportFailure();",
      "+}",
    ].join("\n");

    expect(parseUnifiedDiffWithStats(mixedHunk).kinds["src/settings.ts"]).toEqual([
      { start: 10, end: 10, kind: "modified" },
      { start: 11, end: 13, kind: "added" },
    ]);
  });

  it("keeps deleted-file stats and exact rows under the base path without HEAD ranges or kinds", () => {
    const parsed = parseUnifiedDiffWithStats(DIFF);
    expect(parsed.ranges["src/removed.ts"]).toBeUndefined();
    expect(parsed.stats["src/removed.ts"]).toEqual({ added: 0, deleted: 1 });
    expect(parsed.kinds["src/removed.ts"]).toBeUndefined();
    expect(parsed.diffLines["src/removed.ts"]).toEqual([
      {
        kind: "deleted",
        oldLine: 1,
        newLine: null,
        beforeNewLine: 1,
        text: "export const removed = true;",
      },
    ]);
  });

  it("decodes Git's quoted UTF-8 old-side path for a fully removed file", () => {
    const quoted = [
      "diff --git a/src/old.ts b/src/old.ts",
      '--- "a/src/\\303\\251 old.ts"',
      "+++ /dev/null",
      "@@ -4,2 +0,0 @@",
      "-export const one = 1;",
      "-export const two = 2;",
    ].join("\n");

    const parsed = parseUnifiedDiffWithStats(quoted);
    expect(parsed.ranges).toEqual({});
    expect(parsed.kinds).toEqual({});
    expect(parsed.stats).toEqual({ "src/é old.ts": { added: 0, deleted: 2 } });
    expect(parsed.diffLines["src/é old.ts"].map((row) => row.oldLine)).toEqual([4, 5]);
  });

  it("decodes Git's quoted UTF-8 new-side paths", () => {
    const quoted = [
      "diff --git a/src/x.ts b/src/x.ts",
      '+++ "b/src/\\303\\251.ts"',
      "@@ -0,0 +1 @@",
      "+export const value = 1;",
    ].join("\n");

    expect(parseUnifiedDiff(quoted)).toEqual({ "src/é.ts": [{ start: 1, end: 1 }] });
  });

  it("matches the GitHub patch parser exactly for the same file body", () => {
    const patch = [
      "@@ -8,2 +8,3 @@",
      "-old one",
      "-old two",
      "+new one",
      "+new two",
      "+added three",
      "@@ -20 +21,0 @@",
      "-removed",
    ].join("\n");
    const local = parseUnifiedDiffWithStats([
      "diff --git a/src/shared.ts b/src/shared.ts",
      "--- a/src/shared.ts",
      "+++ b/src/shared.ts",
      patch,
    ].join("\n"));
    const github = parsePatchDetail(patch);

    expect(local.ranges["src/shared.ts"]).toEqual(github.hunks);
    expect(local.kinds["src/shared.ts"]).toEqual(github.kinds);
    expect(local.diffLines["src/shared.ts"]).toEqual(github.diffLines);
    expect(local.stats["src/shared.ts"]).toEqual({ added: github.added, deleted: github.deleted });
  });
});

describe("changedSinceMetadata", () => {
  it("passes validated diff argv and a per-call timeout to an injected git executor", async () => {
    const execute = vi.fn().mockImplementation(async (_root: string, args: string[]) =>
      args.includes("--name-status") ? NAME_STATUS : DIFF,
    );
    const result = await changedSinceMetadata("/repo/subdir", "origin/main", 300_000, execute);

    expect(execute).toHaveBeenCalledWith(
      "/repo/subdir",
      [
        "diff",
        "--merge-base",
        "origin/main",
        "--relative",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames=50%",
      ],
      300_000,
    );
    expect(result.ranges["src/orderService.ts"]).toHaveLength(2);
    expect(result.diffLines["src/orderService.ts"][0]).toEqual({
      kind: "deleted",
      oldLine: 10,
      newLine: null,
      beforeNewLine: 10,
      text: "  const subtotal = total;",
    });
    expect(result.stats["src/removed.ts"]).toEqual({ added: 0, deleted: 1 });
    expect(result.diffLines["src/removed.ts"]).toHaveLength(1);
    expect(result.ranges["src/removed.ts"]).toBeUndefined();
    expect(result.kinds["src/removed.ts"]).toBeUndefined();
    expect(result.manifest).toEqual([
      { path: "src/orderService.ts", status: "modified" },
      { path: "src/removed.ts", status: "deleted" },
      { path: "src/new-name.ts", status: "renamed", previousPath: "src/old-name.ts" },
    ]);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "/repo/subdir",
      [
        "diff",
        "--merge-base",
        "origin/main",
        "--relative",
        "--name-status",
        "-z",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames=50%",
      ],
      300_000,
    );
    expect(execute).toHaveBeenNthCalledWith(
      3,
      "/repo/subdir",
      [
        "diff",
        "--merge-base",
        "origin/main",
        "--relative",
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames=50%",
      ],
      300_000,
    );
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("fails closed when a git hunk body is incomplete", async () => {
    const execute = vi.fn().mockResolvedValue("+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new");
    await expect(changedSinceMetadata("/repo", "main", 1_000, execute)).rejects.toThrow(/incomplete hunk/);
  });

  it("also validates incomplete deleted-file bodies before retaining their base metadata", async () => {
    const execute = vi.fn().mockResolvedValue([
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-only one row arrived",
    ].join("\n"));

    await expect(changedSinceMetadata("/repo", "main", 1_000, execute)).rejects.toThrow(/incomplete hunk/);
  });

  it("fails the transaction when the exact file inventory is malformed", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(DIFF)
      .mockResolvedValueOnce("M\0src/a.ts");
    await expect(changedSinceMetadata("/repo", "main", 1_000, execute)).rejects.toThrow(/final NUL/);
  });

  it("fails closed when the working tree changes between the patch and manifest reads", async () => {
    const changedPatch = DIFF.replace("audit(rounded);", "auditChanged(rounded);");
    const execute = vi.fn()
      .mockResolvedValueOnce(DIFF)
      .mockResolvedValueOnce(NAME_STATUS)
      .mockResolvedValueOnce(changedPatch);

    await expect(changedSinceMetadata("/repo", "main", 1_000, execute)).rejects.toThrow(
      /working tree changed while reading git diff metadata/,
    );
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0][1]).toEqual(execute.mock.calls[2][1]);
  });

  it("captures changes with no text hunks: pure renames, binary edits, and mode-only edits", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-manifest-"));
    temporaryDirectories.push(root);
    git(root, "init", "--quiet");
    git(root, "config", "user.name", "Meridian Test");
    git(root, "config", "user.email", "test@example.com");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/old.ts"), "export const unchanged = true;\n");
    writeFileSync(join(root, "src/gone.ts"), "export const gone = true;\n");
    writeFileSync(join(root, "src/data.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, "src/mode.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(root, "src/mode.sh"), 0o644);
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "base");

    renameSync(join(root, "src/old.ts"), join(root, "src/new.ts"));
    unlinkSync(join(root, "src/gone.ts"));
    writeFileSync(join(root, "src/data.bin"), Buffer.from([0, 1, 9, 3]));
    chmodSync(join(root, "src/mode.sh"), 0o755);
    // Stage so Git can pair the removed and new paths into a rename (plain `git diff` deliberately
    // does not include unrelated untracked files).
    git(root, "add", "-A");

    const metadata = await changedSinceMetadata(root, "HEAD");
    expect(metadata.manifest).toEqual([
      { path: "src/data.bin", status: "modified" },
      { path: "src/gone.ts", status: "deleted" },
      { path: "src/mode.sh", status: "modified" },
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
    ]);
    expect(metadata.ranges).toEqual({});
    expect(metadata.stats).toEqual({ "src/gone.ts": { added: 0, deleted: 1 } });
  });
});

describe("parseNameStatusManifest", () => {
  it("parses literal NUL-delimited paths without C-style quoting", () => {
    const odd = "src/a\tquote\"and\nline.ts";
    expect(parseNameStatusManifest([
      "A", odd,
      "T", "src/type-change",
      "R100", "src/old name.ts", "src/new name.ts",
      "D", "src/deleted.bin",
      "",
    ].join("\0"))).toEqual([
      { path: odd, status: "added" },
      { path: "src/type-change", status: "modified" },
      { path: "src/new name.ts", status: "renamed", previousPath: "src/old name.ts" },
      { path: "src/deleted.bin", status: "deleted" },
    ]);
  });

  it("returns an exact empty manifest for an empty diff", () => {
    expect(parseNameStatusManifest("")).toEqual([]);
  });

  it("rejects truncation, unknown statuses, invalid scores, duplicates, and unsafe paths", () => {
    for (const output of [
      "M\0src/a.ts",
      "X\0src/a.ts\0",
      "R101\0src/old.ts\0src/new.ts\0",
      "M\0src/a.ts\0D\0src/a.ts\0",
      "A\0../escape.ts\0",
      "A\0src\\windows.ts\0",
      "A\0/src/absolute.ts\0",
      "R100\0src/a.ts\0src/a.ts\0",
    ]) {
      expect(() => parseNameStatusManifest(output)).toThrow(/partial file manifest/);
    }
  });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

describe("validatedRef", () => {
  it("accepts branch, tag, sha and HEAD~n shapes", () => {
    for (const ref of ["main", "origin/main", "v1.2.3", "a1b2c3d", "HEAD~2", "feature/x_y-z", "HEAD^"]) {
      expect(validatedRef(ref)).toBe(ref);
    }
  });

  it("rejects refs that could parse as git options or empty input", () => {
    for (const ref of ["--output=/tmp/x", "-rf", "", "  ", "ref with space"]) {
      expect(() => validatedRef(ref)).toThrow(/looks invalid/);
    }
  });
});
