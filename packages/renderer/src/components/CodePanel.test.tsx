import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeStatus, GraphArtifact, GraphNode } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import type { PrGitHubComment } from "../state/prTypes";
import type { ReviewComment } from "../state/reviewTicksPref";
import { createBlueprintStore } from "../state/store";
import { StoreProvider } from "../state/StoreContext";
import { CodePanel } from "./CodePanel";

const FILE = "src/order.ts";
const NODE: GraphNode = {
  id: "ts:src/order.ts#Order",
  kind: "interface",
  qualifiedName: "Order",
  displayName: "Order",
  parentId: null,
  location: { file: FILE, startLine: 17, endLine: 20 },
};
const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.1.0",
  generatedAt: "2026-07-12T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [NODE],
  edges: [],
};

function existingComment(
  body: string,
  line: number | null,
  overrides: Partial<PrGitHubComment> = {},
): PrGitHubComment {
  return {
    id: 201,
    inReplyToId: null,
    viewerCanEdit: false,
    path: FILE,
    line,
    side: "RIGHT",
    body,
    author: "octo",
    updatedAt: "2026-07-12T00:00:00.000Z",
    url: "https://github.com/o/r/pull/77#discussion_r1",
    ...overrides,
  };
}

function pendingComment(
  body: string,
  line: number | null,
  overrides: Partial<ReviewComment> = {},
): ReviewComment {
  return {
    id: `draft-${body}`,
    path: FILE,
    nodeId: null,
    line,
    anchorLabel: line === null ? null : `L${line}`,
    body,
    at: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function sourceModal(options: {
  live: boolean;
  status?: ChangeStatus;
  comments?: PrGitHubComment[];
  pendingComments?: ReviewComment[];
  commentsVisible?: boolean;
  reviewPathAlias?: string;
}) {
  const status = options.status ?? "modified";
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
        changedFiles: [{ path: FILE, status, hunks: [{ start: 19, end: 19 }] }],
        baseRef: "main",
        baseSha: "base",
        headRef: "feature",
        reviewKey: "test-review",
        warnings: [],
      },
      rows: [],
      flows: {},
    },
    prReviewed: options.live ? 77 : null,
    prDiscussion: {
      comments: options.comments ?? [],
      reviews: { approved: [], changesRequested: [], commented: 0 },
    },
    reviewComments: options.pendingComments ?? [],
    reviewCommentsVisible: options.commentsVisible ?? true,
    reviewCommentRangesByFile: options.live && status !== "deleted"
      ? { [FILE]: [{ start: 17, end: 19 }] }
      : {},
    ...(options.reviewPathAlias ? {
      reviewFiles: [{
        path: options.reviewPathAlias,
        status,
        moduleId: NODE.id,
        isTest: false,
        units: [],
        fingerprint: "test-file",
        blastRadius: 0,
        deletedImpact: null,
      }],
    } : {}),
    reviewFileDelta: {
      [FILE]: { added: 1, deleted: status === "deleted" ? 4 : 1, status: status === "deleted" ? "removed" : "modified" },
    },
    codeView: {
      node: NODE,
      code: "before\nstill before\nchanged\nafter",
      loading: false,
      error: null,
      mode: "modal",
      baseLine: 17,
      changedLineKinds: new Map([[19, "modified"]]),
      changedLines: new Set([19]),
    },
  });
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  return renderToStaticMarkup(<StoreProvider store={store}><CodePanel /></StoreProvider>);
}

describe("CodePanel review comments", () => {
  it("offers line drafts only on the visible GitHub diff/context rows", () => {
    const markup = sourceModal({ live: true });

    expect(markup.match(/aria-label="Comment on line /g)).toHaveLength(3);
    for (const line of [17, 18, 19]) {
      expect(markup).toContain(`aria-label="Comment on line ${line}"`);
    }
    expect(markup).not.toContain('aria-label="Comment on line 20"');
  });

  it("keeps artifact-only reviews limited to their anchorable changed rows", () => {
    const markup = sourceModal({ live: false });

    expect(markup.match(/aria-label="Comment on line /g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Comment on line 19"');
  });

  it("does not offer HEAD-line drafts for a file removed by the PR", () => {
    const markup = sourceModal({ live: true, status: "deleted" });

    expect(markup).not.toContain('aria-label="Comment on line ');
  });

  it("marks a restored draft outside GitHub's diff context instead of treating it as submittable", () => {
    const markup = sourceModal({
      live: true,
      pendingComments: [pendingComment("Keep this exact line", 20)],
    });

    expect(markup).toContain('data-review-comment-blocked="true"');
    expect(markup).toContain("Needs diff line");
    expect(markup).not.toContain('aria-label="Comment on line 20"');
  });

  it("renders only visible RIGHT-side GitHub comments in the source modal", () => {
    const markup = sourceModal({
      live: true,
      comments: [
        existingComment("Visible modal comment", 19),
        existingComment("Base-side comment", 19, { side: "LEFT" }),
        existingComment("Other file comment", 19, { path: "src/other.ts" }),
        existingComment("Outside modal range", 21),
        existingComment("Outdated comment", null, { side: null }),
      ],
    });

    expect(markup).toContain('data-existing-review-comments-line="19"');
    expect(markup).toContain("Visible modal comment");
    expect(markup).not.toContain("Base-side comment");
    expect(markup).not.toContain("Other file comment");
    expect(markup).not.toContain("Outside modal range");
    expect(markup).not.toContain("Outdated comment");
  });

  it("hides existing comments without disabling line drafting", () => {
    const markup = sourceModal({
      live: true,
      commentsVisible: false,
      comments: [existingComment("Hidden modal comment", 19)],
    });

    expect(markup).not.toContain("data-existing-review-comments-line");
    expect(markup).not.toContain("Hidden modal comment");
    expect(markup.match(/aria-label="Comment on line /g)).toHaveLength(3);
  });

  it("renders only fresh local line drafts in the visible source slice", () => {
    const markup = sourceModal({
      live: true,
      comments: [existingComment("Already on GitHub", 19)],
      pendingComments: [
        pendingComment("Visible pending draft", 19),
        pendingComment("Previous-revision draft", 19, { lineStale: true }),
        pendingComment("File-level draft", null),
        pendingComment("Other-file draft", 19, { path: "src/other.ts" }),
        pendingComment("Before visible slice", 16),
        pendingComment("After visible slice", 21),
      ],
    });

    expect(markup).toContain('data-pending-review-comments-line="19"');
    expect(markup).toContain("Visible pending draft");
    expect(markup).toContain("Pending");
    expect(markup).toContain('data-existing-review-comments-line="19"');
    expect(markup).toContain("Already on GitHub");
    expect(markup).not.toContain("Previous-revision draft");
    expect(markup).not.toContain("File-level draft");
    expect(markup).not.toContain("Other-file draft");
    expect(markup).not.toContain("Before visible slice");
    expect(markup).not.toContain("After visible slice");
  });

  it("keeps local pending drafts visible while existing GitHub comments are hidden", () => {
    const markup = sourceModal({
      live: true,
      commentsVisible: false,
      comments: [existingComment("Hidden GitHub comment", 19)],
      pendingComments: [pendingComment("Still-visible pending draft", 19)],
    });

    expect(markup).not.toContain("Hidden GitHub comment");
    expect(markup).not.toContain("data-existing-review-comments-line");
    expect(markup).toContain('data-pending-review-comments-line="19"');
    expect(markup).toContain("Still-visible pending draft");
  });

  it("does not leak a previously selected PR's discussion into non-PR source", () => {
    const markup = sourceModal({
      live: false,
      comments: [existingComment("Stale PR comment", 19)],
    });

    expect(markup).not.toContain("Stale PR comment");
  });

  it("maps a PR path alias onto the matching canvas file", () => {
    const alias = "repo/src/order.ts";
    const markup = sourceModal({
      live: true,
      reviewPathAlias: alias,
      comments: [existingComment("Aliased path comment", 19, { path: alias })],
    });

    expect(markup).toContain("Aliased path comment");
  });

  it("maps a pending draft's PR path alias onto the matching canvas file", () => {
    const alias = "repo/src/order.ts";
    const markup = sourceModal({
      live: true,
      reviewPathAlias: alias,
      pendingComments: [pendingComment("Aliased pending draft", 19, { path: alias })],
    });

    expect(markup).toContain('data-pending-review-comments-line="19"');
    expect(markup).toContain("Aliased pending draft");
  });
});
