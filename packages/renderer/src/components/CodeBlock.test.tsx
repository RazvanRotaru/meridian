import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import type { PrGitHubComment } from "../state/prTypes";
import type { ReviewComment } from "../state/reviewTicksPref";
import { createBlueprintStore } from "../state/store";
import { StoreProvider } from "../state/StoreContext";
import { CodeBlock } from "./CodeBlock";

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
    expect(html).toContain('aria-label="Comment on line 41"');
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
