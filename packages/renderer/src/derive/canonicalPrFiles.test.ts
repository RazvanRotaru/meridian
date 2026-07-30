import { describe, expect, it } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import type { PrChangedFile } from "../state/prTypes";
import { canonicalPrFiles } from "./canonicalPrFiles";

describe("canonicalPrFiles", () => {
  it("adds files omitted by GitHub's cap and maps deleted/renamed paths exactly", () => {
    const github: PrChangedFile[] = [{
      path: "src/kept.ts",
      status: "modified",
      additions: 99,
      deletions: 99,
      diffComplete: false,
      contextHunks: [{ start: 7, end: 13 }],
    }];
    const artifact = changedSince({
      manifest: [
        { path: "src/kept.ts", status: "modified" },
        { path: "src/gone.ts", status: "deleted" },
        { path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed" },
        { path: "assets/logo.bin", status: "modified" },
      ],
      files: {
        "src/kept.ts": [{ start: 10, end: 10 }],
        "src/gone.ts": [{ start: 1, end: 1 }],
        "src/new-name.ts": [{ start: 2, end: 2 }],
      },
      stats: {
        "src/kept.ts": { added: 1, deleted: 1 },
        "src/gone.ts": { added: 0, deleted: 2 },
        "src/new-name.ts": { added: 1, deleted: 1 },
      },
      kinds: {
        "src/kept.ts": [{ start: 10, end: 10, kind: "modified" }],
        "src/new-name.ts": [{ start: 2, end: 2, kind: "modified" }],
      },
      diffLines: {
        "src/kept.ts": [deleted(10, 10, "old"), added(10, "new")],
        "src/gone.ts": [deleted(1, 1, "one"), deleted(2, 1, "two")],
        "src/new-name.ts": [deleted(2, 2, "old"), added(2, "new")],
      },
    });

    const files = canonicalPrFiles(github, artifact);

    expect(files.map((file) => [file.path, file.status, file.previousPath])).toEqual([
      ["src/kept.ts", "modified", undefined],
      ["src/gone.ts", "removed", undefined],
      ["src/new-name.ts", "renamed", "src/old-name.ts"],
      ["assets/logo.bin", "modified", undefined],
    ]);
    expect(files[0]).toMatchObject({
      additions: 1,
      deletions: 1,
      diffComplete: true,
      hunks: [{ start: 10, end: 10 }],
      oldHunks: [{ start: 10, end: 10 }],
      edits: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 }],
      // GitHub-only U3 detail remains available for RIGHT-side comments.
      contextHunks: [{ start: 7, end: 13 }],
    });
    expect(files[1]).toMatchObject({ additions: 0, deletions: 2, diffComplete: true });
    expect(files[1].oldHunks).toEqual([{ start: 1, end: 2 }]);
    expect(files[2]).toMatchObject({ status: "renamed", diffComplete: true });
    expect(files[3]).toMatchObject({ additions: 0, deletions: 0, diffComplete: false });
  });

  it("fails closed when GitHub claims a complete patch but the local manifest has no textual rows", () => {
    const github: PrChangedFile[] = [{
      path: "src/new-name.ts",
      previousPath: "src/old-name.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
      diffComplete: true,
      diffLines: [],
    }];
    const files = canonicalPrFiles(github, changedSince({
      manifest: [{ path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed" }],
      stats: { "src/new-name.ts": { added: 0, deleted: 0 } },
    }));

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "src/new-name.ts",
      previousPath: "src/old-name.ts",
      status: "renamed",
      diffComplete: false,
    });
  });

  it("keeps a matching GitHub U3 source-comment proof on authoritative local rows", () => {
    const localRows = [deleted(8, 8, " * Old docs."), added(8, " * New docs.")];
    const githubRows = localRows.map((row) => ({
      ...row,
      sourceCommentOnly: true as const,
      sourceCommentLineOnly: true as const,
    }));
    const github: PrChangedFile[] = [{
      path: "src/docs.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      diffComplete: true,
      diffLines: githubRows,
    }];
    const artifact = changedSince({
      manifest: [{ path: "src/docs.ts", status: "modified" }],
      stats: { "src/docs.ts": { added: 1, deleted: 1 } },
      diffLines: { "src/docs.ts": localRows },
    });

    expect(canonicalPrFiles(github, artifact)[0].diffLines).toEqual(githubRows);
  });

  it("does not restore GitHub comment proof across a local non-textual file change", () => {
    const localRows = [deleted(8, 8, "# Old docs."), added(8, "# New docs.")];
    const githubRows = localRows.map((row) => ({
      ...row,
      sourceCommentOnly: true as const,
      sourceCommentLineOnly: true as const,
    }));
    const artifact = changedSince({
      manifest: [{
        path: "tools/docs.py",
        status: "modified",
        nonTextualChanges: true,
      }],
      stats: { "tools/docs.py": { added: 1, deleted: 1 } },
      diffLines: { "tools/docs.py": localRows },
    });

    expect(canonicalPrFiles([{
      path: "tools/docs.py",
      status: "modified",
      additions: 1,
      deletions: 1,
      diffComplete: true,
      diffLines: githubRows,
    }], artifact)[0].diffLines).toEqual(localRows);
  });

  it("drops a GitHub source-comment proof when canonical rows diverge", () => {
    const github: PrChangedFile[] = [{
      path: "src/docs.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      diffComplete: true,
      diffLines: [
        { ...deleted(8, 8, "different old docs"), sourceCommentOnly: true },
        { ...added(8, "different new docs"), sourceCommentOnly: true },
      ],
    }];
    const localRows = [deleted(8, 8, "canonical old docs"), added(8, "canonical new docs")];
    const artifact = changedSince({
      manifest: [{ path: "src/docs.ts", status: "modified" }],
      stats: { "src/docs.ts": { added: 1, deleted: 1 } },
      diffLines: { "src/docs.ts": localRows },
    });

    expect(canonicalPrFiles(github, artifact)[0].diffLines).toEqual(localRows);
  });

  it("treats a valid empty manifest as authoritative and falls back only when it is absent", () => {
    const github: PrChangedFile[] = [{ path: "src/api-only.ts", status: "added", additions: 1, deletions: 0 }];

    expect(canonicalPrFiles(github, changedSince({ manifest: [] }))).toEqual([]);
    expect(canonicalPrFiles(github, changedSince({ files: {} }))).toEqual(github);
  });

  it("keeps literal backslashes distinct from directory separators in prepared Git paths", () => {
    const literalBackslash = "src/a\\b.ts";
    const slashPath = "src/a/b.ts";
    const github: PrChangedFile[] = [
      { path: literalBackslash, status: "modified", additions: 9, deletions: 9 },
      { path: slashPath, status: "modified", additions: 8, deletions: 8 },
    ];
    const files = canonicalPrFiles(github, changedSince({
      manifest: [
        { path: literalBackslash, status: "modified" },
        { path: slashPath, status: "modified" },
      ],
      stats: {
        [literalBackslash]: { added: 1, deleted: 0 },
        [slashPath]: { added: 2, deleted: 0 },
      },
    }));

    expect(files.map((file) => file.path)).toEqual([literalBackslash, slashPath]);
    expect(files.map((file) => file.additions)).toEqual([1, 2]);
  });

  it("treats prototype-named manifest paths as ordinary own-key lookups", () => {
    const files = canonicalPrFiles([], changedSince({
      manifest: [
        { path: "constructor", status: "modified" },
        { path: "__proto__", status: "modified" },
      ],
      files: {},
      stats: {},
      kinds: {},
      diffLines: {},
    }));

    expect(files.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      diffComplete: file.diffComplete,
    }))).toEqual([
      { path: "constructor", additions: 0, deletions: 0, diffComplete: false },
      { path: "__proto__", additions: 0, deletions: 0, diffComplete: false },
    ]);
  });

  it("attaches PR #4123's strict prepared formatting proof to its exact canonical edit", () => {
    const path = "src/aria/app/src/lib/msg.converter.ts";
    const edit = { oldStart: 157, oldLines: 1, newStart: 157, newLines: 5 };
    const oldText =
      "  readonly convertBinary: (bytes: Uint8Array, extension: string, name: string) => Promise<string>;";
    const newText = [
      "  readonly convertBinary: (",
      "    bytes: Uint8Array,",
      "    extension: string,",
      "    name: string,",
      "  ) => Promise<string>;",
    ];
    const files = canonicalPrFiles([], changedSince({
      manifest: [{ path, status: "modified" }],
      files: { [path]: [{ start: 157, end: 161 }] },
      stats: { [path]: { added: 5, deleted: 1 } },
      kinds: {
        [path]: [
          { start: 157, end: 157, kind: "modified" },
          { start: 158, end: 161, kind: "added" },
        ],
      },
      diffLines: {
        [path]: [
          deleted(157, 157, oldText),
          ...newText.map((text, index) => added(157 + index, text)),
        ],
      },
      formattingOnly: {
        version: 1,
        edits: [{
          path,
          ...edit,
          oldRows: [{ text: oldText, noNewline: false }],
          newRows: newText.map((text) => ({ text, noNewline: false })),
        }],
      },
    }));

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      diffComplete: true,
      edits: [edit],
      formattingOnlyEdits: [edit],
    });
  });

  it("does not carry stale GitHub proof when prepared proof is unsupported", () => {
    const path = "src/a.ts";
    const github: PrChangedFile[] = [{
      path,
      status: "modified",
      additions: 1,
      deletions: 1,
      formattingOnlyEdits: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
    }];
    const files = canonicalPrFiles(github, changedSince({
      manifest: [{ path, status: "modified" }],
      files: { [path]: [{ start: 1, end: 1 }] },
      stats: { [path]: { added: 1, deleted: 1 } },
      kinds: { [path]: [{ start: 1, end: 1, kind: "modified" }] },
      diffLines: { [path]: [deleted(1, 1, "old"), added(1, "new")] },
      formattingOnly: {
        version: 2,
        edits: [{ path, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
      },
    }));

    expect(files[0]).not.toHaveProperty("formattingOnlyEdits");
  });

  it.each([
    ["row text", { text: "stale old b", noNewline: true }],
    ["no-newline marker", { text: "old b", noNewline: false }],
  ])("rejects the whole proof transaction when one %s binding is stale", (_label, staleOldRow) => {
    const pathA = "src/a.ts";
    const pathB = "src/b.ts";
    const edit = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 };
    const files = canonicalPrFiles([], changedSince({
      manifest: [
        { path: pathA, status: "modified" },
        { path: pathB, status: "modified" },
      ],
      files: {
        [pathA]: [{ start: 1, end: 1 }],
        [pathB]: [{ start: 1, end: 1 }],
      },
      stats: {
        [pathA]: { added: 1, deleted: 1 },
        [pathB]: { added: 1, deleted: 1 },
      },
      kinds: {
        [pathA]: [{ start: 1, end: 1, kind: "modified" }],
        [pathB]: [{ start: 1, end: 1, kind: "modified" }],
      },
      diffLines: {
        [pathA]: [deleted(1, 1, "old a"), added(1, "new a")],
        [pathB]: [{ ...deleted(1, 1, "old b"), noNewline: true }, added(1, "new b")],
      },
      formattingOnly: {
        version: 1,
        edits: [
          {
            path: pathA,
            ...edit,
            oldRows: [{ text: "old a", noNewline: false }],
            newRows: [{ text: "new a", noNewline: false }],
          },
          {
            path: pathB,
            ...edit,
            oldRows: [staleOldRow],
            newRows: [{ text: "new b", noNewline: false }],
          },
        ],
      },
    }));

    expect(files).toHaveLength(2);
    expect(files[0]).not.toHaveProperty("formattingOnlyEdits");
    expect(files[1]).not.toHaveProperty("formattingOnlyEdits");
  });
});

function changedSince(value: object): GraphArtifact {
  return { extensions: { changedSince: value } } as unknown as GraphArtifact;
}

function deleted(oldLine: number, beforeNewLine: number, text: string) {
  return { kind: "deleted" as const, oldLine, newLine: null, beforeNewLine, text };
}

function added(newLine: number, text: string) {
  return { kind: "added" as const, oldLine: null, newLine, beforeNewLine: newLine, text };
}
