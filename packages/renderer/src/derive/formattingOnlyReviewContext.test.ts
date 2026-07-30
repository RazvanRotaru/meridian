import { describe, expect, it } from "vitest";
import { computeAffectedNodes } from "@meridian/core";
import type { ChangedDiffLine, GraphArtifact, GraphNode, ReviewContext } from "@meridian/core";
import { filterFormattingOnlyReviewContext } from "./formattingOnlyReviewContext";
import { exactPrDiffMetadata } from "./formattingOnlyPrFiles";

describe("filterFormattingOnlyReviewContext", () => {
  it("drops an artifact review file whose complete edit is proven formatting-only", () => {
    const context = reviewContext([
      { path: "src/converter.ts", status: "modified", hunks: [{ start: 157, end: 161 }] },
    ]);
    const artifact = changedArtifact({
      edits: [{ oldStart: 157, oldLines: 1, newStart: 157, newLines: 5 }],
      formattingOnlyEdits: [{ oldStart: 157, oldLines: 1, newStart: 157, newLines: 5 }],
      rows: [
        deleted(157, 157, "  readonly convertBinary: (bytes: Uint8Array) => Promise<string>;"),
        added(157, "  readonly convertBinary: ("),
        added(158, "    bytes: Uint8Array,"),
        added(159, "    extension: string,"),
        added(160, "    name: string,"),
        added(161, "  ) => Promise<string>;"),
      ],
    });

    expect(filterFormattingOnlyReviewContext(context, artifact, true)).toEqual({
      ...context,
      changedFiles: [],
    });
    expect(filterFormattingOnlyReviewContext(context, artifact, false)).toBe(context);
  });

  it("retains only HEAD-coordinate semantic hunks when an earlier rewrap shifted the file", () => {
    const context = reviewContext([
      {
        path: "src/converter.ts",
        status: "modified",
        hunks: [{ start: 157, end: 161 }, { start: 174, end: 174 }],
        oldHunks: [{ start: 157, end: 157 }, { start: 170, end: 170 }],
      },
    ]);
    const artifact = changedArtifact({
      edits: [
        { oldStart: 157, oldLines: 1, newStart: 157, newLines: 5 },
        { oldStart: 170, oldLines: 1, newStart: 174, newLines: 1 },
      ],
      formattingOnlyEdits: [{ oldStart: 157, oldLines: 1, newStart: 157, newLines: 5 }],
      rows: [
        deleted(157, 157, "  readonly convertBinary: (bytes: Uint8Array) => Promise<string>;"),
        added(157, "  readonly convertBinary: ("),
        added(158, "    bytes: Uint8Array,"),
        added(159, "    extension: string,"),
        added(160, "    name: string,"),
        added(161, "  ) => Promise<string>;"),
        deleted(170, 174, "  readonly convertText: (text: string) => string;"),
        added(174, "  readonly convertText: (text: string) => Promise<string>;"),
      ],
    });

    const filtered = filterFormattingOnlyReviewContext(context, artifact, true);
    expect(filtered.changedFiles).toEqual([
      {
        path: "src/converter.ts",
        status: "modified",
        hunks: [{ start: 174, end: 174 }],
      },
    ]);
    const moduleId = "ts:src/converter.ts";
    const oldCoordinateId = `${moduleId}#oldCoordinate`;
    const semanticId = `${moduleId}#convertText`;
    const nodes: GraphNode[] = [
      graphNode(moduleId, "module", 1, 220, null),
      graphNode(oldCoordinateId, "method", 170, 170, moduleId),
      graphNode(semanticId, "method", 174, 174, moduleId),
    ];
    expect(computeAffectedNodes(nodes, filtered.changedFiles).map((entry) => entry.nodeId)).toEqual([
      semanticId,
    ]);
  });

  it("fails open when proof metadata is absent or disagrees with review status", () => {
    const context = reviewContext([{ path: "src/converter.ts", status: "added" }]);
    const artifact = changedArtifact({
      edits: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }],
      formattingOnlyEdits: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }],
      rows: [deleted(3, 3, "old"), added(3, "new")],
    });

    expect(filterFormattingOnlyReviewContext(context, artifact, true)).toBe(context);
    expect(filterFormattingOnlyReviewContext(context, { extensions: {} }, true)).toBe(context);
  });

  it("fails open when artifact review hunks do not match the proven diff transaction", () => {
    const context = reviewContext([
      { path: "src/converter.ts", status: "modified", hunks: [{ start: 200, end: 200 }] },
    ]);
    const artifact = changedArtifact({
      edits: [{ oldStart: 157, oldLines: 1, newStart: 157, newLines: 5 }],
      formattingOnlyEdits: [{ oldStart: 157, oldLines: 1, newStart: 157, newLines: 5 }],
      rows: [
        deleted(157, 157, "  readonly convertBinary: (bytes: Uint8Array) => Promise<string>;"),
        added(157, "  readonly convertBinary: ("),
        added(158, "    bytes: Uint8Array,"),
        added(159, "    extension: string,"),
        added(160, "    name: string,"),
        added(161, "  ) => Promise<string>;"),
      ],
    });

    expect(filterFormattingOnlyReviewContext(context, artifact, true)).toBe(context);
  });
});

function reviewContext(changedFiles: ReviewContext["changedFiles"]): ReviewContext {
  return {
    changedFiles,
    baseRef: "main",
    baseSha: "base",
    headRef: "feature",
    reviewKey: "repo|feature|main",
    warnings: ["kept"],
  };
}

function changedArtifact(input: {
  edits: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number }>;
  formattingOnlyEdits: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number }>;
  rows: ChangedDiffLine[];
}): Pick<GraphArtifact, "extensions"> {
  const metadata = exactPrDiffMetadata(input.rows, input.edits);
  if (metadata === null) {
    throw new Error("invalid test diff");
  }
  return {
    extensions: {
      changedSince: {
        manifest: [{ path: "src/converter.ts", status: "modified" }],
        files: { "src/converter.ts": metadata.hunks },
        stats: {
          "src/converter.ts": {
            added: input.rows.filter((row) => row.kind === "added").length,
            deleted: input.rows.filter((row) => row.kind === "deleted").length,
          },
        },
        kinds: { "src/converter.ts": metadata.kinds },
        diffLines: { "src/converter.ts": input.rows },
        formattingOnly: {
          version: 1,
          edits: input.formattingOnlyEdits.map((edit) => ({
            path: "src/converter.ts",
            ...edit,
            oldRows: input.rows
              .filter((row) => row.kind === "deleted"
                && row.oldLine! >= edit.oldStart
                && row.oldLine! < edit.oldStart + edit.oldLines)
              .map((row) => ({ text: row.text, noNewline: row.noNewline === true })),
            newRows: input.rows
              .filter((row) => row.kind === "added"
                && row.newLine! >= edit.newStart
                && row.newLine! < edit.newStart + edit.newLines)
              .map((row) => ({ text: row.text, noNewline: row.noNewline === true })),
          })),
        },
      },
    } as unknown as GraphArtifact["extensions"],
  };
}

function deleted(oldLine: number, beforeNewLine: number, text: string): ChangedDiffLine {
  return { kind: "deleted", oldLine, newLine: null, beforeNewLine, text };
}

function added(newLine: number, text: string): ChangedDiffLine {
  return { kind: "added", oldLine: null, newLine, beforeNewLine: newLine, text };
}

function graphNode(
  id: string,
  kind: string,
  startLine: number,
  endLine: number,
  parentId: string | null,
): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id.split("#").at(-1) ?? id,
    parentId,
    location: {
      file: "src/converter.ts",
      startLine,
      endLine,
    },
  };
}
