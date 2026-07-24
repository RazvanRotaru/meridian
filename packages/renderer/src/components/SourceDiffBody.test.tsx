import { renderToStaticMarkup } from "react-dom/server";
import type { GraphArtifact, GraphNode } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import type { BlueprintState, CodeView } from "../state/store";
import { createBlueprintStore } from "../state/store";
import { StoreProvider } from "../state/StoreContext";
import type { CodeDiffLine } from "./CodeBlock";
import {
  diffLinesWithinSlice,
  githubLineCommentScopeNote,
  SourceDiffBody,
  sourceDiffInstanceKey,
  useSourceDiffModel,
} from "./SourceDiffBody";

const FILE = "src/review.ts";
const NODE: GraphNode = {
  id: "ts:src/review.ts#reviewTarget",
  kind: "function",
  qualifiedName: "reviewTarget",
  displayName: "reviewTarget",
  parentId: null,
  location: { file: FILE, startLine: 1, endLine: 40 },
};
const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-14T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [NODE],
  edges: [],
};
const REPLACEMENT: CodeDiffLine[] = [
  { kind: "deleted", oldLine: 20, newLine: null, beforeNewLine: 20, text: "line 20 old" },
  { kind: "added", oldLine: null, newLine: 20, beforeNewLine: 20, text: "line 20 new" },
];

describe("SourceDiffBody", () => {
  it("keeps one semantic body across host heights and folds to exactly three context lines", () => {
    const code = Array.from({ length: 40 }, (_value, index) => index === 19 ? "line 20 new" : `line ${index + 1}`).join("\n");
    const view: CodeView = {
      node: NODE,
      code,
      loading: false,
      error: null,
      mode: "inline",
      baseLine: 1,
      diffLines: REPLACEMENT,
      sourceSide: "head",
    };

    // GitHub makes the whole U3 patch range commentable. Those rows must not become a second fold
    // focus that widens the visible context from three lines to six.
    const liveReview = { reviewCommentRangesByFile: { [FILE]: [{ start: 17, end: 23 }] } };
    const hoverBody = renderBody(view, 340, liveReview);
    const modalBody = renderBody(view, "70vh", liveReview);

    expect(normalizeHeight(hoverBody)).toBe(normalizeHeight(modalBody));
    expect(hoverBody).toContain('aria-label="Expand 16 unchanged lines"');
    expect(hoverBody).toContain('aria-label="Expand 17 unchanged lines"');
    for (const line of [17, 18, 19, 20, 21, 22, 23]) {
      expect(hoverBody).toContain(`data-source-line="${line}"`);
    }
    expect(hoverBody).not.toContain('data-source-line="16"');
    expect(hoverBody).not.toContain('data-source-line="24"');
    expect(hoverBody.match(/data-diff-origin="delete"/g)).toHaveLength(1);
    expect(hoverBody.match(/data-diff-origin="add"/g)).toHaveLength(1);
    expect(hoverBody).toContain('data-review-comment-scope="inline-and-file"');
    expect(hoverBody).toContain("L17–L23 can be inline on current code · comments on other current lines attach to the file");
  });

  it("keeps the legacy deletion immediately before the first visible source line", () => {
    const view: CodeView = {
      node: { ...NODE, location: { ...NODE.location, startLine: 10, endLine: 12 } },
      code: "line 10 new\nline 11\nline 12",
      loading: false,
      error: null,
      mode: "modal",
      baseLine: 10,
    };
    const html = renderBody(view, 340, {
      reviewRemovedByFile: { [FILE]: [{ afterNewLine: 9, lines: ["line 10 old"] }] },
      reviewRemovedTruncatedByFile: { [FILE]: true },
    });

    expect(html.indexOf("line 10 old")).toBeLessThan(html.indexOf('data-source-line="10"'));
    expect(html).toContain("… removed lines truncated");
  });

  it("renders only old-side rows owned by the surviving declaration's comparison span", () => {
    const view: CodeView = {
      node: { ...NODE, location: { ...NODE.location, startLine: 10, endLine: 12 } },
      code: "line 10\nline 11\nline 12",
      loading: false,
      error: null,
      mode: "inline",
      baseLine: 10,
      diffOldSpan: { start: 10, end: 12 },
      diffLines: [
        { kind: "deleted", oldLine: 12, newLine: null, beforeNewLine: 13, text: "owned deletion" },
        { kind: "deleted", oldLine: 13, newLine: null, beforeNewLine: 13, text: "leaked deletion" },
      ],
      sourceSide: "head",
    };

    const html = renderBody(view, 340);

    expect(html).toContain("owned deletion");
    expect(html).not.toContain("leaked deletion");
    expect(html.match(/data-diff-origin="delete"/g)).toHaveLength(1);
  });

  it("uses explicit zero lineCount for an empty HEAD while retaining its canonical deletions", () => {
    const view: CodeView = {
      node: { ...NODE, kind: "module", location: { ...NODE.location, startLine: 1, endLine: 1 } },
      code: "",
      lineCount: 0,
      loading: false,
      error: null,
      mode: "modal",
      baseLine: 1,
      wholeFile: true,
      diffLines: [{ kind: "deleted", oldLine: 1, newLine: null, beforeNewLine: 1, text: "removed from empty HEAD" }],
      sourceSide: "head",
    };

    const html = renderBody(view, 340);

    expect(html).not.toContain("data-source-line");
    expect(html.match(/data-diff-origin="delete"/g)).toHaveLength(1);
    expect(html.match(/removed from empty HEAD/g)).toHaveLength(1);
  });

  it("does not present a manifest-only change as ordinary unchanged source", () => {
    const view: CodeView = {
      node: NODE,
      code: "export function reviewTarget() {}",
      lineCount: 1,
      loading: false,
      error: null,
      mode: "inline",
      baseLine: 1,
    };
    const html = renderBody(view, 340, {
      prReviewSource: {
        number: 7,
        files: [{
          path: FILE,
          status: "modified",
          additions: 0,
          deletions: 0,
          diffComplete: false,
        }],
        truncated: false,
        total: 1,
        outside: 0,
        suggestedSubdir: "",
      },
    });

    expect(html).toContain('data-non-textual-diff="true"');
    expect(html).toContain("Git reports this file changed, but no textual diff is available");
    expect(html).toContain('data-source-line="1"');
    expect(html).toContain('aria-label="Comment on line 1"');
    expect(html).toContain('data-review-comment-scope="file-only"');
    expect(html).toContain("Comments on current lines in this preview will attach to the file");
  });

  it("keeps a live preview with no inline overlap draftable as file-level comments", () => {
    const view: CodeView = {
      node: NODE,
      code: "line 1\nline 2\nline 3",
      lineCount: 3,
      loading: false,
      error: null,
      mode: "inline",
      baseLine: 1,
    };
    const html = renderBody(view, 340);

    expect(html).toContain('data-review-comment-scope="file-only"');
    expect(html).toContain("Comments on current lines in this preview will attach to the file");
    expect(html.match(/aria-label="Comment on line /g)).toHaveLength(3);
  });

  it("restores the shared unfinished composer when the same line mounts in another source host", () => {
    const view: CodeView = {
      node: NODE,
      code: Array.from({ length: 40 }, (_value, index) => `line ${index + 1}`).join("\n"),
      loading: false,
      error: null,
      mode: "modal",
      baseLine: 1,
    };
    const html = renderBody(view, "70vh", {
      reviewCommentRangesByFile: { [FILE]: [{ start: 20, end: 20 }] },
      reviewLineComposer: {
        reviewKey: "source-diff-test",
        lineRevision: null,
        path: FILE,
        line: 20,
        side: "RIGHT",
        body: "Carry this exact text between code views",
        confirmDiscard: false,
        error: null,
      },
    });

    expect(html).toContain('placeholder="Comment on line 20…"');
    expect(html).toContain("Carry this exact text between code views");
  });

  it("restores a LEFT composer on the exact deleted row instead of the same-number HEAD row", () => {
    const view: CodeView = {
      node: NODE,
      code: "line 19\nline 20 new\nline 21",
      lineCount: 3,
      loading: false,
      error: null,
      mode: "modal",
      baseLine: 19,
      diffLines: REPLACEMENT,
      sourceSide: "head",
    };
    const html = renderBody(view, "70vh", {
      reviewLineComposer: {
        reviewKey: "source-diff-test",
        lineRevision: null,
        path: FILE,
        line: 20,
        side: "LEFT",
        body: "Question about the removed behavior",
        confirmDiscard: false,
        error: null,
      },
    });

    expect(html).toContain('data-review-comment-line="20" data-review-comment-side="LEFT"');
    expect(html).toContain('data-line-comment-composer="20" data-line-comment-composer-side="LEFT"');
    expect(html).toContain('placeholder="Comment on deleted line 20…"');
    expect(html).toContain("Question about the removed behavior");
  });

  it("restores a composer outside GitHub's inline range because its draft will attach to the file", () => {
    const view: CodeView = {
      node: NODE,
      code: Array.from({ length: 40 }, (_value, index) => `line ${index + 1}`).join("\n"),
      loading: false,
      error: null,
      mode: "modal",
      baseLine: 1,
    };
    const html = renderBody(view, "70vh", {
      reviewCommentRangesByFile: { [FILE]: [{ start: 20, end: 20 }] },
      reviewLineComposer: {
        reviewKey: "source-diff-test",
        lineRevision: null,
        path: FILE,
        line: 24,
        side: "RIGHT",
        body: "Preserve this outside-diff thought",
        confirmDiscard: false,
        error: null,
      },
    });

    expect(html).toContain('placeholder="Comment on line 24…"');
    expect(html).toContain("Preserve this outside-diff thought");
  });

  it("marks every line file-only when a stale review has no immutable commit SHA", () => {
    const view: CodeView = {
      node: NODE,
      code: "line 19\nline 20\nline 21",
      lineCount: 3,
      loading: false,
      error: null,
      mode: "inline",
      baseLine: 19,
    };
    const html = renderBody(view, 340, {
      prReviewStale: true,
      prReviewRevision: {
        number: 7,
        headRef: "feature",
        baseRef: "main",
        headSha: null,
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
      reviewCommentRangesByFile: { [FILE]: [{ start: 19, end: 21 }] },
    });

    expect(html).toContain('data-review-comment-scope="file-only"');
    expect(html).toContain("Comments on current lines in this preview will attach to the file");
    expect(html.match(/aria-label="Comment on line /g)).toHaveLength(3);
  });
});

describe("githubLineCommentScopeNote", () => {
  it("names a contiguous range and bounds fragmented range copy", () => {
    expect(githubLineCommentScopeNote(new Set([7, 8, 9]), 14)).toBe(
      "L7–L9 can be inline on current code · comments on other current lines attach to the file",
    );
    expect(githubLineCommentScopeNote(new Set([7, 9, 10, 14]), 14)).toBe(
      "L7, L9–L10 +1 more can be inline on current code · comments on other current lines attach to the file",
    );
  });

  it("stays silent when the whole source is commentable and explains an empty overlap", () => {
    expect(githubLineCommentScopeNote(new Set([17, 18, 19]), 3)).toBeNull();
    expect(githubLineCommentScopeNote(new Set(), 14)).toBe(
      "Comments on current lines in this preview will attach to the file",
    );
    expect(githubLineCommentScopeNote(new Set(), 0)).toBeNull();
  });
});

describe("SourceDiffBody source-comment preference", () => {
  it("omits ordinary, documentation, and directive comments while keeping mixed lines in the diff", () => {
    const code = [
      "export function reviewTarget() {",
      "  /** Public API documentation. */",
      "  // @ts-expect-error intentional fixture",
      "  // Explain the behavior that follows.",
      "  return run(); // This mixed line remains code.",
      "}",
    ].join("\n");
    const view: CodeView = {
      node: { ...NODE, location: { ...NODE.location, startLine: 1, endLine: 6 } },
      code,
      lineCount: 6,
      loading: false,
      error: null,
      mode: "inline",
      baseLine: 1,
      diffLines: code.split("\n").map((text, index) => ({
        kind: "added" as const,
        oldLine: null,
        newLine: index + 1,
        beforeNewLine: index + 1,
        text,
      })),
      sourceSide: "head",
    };

    const ordinary = renderBody(view, 340);
    const focused = renderBody(view, 340, {
      prReviewed: null,
      reviewHideAddedSourceCommentDiffs: true,
    });

    expect(sourceRowOpeningTag(ordinary, 2)).toContain('data-diff-origin="add"');
    expect(ordinary).toContain('data-source-summary-added="6"');
    expect(focused).not.toContain("Public API documentation.");
    expect(focused).not.toContain("@ts-expect-error intentional fixture");
    expect(focused).not.toContain("Explain the behavior that follows.");
    expect(sourceRowOpeningTag(focused, 2)).toBe("");
    expect(sourceRowOpeningTag(focused, 3)).toBe("");
    expect(sourceRowOpeningTag(focused, 4)).toBe("");
    expect(sourceRowOpeningTag(focused, 5)).toContain('data-diff-origin="add"');
    expect(focused).toContain('data-source-summary-added="3"');
  });

  it("omits a replacement's full explanatory source-comment block", () => {
    const source = Array.from({ length: 30 }, (_value, index) => `line ${index + 1}`);
    source.splice(
      9,
      6,
      "// Explain the replacement, part 1.",
      "// Explain the replacement, part 2.",
      "// Explain the replacement, part 3.",
      "// Explain the replacement, part 4.",
      "// Explain the replacement, part 5.",
      "return newTier();",
    );
    const view: CodeView = {
      node: { ...NODE, location: { ...NODE.location, startLine: 1, endLine: 30 } },
      code: source.join("\n"),
      lineCount: 30,
      loading: false,
      error: null,
      mode: "inline",
      baseLine: 1,
      diffLines: [
        { kind: "deleted", oldLine: 10, newLine: null, beforeNewLine: 10, text: "return oldTier();" },
        ...source.slice(9, 14).map((text, index) => ({
          kind: "added" as const,
          oldLine: null,
          newLine: index + 10,
          beforeNewLine: index + 10,
          text,
        })),
        { kind: "added", oldLine: null, newLine: 15, beforeNewLine: 15, text: source[14] },
      ],
      sourceSide: "head",
    };

    const html = renderBody(view, 340, { reviewHideAddedSourceCommentDiffs: true });

    for (const line of [10, 11, 12, 13, 14]) {
      expect(sourceRowOpeningTag(html, line)).toBe("");
      expect(html).not.toContain(`Explain the replacement, part ${line - 9}.`);
    }
    expect(sourceRowOpeningTag(html, 15)).toContain('data-diff-origin="add"');
    expect(html).toContain('data-source-summary-added="1"');
    expect(html.match(/data-diff-origin="delete"/g)).toHaveLength(1);
  });

  it("does not apply the review preference to an ordinary source view", () => {
    const view: CodeView = {
      node: { ...NODE, location: { ...NODE.location, startLine: 1, endLine: 2 } },
      code: "// Explain the behavior.\nrun();",
      lineCount: 2,
      loading: false,
      error: null,
      mode: "inline",
      baseLine: 1,
      diffLines: [
        { kind: "added", oldLine: null, newLine: 1, beforeNewLine: 1, text: "// Explain the behavior." },
        { kind: "added", oldLine: null, newLine: 2, beforeNewLine: 2, text: "run();" },
      ],
      sourceSide: "head",
    };

    const html = renderBody(view, 340, {
      review: null,
      reviewHideAddedSourceCommentDiffs: true,
    });

    expect(sourceRowOpeningTag(html, 1)).toContain('data-diff-origin="add"');
    expect(html).toContain('data-source-summary-added="2"');
  });
});

describe("diffLinesWithinSlice", () => {
  it("retains deletes before the first row and after the final row", () => {
    const lines: CodeDiffLine[] = [
      { kind: "deleted", oldLine: 8, newLine: null, beforeNewLine: 10, text: "before first" },
      { kind: "added", oldLine: null, newLine: 11, beforeNewLine: 11, text: "inside" },
      { kind: "deleted", oldLine: 13, newLine: null, beforeNewLine: 13, text: "after last" },
      { kind: "added", oldLine: null, newLine: 14, beforeNewLine: 14, text: "outside" },
    ];

    expect(diffLinesWithinSlice(lines, "head", 10, 12).map((line) => line.text)).toEqual([
      "before first",
      "inside",
      "after last",
    ]);
  });

  it("uses exact old spans to assign a shared boundary cursor to only one declaration", () => {
    const lines: CodeDiffLine[] = [
      { kind: "deleted", oldLine: 12, newLine: null, beforeNewLine: 13, text: "first declaration EOF" },
      { kind: "deleted", oldLine: 13, newLine: null, beforeNewLine: 13, text: "second declaration start" },
    ];

    expect(diffLinesWithinSlice(lines, "head", 10, 12, { start: 10, end: 12 }).map((line) => line.text)).toEqual([
      "first declaration EOF",
    ]);
    expect(diffLinesWithinSlice(lines, "head", 13, 15, { start: 13, end: 16 }).map((line) => line.text)).toEqual([
      "second declaration start",
    ]);
    expect(diffLinesWithinSlice(lines, "head", 10, 12, null)).toEqual([]);
  });

  it("retains a file-level EOF deletion when no declaration span is applied", () => {
    const eof: CodeDiffLine = {
      kind: "deleted",
      oldLine: 40,
      newLine: null,
      beforeNewLine: 31,
      text: "deleted after the extractor's final module line",
    };

    expect(diffLinesWithinSlice([eof], "head", 1, 30)).toEqual([eof]);
  });
});

describe("sourceDiffInstanceKey", () => {
  it("changes across files, source sides, and fetched slices so fold state cannot leak", () => {
    const base = {
      view: { node: NODE },
      file: FILE,
      baseLine: 1,
      shownEnd: 40,
      sourceSide: "head" as const,
    };
    const key = sourceDiffInstanceKey(base);

    expect(sourceDiffInstanceKey({ ...base, file: "src/other.ts" })).not.toBe(key);
    expect(sourceDiffInstanceKey({ ...base, sourceSide: "base" })).not.toBe(key);
    expect(sourceDiffInstanceKey({ ...base, baseLine: 10 })).not.toBe(key);
    expect(sourceDiffInstanceKey({ ...base, shownEnd: 20 })).not.toBe(key);
    expect(sourceDiffInstanceKey({ ...base, diffOldSpan: { start: 1, end: 40 } })).not.toBe(key);
    expect(sourceDiffInstanceKey({ ...base, diffOldSpan: null })).not.toBe(key);
    expect(sourceDiffInstanceKey({ ...base, view: { node: { ...NODE, id: "ts:src/review.ts#other" } } })).not.toBe(key);
  });
});

function renderBody(
  view: CodeView,
  maxHeight: number | string,
  overrides: Partial<BlueprintState> = {},
): string {
  const store = createBlueprintStore({
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    provider: null,
    hasOverlay: false,
    sourceUrl: "/source",
    prsUrl: "",
    prOneUrl: "",
    prFilesUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
  store.setState({
    review: {
      context: {
        changedFiles: [{ path: FILE, status: "modified", hunks: [{ start: 20, end: 20 }] }],
        baseRef: "main",
        baseSha: "base",
        headRef: "feature",
        reviewKey: "source-diff-test",
        warnings: [],
      },
      rows: [],
      flows: {},
    },
    prReviewed: 7,
    ...overrides,
  });
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <BodyHarness view={view} maxHeight={maxHeight} />
    </StoreProvider>,
  );
}

function BodyHarness({ view, maxHeight }: { view: CodeView; maxHeight: number | string }) {
  const model = useSourceDiffModel(view);
  return (
    <div
      data-source-summary-added={model.summary?.added ?? "none"}
      data-source-summary-deleted={model.summary?.deleted ?? "none"}
    >
      <SourceDiffBody model={model} maxHeight={maxHeight} showGutter />
    </div>
  );
}

function sourceRowOpeningTag(html: string, line: number): string {
  return html.match(new RegExp(`<tr[^>]*data-source-line="${line}"[^>]*>`))?.[0] ?? "";
}

function normalizeHeight(html: string): string {
  return html.replace(/max-height:(?:\d+px|70vh)/g, "max-height:HOST");
}
