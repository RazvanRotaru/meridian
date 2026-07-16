import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { PrGitHubComment } from "../state/prTypes";
import type { ReviewComment } from "../state/reviewTicksPref";
import { createBlueprintStore } from "../state/store";
import { StoreProvider } from "../state/StoreContext";
import { CodeBlock, codeFocusScrollTop } from "./CodeBlock";
import type { CodeDiffLine } from "./CodeBlock";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-13T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [],
  edges: [],
};

function existingComment(
  body: string,
  line: number,
  overrides: Partial<PrGitHubComment> = {},
): PrGitHubComment {
  return {
    id: 101,
    inReplyToId: null,
    viewerCanEdit: false,
    path: "src/order.ts",
    line,
    side: "RIGHT",
    body,
    author: "octo",
    updatedAt: "2026-07-12T00:00:00.000Z",
    url: "https://github.com/o/r/pull/7#discussion_r1",
    ...overrides,
  };
}

function pendingComment(
  body: string,
  line: number,
  overrides: Partial<ReviewComment> = {},
): ReviewComment {
  return {
    id: `draft-${body}`,
    path: "src/order.ts",
    nodeId: null,
    line,
    anchorLabel: `L${line}`,
    body,
    at: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function renderWithStore(element: React.ReactElement): string {
  const store = createBlueprintStore({
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "",
    prOneUrl: "",
    prFilesUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  return renderToStaticMarkup(createElement(StoreProvider, { store, children: element }));
}

describe("CodeBlock edge evidence", () => {
  it("marks the exact evidence rows with styling distinct from, and composable with, a PR diff", () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code: "const first = 1;\nconst evidence = run();\nreturn evidence;",
      startLine: 10,
      showGutter: true,
      evidenceLines: new Set([11]),
      changedLineKinds: new Map([[11, "modified" as const]]),
    }));

    expect(html.match(/data-edge-evidence-line="true"/g)).toHaveLength(1);
    expect(html).toContain("linear-gradient");
    // A modified head line paints green (added), never the old yellow — GitHub red/green only.
    expect(html).toContain("rgba(86,194,113,0.20)");
    expect(html).not.toContain("rgba(230,184,77,0.18)");
    expect(html).toContain("+ 11");
  });

  it("uses a dedicated evidence marker when the row is not a diff", () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code: "before\nproof\nafter",
      startLine: 20,
      showGutter: true,
      evidenceLines: new Set([21]),
    }));
    expect(html).toContain("› 21");
    expect(html).toContain("#7DD3FC");
  });
});

describe("CodeBlock structural focus", () => {
  it("anchors the first structural row instead of scrolling to leading context", () => {
    expect(codeFocusScrollTop(51, true)).toBe(51);
    expect(codeFocusScrollTop(51, false)).toBe(0);
    expect(codeFocusScrollTop(140, false)).toBe(89);
  });

  it("keeps focused control rows visible without turning them into PR changes or comment targets", () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code: Array.from({ length: 18 }, (_value, index) => `line ${index + 1}`).join("\n"),
      startLine: 1,
      showGutter: true,
      foldUnchanged: true,
      focusLines: new Set([9, 10, 11]),
    }));

    expect(html.match(/data-source-focus-line="true"/g)).toHaveLength(3);
    expect(html).toContain('data-source-line="9" data-source-focus-line="true"');
    expect(html).toContain('data-source-line="11" data-source-focus-line="true"');
    expect(html).not.toContain('data-diff-origin="add"');
    expect(html).not.toMatch(/<tr[^>]*data-review-comment-line/);
  });
});

describe("CodeBlock canonical diff rows", () => {
  const replacement: CodeDiffLine[] = [
    { kind: "deleted", oldLine: 9, newLine: null, beforeNewLine: 10, text: "const value = 'old';" },
    { kind: "added", oldLine: null, newLine: 10, beforeNewLine: 10, text: "const value = 'new';" },
  ];

  it("renders GitHub-like delete then add rows with stable one-sided coordinates", () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code: "const value = 'new';\nreturn value;",
      startLine: 10,
      showGutter: true,
      diffLines: replacement,
      sourceSide: "head" as const,
    }));

    const deleteTag = html.match(/<tr(?=[^>]*data-diff-origin="delete")[^>]*>/)?.[0] ?? "";
    const addTag = html.match(/<tr(?=[^>]*data-diff-origin="add")[^>]*>/)?.[0] ?? "";
    expect(deleteTag).toContain('data-old-line="9"');
    expect(deleteTag).not.toContain("data-new-line");
    expect(deleteTag).toContain('aria-label="Deleted old line 9"');
    expect(addTag).toContain('data-new-line="10"');
    expect(addTag).not.toContain("data-old-line");
    expect(addTag).toContain('aria-label="Added new line 10"');
    expect(html.indexOf("const value = &#x27;old&#x27;;")).toBeLessThan(html.indexOf('data-source-line="10"'));
    expect(html).toContain("− 9");
    expect(html).toContain("+ 10");
    expect(html.match(/data-diff-origin=/g)).toHaveLength(2);
    expect(html.match(/data-source-line="11"/g)).toHaveLength(1);
  });

  it("preserves Git's no-newline markers on the exact old and new rows", () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code: "new without newline",
      startLine: 1,
      showGutter: true,
      diffLines: [
        {
          kind: "deleted",
          oldLine: 1,
          newLine: null,
          beforeNewLine: 1,
          text: "old without newline",
          noNewline: true,
        },
        {
          kind: "added",
          oldLine: null,
          newLine: 1,
          beforeNewLine: 1,
          text: "new without newline",
          noNewline: true,
        },
      ],
      sourceSide: "head" as const,
    }));

    expect(html.match(/data-no-newline="true"/g)).toHaveLength(2);
    expect(html.match(/data-no-newline-marker=/g)).toHaveLength(2);
    expect(html).toContain('data-no-newline-marker="old"');
    expect(html).toContain('data-no-newline-marker="new"');
    expect(html.match(/No newline at end of file/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Deleted old line 1; no newline at end of file"');
    expect(html).toContain('aria-label="Added new line 1; no newline at end of file"');
  });

  it("renders removed-file BASE source rows directly as deletes without ghost duplication", () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code: "const value = 'old';\nreturn value;",
      startLine: 9,
      showGutter: true,
      diffLines: replacement,
      sourceSide: "base" as const,
    }));

    const deleteTags = html.match(/<tr(?=[^>]*data-diff-origin="delete")[^>]*>/g) ?? [];
    expect(deleteTags).toHaveLength(1);
    expect(deleteTags[0]).toContain('data-source-line="9"');
    expect(deleteTags[0]).toContain('data-old-line="9"');
    expect(deleteTags[0]).toContain('aria-label="Deleted old line 9"');
    expect(html.match(/&#x27;old&#x27;/g)).toHaveLength(1);
    expect(html).not.toContain('data-diff-origin="add"');
  });

  it("renders deletion ghosts once without inventing a source row for an empty HEAD file", () => {
    const deletions: CodeDiffLine[] = [
      { kind: "deleted", oldLine: 1, newLine: null, beforeNewLine: 1, text: "first removed line" },
      { kind: "deleted", oldLine: 2, newLine: null, beforeNewLine: 1, text: "second removed line" },
    ];
    const empty = renderToStaticMarkup(createElement(CodeBlock, {
      code: "",
      lineCount: 0,
      startLine: 1,
      showGutter: true,
      diffLines: deletions,
      sourceSide: "head" as const,
    }));

    expect(empty).not.toContain("data-source-line");
    expect(empty.match(/data-diff-origin="delete"/g)).toHaveLength(2);
    expect(empty.match(/first removed line/g)).toHaveLength(1);
    expect(empty.match(/second removed line/g)).toHaveLength(1);

    const oneBlankLine = renderToStaticMarkup(createElement(CodeBlock, {
      code: "",
      lineCount: 1,
      startLine: 1,
      showGutter: true,
    }));
    expect(oneBlankLine.match(/data-source-line="1"/g)).toHaveLength(1);
  });

  it("uses canonical rows instead of legacy synthetic deletions when both are present", () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code: "before\nconst value = 'new';\nafter",
      startLine: 9,
      showGutter: true,
      changedLineKinds: new Map([[9, "deleted" as const], [10, "modified" as const]]),
      removedRows: new Map([[9, ["legacy old"]]]),
      diffLines: replacement,
    }));

    expect(html).not.toContain("legacy old");
    expect(html).not.toContain('data-source-line="9" data-diff-origin="delete"');
    expect(html.match(/data-diff-origin="delete"/g)).toHaveLength(1);
    expect(html.match(/data-diff-origin="add"/g)).toHaveLength(1);
  });

  it("uses asymmetric three-line context for pure-deletion gaps in the middle, top, and EOF", () => {
    const code = Array.from({ length: 20 }, (_value, index) => `line ${index + 1}`).join("\n");
    const renderDeletion = (beforeNewLine: number) => renderToStaticMarkup(createElement(CodeBlock, {
      code,
      startLine: 1,
      showGutter: true,
      foldUnchanged: true,
      diffLines: [{
        kind: "deleted" as const,
        oldLine: Math.max(1, beforeNewLine),
        newLine: null,
        beforeNewLine,
        text: "deleted",
      }],
      sourceSide: "head" as const,
    }));

    const middle = renderDeletion(15);
    for (const line of [12, 13, 14, 15, 16, 17]) expect(middle).toContain(`data-source-line="${line}"`);
    expect(middle).not.toContain('data-source-line="11"');
    expect(middle).not.toContain('data-source-line="18"');

    const top = renderDeletion(1);
    for (const line of [1, 2, 3]) expect(top).toContain(`data-source-line="${line}"`);
    expect(top).not.toContain('data-source-line="4"');

    const eof = renderDeletion(21);
    for (const line of [18, 19, 20]) expect(eof).toContain(`data-source-line="${line}"`);
    expect(eof).not.toContain('data-source-line="17"');
  });
});

describe("CodeBlock review comments", () => {
  it("folds large unchanged gaps while keeping changed rows and context visible", () => {
    const code = Array.from({ length: 40 }, (_value, index) => `line ${index + 1}`).join("\n");
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code,
      startLine: 1,
      showGutter: true,
      changedLineKinds: new Map([[20, "modified" as const]]),
      foldUnchanged: true,
    }));

    expect(html).toContain('aria-label="Expand 16 unchanged lines"');
    expect(html).toContain('aria-label="Expand 17 unchanged lines"');
    expect(html).toContain('data-source-line="20"');
    expect(html).toContain('data-source-line="17"');
    expect(html).toContain('data-source-line="23"');
    expect(html).not.toContain('data-source-line="16"');
    expect(html).not.toContain('data-source-line="24"');
  });

  it("never folds an unchanged row that owns existing or pending review comments", () => {
    const code = Array.from({ length: 60 }, (_value, index) => `line ${index + 1}`).join("\n");
    const html = renderWithStore(createElement(CodeBlock, {
      code,
      startLine: 1,
      showGutter: true,
      changedLineKinds: new Map([[40, "modified" as const]]),
      existingComments: [existingComment("Keep this context", 8)],
      pendingComments: [pendingComment("Pending context", 20)],
      foldUnchanged: true,
    }));

    expect(html).toContain('data-source-line="8"');
    expect(html).toContain('data-existing-review-comments-line="8"');
    expect(html).toContain('data-source-line="20"');
    expect(html).toContain('data-pending-review-comments-line="20"');
    expect(html).toContain("Keep this context");
    expect(html).toContain("Pending context");
  });

  it("marks only commentable source rows and gives each one an accessible line action", () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code: "first\nsecond\nthird",
      startLine: 40,
      showGutter: true,
      commentableLines: new Set([41]),
      onLineClick: () => undefined,
    }));

    expect(html.match(/data-review-comment-line=/g)).toHaveLength(1);
    expect(html).toContain('data-review-comment-line="41"');
    expect(html).toContain('data-source-code-cell="41"');
    expect(html).toContain('title="Click to comment on line 41"');
    expect(html).toContain('aria-label="Comment on line 41"');
    expect(html).toContain('class="mrd-line-comment-button"');
    expect(html).toContain("tr[data-review-comment-line] .mrd-line-comment-button");
    expect(html).toContain("opacity: 0");
    expect(html).toContain("pointer-events: none");
    expect(html).toContain("tr[data-review-comment-line]:hover .mrd-line-comment-button");
    expect(html).toContain("tr[data-review-comment-line]:focus-within .mrd-line-comment-button");
    expect(html).toContain('tr[data-line-comment-composer-open="true"] .mrd-line-comment-button');
    expect(html).not.toContain('data-source-code-cell="40"');
    expect(html).not.toContain('data-source-code-cell="42"');
    expect(html).not.toContain('aria-label="Comment on line 40"');
    expect(html).not.toContain('aria-label="Comment on line 42"');
  });

  it("places every existing comment directly after its exact source line", () => {
    const html = renderWithStore(createElement(CodeBlock, {
      code: "first\nsecond\nthird",
      startLine: 40,
      showGutter: true,
      existingComments: [
        existingComment("First reply", 41, { viewerCanEdit: true }),
        existingComment("Second reply", 41, { id: 102, inReplyToId: 101, author: "mina", url: "" }),
        existingComment("Outside this slice", 99),
      ],
    }));

    expect(html.match(/data-existing-review-comments-line=/g)).toHaveLength(1);
    expect(html).toContain('data-existing-review-comments-line="41"');
    expect(html).not.toContain('data-existing-review-comments-line="40"');
    expect(html).not.toContain('data-existing-review-comments-line="42"');
    expect(html).not.toContain("Outside this slice");
    expect(html.indexOf('data-source-line="41"')).toBeLessThan(html.indexOf('data-existing-review-comments-line="41"'));
    expect(html.indexOf('data-existing-review-comments-line="41"')).toBeLessThan(html.indexOf('data-source-line="42"'));
    expect(html.indexOf("First reply")).toBeLessThan(html.indexOf("Second reply"));
    expect(html).toContain('title="Open comment on GitHub"');
    expect(html).toContain('href="https://github.com/o/r/pull/7#discussion_r1"');
    expect(html).toContain("octo");
    expect(html).toContain("mina");
    expect(html).toContain('data-review-comment-reply="true"');
    expect(html.match(/title="Reply to comment"/g)).toHaveLength(2);
    expect(html.match(/title="Edit comment"/g)).toHaveLength(1);
  });

  it("hides source-code rows without hiding review discussions anchored to them", () => {
    const html = renderWithStore(createElement(CodeBlock, {
      code: "first\n// source explanation\nthird",
      startLine: 40,
      showGutter: true,
      hiddenSourceLines: new Set([41]),
      existingComments: [existingComment("Reviewer discussion stays visible", 41)],
    }));

    expect(html).not.toContain('data-source-line="41"');
    expect(html).not.toContain("source explanation");
    expect(html).toContain('data-existing-review-comments-line="41"');
    expect(html).toContain("Reviewer discussion stays visible");
  });

  it("keeps local pending comments visible at their exact source line beside existing comments", () => {
    const html = renderWithStore(createElement(CodeBlock, {
      code: "first\nsecond\nthird",
      startLine: 40,
      showGutter: true,
      pendingComments: [
        pendingComment("First pending draft", 41),
        pendingComment("Second pending draft", 41),
        pendingComment("Outside this slice", 99),
      ],
      existingComments: [existingComment("Already on GitHub", 41)],
    }));

    expect(html.match(/data-pending-review-comments-line=/g)).toHaveLength(1);
    expect(html).toContain('data-pending-review-comments-line="41"');
    expect(html).not.toContain('data-pending-review-comments-line="40"');
    expect(html).not.toContain('data-pending-review-comments-line="42"');
    expect(html).not.toContain("Outside this slice");
    expect(html.indexOf('data-source-line="41"')).toBeLessThan(html.indexOf('data-pending-review-comments-line="41"'));
    expect(html.indexOf('data-pending-review-comments-line="41"')).toBeLessThan(html.indexOf('data-source-line="42"'));
    expect(html.indexOf("First pending draft")).toBeLessThan(html.indexOf("Second pending draft"));
    expect(html).toContain("Pending");
    expect(html.match(/title="Edit draft"/g)).toHaveLength(2);
    expect(html).toContain('data-existing-review-comments-line="41"');
    expect(html).toContain("Already on GitHub");
  });
});
