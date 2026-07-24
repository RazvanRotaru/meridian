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
        "src/kept.ts": [deleted(8, 10, "old"), added(10, "new")],
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
      oldHunks: [{ start: 8, end: 8 }],
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
