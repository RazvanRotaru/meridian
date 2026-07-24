/**
 * Draft comments → the one GitHub review submission: unit comments anchor to the first changed
 * line INSIDE the unit, file comments to the file's first changed line, and anything without an
 * exact API-safe diff coordinate becomes a labeled file-level review comment. Never dropped and
 * never anchored by guesswork.
 */

import { describe, expect, it } from "vitest";
import type { ReviewContext } from "@meridian/core";
import type { PrReviewCommentSide } from "../state/prTypes";
import type { ReviewComment } from "../state/reviewTicksPref";
import type { ReviewFileRow } from "./reviewFiles";
import { buildReviewSubmission } from "./reviewSubmit";

const CONTEXT: ReviewContext = {
  changedFiles: [
    { path: "src/a.ts", status: "modified", hunks: [{ start: 25, end: 30 }, { start: 80, end: 85 }] },
    { path: "docs/readme.md", status: "deleted" },
    // A whole-file deletion's new side parses to a start-0 hunk — not a commentable line.
    { path: "src/gone.ts", status: "deleted", hunks: [{ start: 0, end: 1 }] },
  ],
  baseRef: null,
  baseSha: null,
  headRef: null,
  reviewKey: "test",
  warnings: [],
};

const FILES: ReviewFileRow[] = [
  {
    path: "src/a.ts",
    status: "modified",
    moduleId: "ts:src/a.ts",
    isTest: false,
    fingerprint: "25-30,80-85",
    blastRadius: 0,
    deletedImpact: null,
    units: [
      { nodeId: "ts:src/a.ts#Repo", displayName: "Repo", kind: "class", startLine: 10, endLine: 60, depth: 0, isTest: false, fingerprint: "f1" },
      { nodeId: "ts:src/a.ts#helper", displayName: "helper", kind: "function", startLine: 78, endLine: 90, depth: 0, isTest: false, fingerprint: "f2" },
      { nodeId: "ts:src/a.ts#drifted", displayName: "drifted", kind: "function", startLine: 100, endLine: 110, depth: 0, isTest: false, fingerprint: "f3" },
    ],
  },
  { path: "docs/readme.md", status: "deleted", moduleId: null, isTest: false, fingerprint: "whole-file", blastRadius: 0, deletedImpact: null, units: [] },
  { path: "src/gone.ts", status: "deleted", moduleId: null, isTest: false, fingerprint: "0-1", blastRadius: 0, deletedImpact: null, units: [] },
];

function draft(
  path: string,
  nodeId: string | null,
  body: string,
  anchorLabel: string | null = null,
  line: number | null = null,
  side: PrReviewCommentSide | null = line === null ? null : "RIGHT",
): ReviewComment {
  return { id: body, path, nodeId, line, side, anchorLabel, body, at: "t" };
}

describe("buildReviewSubmission", () => {
  it("anchors a unit comment to the first changed line inside the unit", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#Repo", "check this")], FILES, CONTEXT);
    // The unit starts at 10 but the hunk starts at 25 — the anchor must be a line the diff shows.
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 25, side: "RIGHT", body: "check this" }]);
    expect(submission.fileComments).toEqual([]);
  });

  it("keeps comments on base-only deleted units as file comments even when an old line number matches HEAD diff context", () => {
    const baseOnlyFiles: ReviewFileRow[] = FILES.map((file) => file.path === "src/a.ts"
      ? {
          ...file,
          units: [{
            nodeId: "ts:src/a.ts#deleted",
            displayName: "deleted",
            kind: "method",
            startLine: 25,
            endLine: 30,
            sourceSide: "base",
            depth: 0,
            isTest: false,
            fingerprint: "deleted-base-span",
          }],
        }
      : file);
    const rowDraft = draft("src/a.ts", "ts:src/a.ts#deleted", "why remove this?", "deleted");
    const lineDraft = draft("src/a.ts", "ts:src/a.ts#deleted", "old line", "deleted", 25);

    const submission = buildReviewSubmission([rowDraft, lineDraft], baseOnlyFiles, CONTEXT);

    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([
      { path: "src/a.ts", label: "deleted", body: "why remove this?" },
      { path: "src/a.ts", label: "L25", body: "old line" },
    ]);
  });

  it("clamps to the unit start when the hunk begins above it", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#helper", "hm")], FILES, CONTEXT);
    // helper spans 78..90; its overlapping hunk is 80..85 ⇒ line 80.
    expect(submission.comments[0].line).toBe(80);
  });

  it("anchors a file comment to the file's first changed line", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", null, "file note")], FILES, CONTEXT);
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 25, side: "RIGHT", body: "file note" }]);
  });

  it("honors an explicit line inside an anchorable hunk", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#Repo", "right here", "Repo", 83)], FILES, CONTEXT);
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 83, side: "RIGHT", body: "right here" }]);
  });

  it("keeps an explicit context line inline using the patch header's API-safe range", () => {
    const submission = buildReviewSubmission(
      [draft("src/a.ts", "ts:src/a.ts#helper", "right here too", "helper", 78)],
      FILES,
      CONTEXT,
      { "src/a.ts": [{ start: 77, end: 88 }] },
    );
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 78, side: "RIGHT", body: "right here too" }]);
    expect(submission.fileComments).toEqual([]);
  });

  it("anchors an exact deleted row on the LEFT side, including a whole-file deletion", () => {
    const submission = buildReviewSubmission(
      [
        draft("src/a.ts", null, "why remove this line?", null, 24, "LEFT"),
        draft("src/gone.ts", null, "why remove this file line?", null, 4, "LEFT"),
      ],
      FILES,
      CONTEXT,
      {},
      {
        diffLinesByFile: {
          "src/a.ts": [{ kind: "deleted", oldLine: 24, newLine: null, beforeNewLine: 25, text: "old line" }],
          "src/gone.ts": [{ kind: "deleted", oldLine: 4, newLine: null, beforeNewLine: 1, text: "gone" }],
        },
      },
    );

    expect(submission.comments).toEqual([
      { path: "src/a.ts", line: 24, side: "LEFT", body: "why remove this line?" },
      { path: "src/gone.ts", line: 4, side: "LEFT", body: "why remove this file line?" },
    ]);
    expect(submission.fileComments).toEqual([]);
  });

  it("demotes stale or unverified LEFT lines without losing their base-side label", () => {
    const stale = {
      ...draft("src/a.ts", null, "old revision", null, 24, "LEFT"),
      lineStale: true,
    };
    const submission = buildReviewSubmission(
      [stale, draft("src/a.ts", null, "not a deletion", null, 23, "LEFT")],
      FILES,
      CONTEXT,
      {},
      {
        diffLinesByFile: {
          "src/a.ts": [{ kind: "deleted", oldLine: 24, newLine: null, beforeNewLine: 25, text: "old line" }],
        },
      },
    );

    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([
      { path: "src/a.ts", label: "L24 · base · previous revision", body: "old revision" },
      { path: "src/a.ts", label: "L23 · base", body: "not a deletion" },
    ]);
  });

  it("resolves a graph-relative draft path to the canonical PR path before anchoring and submitting", () => {
    const aliasedContext: ReviewContext = {
      ...CONTEXT,
      changedFiles: CONTEXT.changedFiles.map((file) => file.path === "src/a.ts"
        ? { ...file, path: "packages/renderer/src/a.ts" }
        : file),
    };
    const aliasedFiles = FILES.map((file) => file.path === "src/a.ts"
      ? { ...file, path: "packages/renderer/src/a.ts" }
      : file);
    const submission = buildReviewSubmission(
      [draft("src/a.ts", "ts:src/a.ts#helper", "canonical path", "helper", 78)],
      aliasedFiles,
      aliasedContext,
      // Runtime patch-header ranges are keyed by the graph's location.file path.
      { "src/a.ts": [{ start: 77, end: 88 }] },
    );

    expect(submission.comments).toEqual([{
      path: "packages/renderer/src/a.ts",
      line: 78,
      side: "RIGHT",
      body: "canonical path",
    }]);
    expect(submission.fileComments).toEqual([]);
  });

  it("resolves a renamed file's old path to its canonical current PR path for a LEFT anchor", () => {
    const renamedContext: ReviewContext = {
      ...CONTEXT,
      changedFiles: [
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", hunks: [{ start: 20, end: 20 }] },
      ],
    };
    const renamedFiles: ReviewFileRow[] = [{
      ...FILES[0]!,
      path: "src/new.ts",
      status: "renamed",
    }];
    const submission = buildReviewSubmission(
      [draft("src/old.ts", null, "renamed deletion", null, 18, "LEFT")],
      renamedFiles,
      renamedContext,
      {},
      {
        diffLinesByFile: {
          "src/old.ts": [{ kind: "deleted", oldLine: 18, newLine: null, beforeNewLine: 20, text: "old name" }],
        },
      },
    );

    expect(submission.comments).toEqual([{
      path: "src/new.ts",
      line: 18,
      side: "LEFT",
      body: "renamed deletion",
    }]);
    expect(submission.fileComments).toEqual([]);
  });

  it("keeps a LEFT rename anchor on the pre-image owner when the old path was recreated", () => {
    const collisionContext: ReviewContext = {
      ...CONTEXT,
      changedFiles: [
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", hunks: [{ start: 20, end: 20 }] },
        { path: "src/old.ts", status: "added", hunks: [{ start: 1, end: 2 }] },
      ],
    };
    const collisionFiles: ReviewFileRow[] = [
      { ...FILES[0]!, path: "src/new.ts", status: "renamed" },
      { ...FILES[0]!, path: "src/old.ts", status: "added", moduleId: "ts:src/old.ts" },
    ];
    const submission = buildReviewSubmission(
      [draft("src/old.ts", null, "pre-image deletion", null, 18, "LEFT")],
      collisionFiles,
      collisionContext,
      {},
      {
        diffLinesByFile: {
          "src/new.ts": [{ kind: "deleted", oldLine: 18, newLine: null, beforeNewLine: 20, text: "old behavior" }],
          "src/old.ts": [{ kind: "added", oldLine: null, newLine: 1, beforeNewLine: 1, text: "new file" }],
        },
      },
    );

    expect(submission.comments).toEqual([{
      path: "src/new.ts",
      line: 18,
      side: "LEFT",
      body: "pre-image deletion",
    }]);
    expect(submission.fileComments).toEqual([]);
  });

  it("keeps a previous-revision line draft as a labeled file comment even when the same number remains API-anchorable", () => {
    const previousRevision = { ...draft("src/a.ts", null, "old L78", null, 78), lineStale: true };
    const submission = buildReviewSubmission(
      [previousRevision],
      FILES,
      CONTEXT,
      { "src/a.ts": [{ start: 77, end: 88 }] },
    );
    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([{
      path: "src/a.ts",
      label: "L78 · previous revision",
      body: "old L78",
    }]);
  });

  it("keeps a visible line outside public API diff context as a labeled file comment", () => {
    const outsideContext = draft("src/a.ts", "ts:src/a.ts#helper", "still applies", "helper", 70);
    const submission = buildReviewSubmission(
      [outsideContext],
      FILES,
      CONTEXT,
      { "src/a.ts": [{ start: 77, end: 88 }] },
    );
    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([{ path: "src/a.ts", label: "L70", body: "still applies" }]);
  });

  it("keeps a non-positive explicit line as a file comment instead of sending an invalid GitHub anchor", () => {
    const invalid = draft("src/a.ts", null, "invalid", null, 0);
    const submission = buildReviewSubmission([invalid], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([{ path: "src/a.ts", label: "L0", body: "invalid" }]);
  });

  it("keeps a comment on a hunk-less file as an anchor-labeled file comment", () => {
    const hunkless = draft("docs/readme.md", null, "why delete?", "OldUnit");
    const submission = buildReviewSubmission([hunkless], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([{ path: "docs/readme.md", label: "OldUnit", body: "why delete?" }]);
  });

  it("never anchors to a start-0 deletion hunk — a deleted file's comment becomes a file comment", () => {
    const deleted = draft("src/gone.ts", null, "farewell");
    const submission = buildReviewSubmission([deleted], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([{ path: "src/gone.ts", label: null, body: "farewell" }]);
  });

  it("keeps a vanished unit's comment as a file comment instead of guessing a line anchor", () => {
    const vanished = draft("src/a.ts", "ts:src/a.ts#gone", "stale target", "gone");
    const submission = buildReviewSubmission([vanished], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([{ path: "src/a.ts", label: "gone", body: "stale target" }]);
  });

  it("keeps a unit that no longer overlaps any hunk as a file comment", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#drifted", "moved on")], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.fileComments[0]?.body).toBe("moved on");
  });

  it("preserves the canonical PR path for an out-of-diff file comment when an alias resolves", () => {
    const aliasedContext: ReviewContext = {
      ...CONTEXT,
      changedFiles: CONTEXT.changedFiles.map((file) => file.path === "src/a.ts"
        ? { ...file, path: "packages/renderer/src/a.ts" }
        : file),
    };
    const aliasedFiles = FILES.map((file) => file.path === "src/a.ts"
      ? { ...file, path: "packages/renderer/src/a.ts" }
      : file);

    const submission = buildReviewSubmission(
      [draft("src/a.ts", "ts:src/a.ts#helper", "canonical note", "helper", 70)],
      aliasedFiles,
      aliasedContext,
      { "src/a.ts": [{ start: 77, end: 88 }] },
    );

    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([{
      path: "packages/renderer/src/a.ts",
      label: "L70",
      body: "canonical note",
    }]);
  });

  it("retains the original path for a file comment when no canonical PR path resolves", () => {
    const submission = buildReviewSubmission(
      [draft("unknown/a.ts", null, "keep location", "Unknown")],
      FILES,
      CONTEXT,
    );

    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([{ path: "unknown/a.ts", label: "Unknown", body: "keep location" }]);
  });

  it("keeps slash and literal-backslash draft paths bound to their exact GitHub files", () => {
    const literalPath = "src/a\\b.ts";
    const slashPath = "src/a/b.ts";
    const context: ReviewContext = {
      ...CONTEXT,
      changedFiles: [
        { path: literalPath, status: "modified", hunks: [{ start: 1, end: 1 }] },
        { path: slashPath, status: "modified", hunks: [{ start: 1, end: 1 }] },
      ],
    };
    const files = [literalPath, slashPath].map((path): ReviewFileRow => ({
      path,
      status: "modified",
      moduleId: null,
      isTest: false,
      units: [],
      fingerprint: path,
      blastRadius: 0,
      deletedImpact: null,
    }));

    expect(buildReviewSubmission(
      [draft(literalPath, null, "literal", null, 1)],
      files,
      context,
    ).comments).toEqual([{ path: literalPath, line: 1, side: "RIGHT", body: "literal" }]);
  });

  it("treats a prototype-named file as an own range key", () => {
    const path = "constructor";
    const context: ReviewContext = {
      ...CONTEXT,
      changedFiles: [{ path, status: "modified", hunks: [{ start: 1, end: 1 }] }],
    };
    const files: ReviewFileRow[] = [{
      path,
      status: "modified",
      moduleId: null,
      isTest: false,
      units: [],
      fingerprint: path,
      blastRadius: 0,
      deletedImpact: null,
    }];

    expect(buildReviewSubmission(
      [draft(path, null, "prototype", null, 1)],
      files,
      context,
    ).comments).toEqual([{ path, line: 1, side: "RIGHT", body: "prototype" }]);
  });

  it("keeps draft order within each list", () => {
    const submission = buildReviewSubmission(
      [draft("src/a.ts", null, "one"), draft("docs/readme.md", null, "two"), draft("src/a.ts", "ts:src/a.ts#Repo", "three")],
      FILES,
      CONTEXT,
    );
    expect(submission.comments.map((comment) => comment.body)).toEqual(["one", "three"]);
    expect(submission.fileComments.map((comment) => comment.body)).toEqual(["two"]);
  });

  it("can force every draft to a file comment when no immutable reviewed commit is available", () => {
    const submission = buildReviewSubmission(
      [
        draft("src/a.ts", null, "normally file-anchored"),
        draft("src/a.ts", "ts:src/a.ts#helper", "normally inline", "helper", 83),
        draft("src/a.ts", null, "normally deleted-line inline", null, 24, "LEFT"),
      ],
      FILES,
      CONTEXT,
      { "src/a.ts": [{ start: 77, end: 88 }] },
      { forceFileComments: true },
    );

    expect(submission.comments).toEqual([]);
    expect(submission.fileComments).toEqual([
      { path: "src/a.ts", label: null, body: "normally file-anchored" },
      { path: "src/a.ts", label: "L83", body: "normally inline" },
      { path: "src/a.ts", label: "L24 · base", body: "normally deleted-line inline" },
    ]);
  });
});
