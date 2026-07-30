import { describe, expect, it } from "vitest";
import type { ChangedDiffLine } from "@meridian/core";
import type { LineEdit, PrChangedFile } from "../state/prTypes";
import { exactPrDiffMetadata, filterFormattingOnlyPrFiles } from "./formattingOnlyPrFiles";

describe("filterFormattingOnlyPrFiles", () => {
  it("excludes PR #4123's complete one-line to five-line signature rewrap", () => {
    const edit = { oldStart: 157, oldLines: 1, newStart: 157, newLines: 5 };
    const rows: ChangedDiffLine[] = [
      deleted(
        157,
        157,
        "  readonly convertBinary: (bytes: Uint8Array, extension: string, name: string) => Promise<{ markdown: string; images: readonly MsgNativeAttachment[] } | null>;",
      ),
      added(157, "  readonly convertBinary: ("),
      added(158, "    bytes: Uint8Array,"),
      added(159, "    extension: string,"),
      added(160, "    name: string,"),
      added(
        161,
        "  ) => Promise<{ markdown: string; images: readonly MsgNativeAttachment[] } | null>;",
      ),
    ];
    const file = completeFile("src/aria/app/src/lib/msg.converter.ts", rows, [edit], [edit]);
    const before = structuredClone(file);

    expect(filterFormattingOnlyPrFiles([file], true)).toEqual([]);
    expect(file).toEqual(before);
  });

  it("removes one proven formatting run but retains and recomputes a later semantic run", () => {
    const formatting = { oldStart: 157, oldLines: 1, newStart: 157, newLines: 5 };
    const semantic = { oldStart: 170, oldLines: 1, newStart: 174, newLines: 1 };
    const formattingRows: ChangedDiffLine[] = [
      deleted(157, 157, "  readonly convertBinary: (bytes: Uint8Array) => Promise<string>;"),
      added(157, "  readonly convertBinary: ("),
      added(158, "    bytes: Uint8Array,"),
      added(159, "    extension: string,"),
      added(160, "    name: string,"),
      added(161, "  ) => Promise<string>;"),
    ];
    const semanticRows = [
      deleted(170, 174, "  readonly convertText: (text: string) => string;"),
      added(174, "  readonly convertText: (text: string) => Promise<string>;"),
    ];
    const file = completeFile(
      "src/converter.ts",
      [...formattingRows, ...semanticRows],
      [formatting, semantic],
      [formatting],
    );
    const before = structuredClone(file);

    const result = filterFormattingOnlyPrFiles([file], true);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      path: "src/converter.ts",
      additions: 1,
      deletions: 1,
      hunks: [{ start: 174, end: 174 }],
      oldHunks: [{ start: 170, end: 170 }],
      edits: [semantic],
      kinds: [{ start: 174, end: 174, kind: "modified" }],
      diffLines: semanticRows,
    });
    expect(result[0]).not.toBe(file);
    expect(result[0].contextHunks).toBe(file.contextHunks);
    expect(result[0].removed).toBe(file.removed);
    expect(file).toEqual(before);
  });

  it("leaves raw files untouched when disabled", () => {
    const edit = { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 };
    const file = completeFile(
      "src/a.ts",
      [deleted(3, 3, "old"), added(3, "new")],
      [edit],
      [edit],
    );

    const input = [file];
    const result = filterFormattingOnlyPrFiles(input, false);

    expect(result).toEqual([file]);
    expect(result).not.toBe(input);
    expect(result[0]).toBe(file);
  });

  it.each([
    ["added file", { status: "added" as const }],
    ["removed file", { status: "removed" as const }],
    ["renamed file", { status: "renamed" as const, previousPath: "src/old.ts" }],
    ["incomplete body", { diffComplete: false }],
  ])("fails open for an unsupported %s", (_label, override) => {
    const edit = { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 };
    const file = {
      ...completeFile("src/a.ts", [deleted(3, 3, "old"), added(3, "new")], [edit], [edit]),
      ...override,
    };

    const result = filterFormattingOnlyPrFiles([file], true);
    expect(result).toEqual([file]);
    expect(result[0]).toBe(file);
  });

  it("fails open when proof names only part of an actual run", () => {
    const complete = { oldStart: 10, oldLines: 1, newStart: 10, newLines: 5 };
    const partial = { oldStart: 10, oldLines: 1, newStart: 10, newLines: 4 };
    const rows = [
      deleted(10, 10, "old"),
      added(10, "new one"),
      added(11, "new two"),
      added(12, "new three"),
      added(13, "new four"),
      added(14, "new five"),
    ];
    const file = completeFile("src/a.ts", rows, [complete], [partial]);

    const result = filterFormattingOnlyPrFiles([file], true);
    expect(result).toEqual([file]);
    expect(result[0]).toBe(file);
  });

  it("fails open when stored structural metadata disagrees with the exact rows", () => {
    const edit = { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 };
    const file = completeFile(
      "src/a.ts",
      [deleted(10, 10, "old"), added(10, "new")],
      [edit],
      [edit],
    );
    file.hunks = [{ start: 10, end: 11 }];

    const result = filterFormattingOnlyPrFiles([file], true);
    expect(result).toEqual([file]);
    expect(result[0]).toBe(file);
  });

  it("recomputes pure insertion/deletion seams and changed kinds for retained runs", () => {
    const formatting = { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 };
    const insertion = { oldStart: 5, oldLines: 0, newStart: 5, newLines: 2 };
    const deletion = { oldStart: 10, oldLines: 2, newStart: 12, newLines: 0 };
    const rows = [
      deleted(2, 2, "old format"),
      added(2, "new format"),
      added(5, "semantic one"),
      added(6, "semantic two"),
      deleted(10, 12, "remove one"),
      deleted(11, 12, "remove two"),
    ];
    const file = completeFile("src/a.ts", rows, [formatting, insertion, deletion], [formatting]);

    expect(filterFormattingOnlyPrFiles([file], true)[0]).toMatchObject({
      additions: 2,
      deletions: 2,
      hunks: [{ start: 5, end: 6 }, { start: 12, end: 12 }],
      oldHunks: [{ start: 5, end: 5 }, { start: 10, end: 11 }],
      edits: [insertion, deletion],
      kinds: [{ start: 5, end: 6, kind: "added" }],
    });
  });
});

function completeFile(
  path: string,
  diffLines: ChangedDiffLine[],
  edits: LineEdit[],
  formattingOnlyEdits: LineEdit[],
): PrChangedFile {
  const metadata = exactPrDiffMetadata(diffLines, edits);
  if (metadata === null) {
    throw new Error("invalid test diff");
  }
  return {
    path,
    status: "modified",
    additions: metadata.additions,
    deletions: metadata.deletions,
    hunks: metadata.hunks,
    oldHunks: metadata.oldHunks,
    edits: metadata.edits,
    kinds: metadata.kinds,
    diffLines: metadata.diffLines,
    diffComplete: true,
    formattingOnlyEdits,
    contextHunks: [{ start: 1, end: 200 }],
    removed: [],
    removedTruncated: false,
  };
}

function deleted(oldLine: number, beforeNewLine: number, text: string): ChangedDiffLine {
  return { kind: "deleted", oldLine, newLine: null, beforeNewLine, text };
}

function added(newLine: number, text: string): ChangedDiffLine {
  return { kind: "added", oldLine: null, newLine, beforeNewLine: newLine, text };
}
