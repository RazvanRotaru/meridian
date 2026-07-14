/**
 * Draft comments → the one GitHub review submission: unit comments anchor to the first changed
 * line INSIDE the unit, file comments to the file's first changed line, and anything without a
 * real new-side API anchor to stand on — no hunks, a whole-file-deletion hunk (start 0), a vanished
 * or drifted unit, or a visible line outside the public API's diff context — blocks the submission.
 * Never dropped, never aggregated into review-body prose, never anchored by guesswork.
 */

import { describe, expect, it } from "vitest";
import type { ReviewContext } from "@meridian/core";
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

function draft(path: string, nodeId: string | null, body: string, anchorLabel: string | null = null, line: number | null = null): ReviewComment {
  return { id: body, path, nodeId, line, anchorLabel, body, at: "t" };
}

describe("buildReviewSubmission", () => {
  it("anchors a unit comment to the first changed line inside the unit", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#Repo", "check this")], FILES, CONTEXT);
    // The unit starts at 10 but the hunk starts at 25 — the anchor must be a line the diff shows.
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 25, body: "check this" }]);
    expect(submission.blocked).toEqual([]);
  });

  it("blocks comments on base-only deleted units even when an old line number matches HEAD diff context", () => {
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
    const rowDraft = draft("src/a.ts", "ts:src/a.ts#deleted", "why remove this?");
    const lineDraft = draft("src/a.ts", "ts:src/a.ts#deleted", "old line", "deleted", 25);

    const submission = buildReviewSubmission([rowDraft, lineDraft], baseOnlyFiles, CONTEXT);

    expect(submission.comments).toEqual([]);
    expect(submission.blocked).toEqual([rowDraft, lineDraft]);
  });

  it("clamps to the unit start when the hunk begins above it", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#helper", "hm")], FILES, CONTEXT);
    // helper spans 78..90; its overlapping hunk is 80..85 ⇒ line 80.
    expect(submission.comments[0].line).toBe(80);
  });

  it("anchors a file comment to the file's first changed line", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", null, "file note")], FILES, CONTEXT);
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 25, body: "file note" }]);
  });

  it("honors an explicit line inside an anchorable hunk", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#Repo", "right here", "Repo", 83)], FILES, CONTEXT);
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 83, body: "right here" }]);
  });

  it("keeps an explicit context line inline using the patch header's API-safe range", () => {
    const submission = buildReviewSubmission(
      [draft("src/a.ts", "ts:src/a.ts#helper", "right here too", "helper", 78)],
      FILES,
      CONTEXT,
      { "src/a.ts": [{ start: 77, end: 88 }] },
    );
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 78, body: "right here too" }]);
    expect(submission.blocked).toEqual([]);
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
      body: "canonical path",
    }]);
    expect(submission.blocked).toEqual([]);
  });

  it("blocks a previous-revision line draft even when the same number remains API-anchorable", () => {
    const previousRevision = { ...draft("src/a.ts", null, "old L78", null, 78), lineStale: true };
    const submission = buildReviewSubmission(
      [previousRevision],
      FILES,
      CONTEXT,
      { "src/a.ts": [{ start: 77, end: 88 }] },
    );
    expect(submission.comments).toEqual([]);
    expect(submission.blocked).toEqual([previousRevision]);
  });

  it("blocks a visible line outside public API diff context", () => {
    const outsideContext = draft("src/a.ts", "ts:src/a.ts#helper", "still applies", "helper", 70);
    const submission = buildReviewSubmission(
      [outsideContext],
      FILES,
      CONTEXT,
      { "src/a.ts": [{ start: 77, end: 88 }] },
    );
    expect(submission.comments).toEqual([]);
    expect(submission.blocked).toEqual([outsideContext]);
  });

  it("rejects a non-positive explicit line instead of sending an invalid GitHub anchor", () => {
    const invalid = draft("src/a.ts", null, "invalid", null, 0);
    const submission = buildReviewSubmission([invalid], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.blocked).toEqual([invalid]);
  });

  it("blocks a comment on a hunk-less file", () => {
    const hunkless = draft("docs/readme.md", null, "why delete?", "OldUnit");
    const submission = buildReviewSubmission([hunkless], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.blocked).toEqual([hunkless]);
  });

  it("never anchors to a start-0 deletion hunk — a deleted file's comment blocks", () => {
    const deleted = draft("src/gone.ts", null, "farewell");
    const submission = buildReviewSubmission([deleted], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.blocked).toEqual([deleted]);
  });

  it("blocks a vanished unit's comment instead of guessing the file anchor", () => {
    const vanished = draft("src/a.ts", "ts:src/a.ts#gone", "stale target", "gone");
    const submission = buildReviewSubmission([vanished], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.blocked).toEqual([vanished]);
  });

  it("blocks a unit that no longer overlaps any hunk", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#drifted", "moved on")], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.blocked[0].body).toBe("moved on");
  });

  it("keeps draft order within each list", () => {
    const submission = buildReviewSubmission(
      [draft("src/a.ts", null, "one"), draft("docs/readme.md", null, "two"), draft("src/a.ts", "ts:src/a.ts#Repo", "three")],
      FILES,
      CONTEXT,
    );
    expect(submission.comments.map((comment) => comment.body)).toEqual(["one", "three"]);
    expect(submission.blocked.map((comment) => comment.body)).toEqual(["two"]);
  });
});
