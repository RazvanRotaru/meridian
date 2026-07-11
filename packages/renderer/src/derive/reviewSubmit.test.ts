/**
 * Draft comments → the one GitHub review submission: unit comments anchor to the first changed
 * line INSIDE the unit, file comments to the file's first changed line, and anything without a
 * real diff line to stand on — no hunks, a whole-file-deletion hunk (start 0), a vanished or
 * drifted unit — becomes a NOTE for the server to fold into the review body. Never dropped,
 * never anchored by guesswork.
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
    fingerprint: "25-30,80-85",
    blastRadius: 0,
    deletedImpact: null,
    units: [
      { nodeId: "ts:src/a.ts#Repo", displayName: "Repo", kind: "class", startLine: 10, endLine: 60, depth: 0, isTest: false, fingerprint: "f1" },
      { nodeId: "ts:src/a.ts#helper", displayName: "helper", kind: "function", startLine: 78, endLine: 90, depth: 0, isTest: false, fingerprint: "f2" },
      { nodeId: "ts:src/a.ts#drifted", displayName: "drifted", kind: "function", startLine: 100, endLine: 110, depth: 0, isTest: false, fingerprint: "f3" },
    ],
  },
  { path: "docs/readme.md", status: "deleted", moduleId: null, fingerprint: "whole-file", blastRadius: 0, deletedImpact: null, units: [] },
  { path: "src/gone.ts", status: "deleted", moduleId: null, fingerprint: "0-1", blastRadius: 0, deletedImpact: null, units: [] },
];

function draft(path: string, nodeId: string | null, body: string, anchorLabel: string | null = null, line: number | null = null): ReviewComment {
  return { id: body, path, nodeId, line, anchorLabel, body, at: "t" };
}

describe("buildReviewSubmission", () => {
  it("anchors a unit comment to the first changed line inside the unit", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#Repo", "check this")], FILES, CONTEXT);
    // The unit starts at 10 but the hunk starts at 25 — the anchor must be a line the diff shows.
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 25, body: "check this" }]);
    expect(submission.notes).toEqual([]);
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

  it("honors an explicit line when it is still inside an anchorable hunk", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#Repo", "right here", "Repo", 83)], FILES, CONTEXT);
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 83, body: "right here" }]);
  });

  it("falls back to the unit heuristic when an explicit line drifted outside the hunks", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#helper", "still applies", "helper", 200)], FILES, CONTEXT);
    expect(submission.comments).toEqual([{ path: "src/a.ts", line: 80, body: "still applies" }]);
  });

  it("turns a comment on a hunk-less file into a note, keeping its anchor label", () => {
    const submission = buildReviewSubmission([draft("docs/readme.md", null, "why delete?", "OldUnit")], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.notes).toEqual([{ path: "docs/readme.md", label: "OldUnit", body: "why delete?" }]);
  });

  it("never anchors to a start-0 deletion hunk — a deleted file's comment folds", () => {
    const submission = buildReviewSubmission([draft("src/gone.ts", null, "farewell")], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.notes).toEqual([{ path: "src/gone.ts", label: null, body: "farewell" }]);
  });

  it("folds a vanished unit's comment instead of guessing the file anchor", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#gone", "stale target", "gone")], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.notes).toEqual([{ path: "src/a.ts", label: "gone", body: "stale target" }]);
  });

  it("folds a unit that no longer overlaps any hunk", () => {
    const submission = buildReviewSubmission([draft("src/a.ts", "ts:src/a.ts#drifted", "moved on")], FILES, CONTEXT);
    expect(submission.comments).toEqual([]);
    expect(submission.notes[0].body).toBe("moved on");
  });

  it("keeps draft order within each list", () => {
    const submission = buildReviewSubmission(
      [draft("src/a.ts", null, "one"), draft("docs/readme.md", null, "two"), draft("src/a.ts", "ts:src/a.ts#Repo", "three")],
      FILES,
      CONTEXT,
    );
    expect(submission.comments.map((comment) => comment.body)).toEqual(["one", "three"]);
    expect(submission.notes.map((note) => note.body)).toEqual(["two"]);
  });
});
