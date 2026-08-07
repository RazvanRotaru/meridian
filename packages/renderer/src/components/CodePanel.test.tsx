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
    side: line === null ? null : "RIGHT",
    anchorLabel: line === null ? null : `L${line}`,
    body,
    at: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function sourceModal(options: {
  live: boolean;
  status?: ChangeStatus;
  code?: string;
  lineCount?: number;
  wholeFile?: boolean;
  comments?: PrGitHubComment[];
  pendingComments?: ReviewComment[];
  commentsVisible?: boolean;
  reviewPathAlias?: string;
  stale?: boolean;
  reviewedHeadSha?: string | null;
  lookup?: boolean;
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
    prReviewStale: options.stale ?? false,
    ...(options.live && options.stale ? {
      prReviewRevision: {
        number: 77,
        headRef: "feature",
        baseRef: "main",
        headSha: options.reviewedHeadSha ?? null,
        updatedAt: "2026-07-12T00:00:00.000Z",
      },
    } : {}),
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
    minimalSeedIds: [NODE.id],
    codeView: {
      node: NODE,
      code: options.code ?? "before\nstill before\nchanged\nafter",
      ...(options.lineCount === undefined ? {} : { lineCount: options.lineCount }),
      loading: false,
      error: null,
      mode: "modal",
      baseLine: 17,
      wholeFile: options.wholeFile,
      sourceSide: status === "deleted" ? "base" : "head",
      changedLineKinds: new Map([[19, "modified"]]),
      changedLines: new Set([19]),
    },
  });
  const state = store.getState();
  Object.assign(store, { getInitialState: () => state });
  const onLookupSymbol = options.lookup === false ? undefined : () => {};
  return renderToStaticMarkup(
    <StoreProvider store={store}><CodePanel onLookupSymbol={onLookupSymbol} /></StoreProvider>,
  );
}

describe("CodePanel review comments", () => {
  it("labels a loaded zero-row source as empty instead of showing an inverted range", () => {
    const markup = sourceModal({ live: true, code: "", lineCount: 0 });
    const wholeFileMarkup = sourceModal({ live: true, code: "", lineCount: 0, wholeFile: true });

    expect(markup).toContain("src/order.ts:empty");
    expect(markup).not.toContain("src/order.ts:17-16");
    expect(markup).not.toContain("data-source-line");
    expect(wholeFileMarkup).toContain("src/order.ts · empty");
  });

  it("renders source as a shell-level resizable dock with one diff scroll owner", () => {
    const markup = sourceModal({ live: true });

    expect(markup).toContain('data-source-code-dock-layer="true"');
    expect(markup).toContain('pointer-events:auto');
    expect(markup).toContain('background:transparent');
    expect(markup).toContain('data-source-code-dock-host="true"');
    expect(markup).toContain('width:60%');
    expect(markup).toContain('data-source-code-resize-handle="true"');
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-label="Resize source dock"');
    expect(markup).toContain('aria-valuemin="40"');
    expect(markup).toContain('aria-valuemax="90"');
    expect(markup).toContain('aria-valuenow="60"');
    expect(markup).toContain('data-source-code-dock="true"');
    expect(markup.match(/role="dialog"/g)).toHaveLength(1);
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('data-source-code-body="dock"');
    expect(markup).toContain('data-source-diff-fill="true"');
    expect(markup).toContain('data-source-scroll-owner="true"');
    expect(markup).toContain('max-height:none');
    expect(markup).not.toContain('max-height:70vh');
  });

  it("offers functional dock maximize and close controls", () => {
    const markup = sourceModal({ live: true });

    expect(markup).toContain('aria-label="Search repository symbols"');
    expect(markup).toContain('data-source-symbol-lookup-trigger="true"');
    expect(markup).toContain('data-source-symbol-selection-enabled="true"');
    expect(markup).toContain('aria-label="Open source search"');
    expect(markup).toContain('aria-keyshortcuts="Control+F Meta+F"');
    expect(markup).toContain('aria-label="Maximize source dock"');
    expect(markup).toContain('aria-label="Close source"');
  });

  it("omits symbol lookup and selection when no lookup action is provided", () => {
    const markup = sourceModal({ live: true, lookup: false });

    expect(markup).not.toContain('data-source-symbol-lookup-trigger="true"');
    expect(markup).not.toContain('data-source-symbol-selection-enabled="true"');
  });

  it("offers the canonical whole-file viewed action for the shown review path", () => {
    const markup = sourceModal({ live: true, reviewPathAlias: FILE });

    expect(markup).toContain('data-review-source-viewed="true"');
    expect(markup).toContain('data-review-viewed-scope="file"');
    expect(markup).toContain('aria-label="Mark src/order.ts as viewed"');
    expect(markup).toContain("Mark viewed</span>");
  });

  it("offers drafts on every visible HEAD row and explains the inline subset", () => {
    const markup = sourceModal({ live: true });

    expect(markup.match(/aria-label="Comment on line /g)).toHaveLength(4);
    for (const line of [17, 18, 19, 20]) {
      expect(markup).toContain(`aria-label="Comment on line ${line}"`);
    }
    expect(markup).toContain('data-review-comment-scope="inline-and-file"');
    expect(markup).toContain("L17–L19 can be inline on current code · comments on other current lines attach to the file");
  });

  it("does not add a scope note when every visible line is in the PR diff", () => {
    const markup = sourceModal({ live: true, code: "first\nsecond\nthird", lineCount: 3 });

    expect(markup.match(/aria-label="Comment on line /g)).toHaveLength(3);
    expect(markup).not.toContain("data-review-comment-scope");
  });

  it("keeps every artifact-only HEAD row draftable as a durable local note", () => {
    const markup = sourceModal({ live: false });

    expect(markup.match(/aria-label="Comment on line /g)).toHaveLength(4);
    for (const line of [17, 18, 19, 20]) {
      expect(markup).toContain(`aria-label="Comment on line ${line}"`);
    }
  });

  it("does not offer HEAD-line drafts for a file removed by the PR", () => {
    const markup = sourceModal({ live: true, status: "deleted" });

    expect(markup).not.toContain('aria-label="Comment on line ');
  });

  it("labels a restored draft outside GitHub's diff context as a file-level review comment", () => {
    const markup = sourceModal({
      live: true,
      pendingComments: [pendingComment("Keep this exact line", 20)],
    });

    expect(markup).toContain('data-review-comment-file="true"');
    expect(markup).toContain("File comment");
    expect(markup).not.toContain('data-review-comment-blocked="true"');
    expect(markup).not.toContain("Needs diff line");
    expect(markup).toContain('aria-label="Comment on line 20"');
  });

  it("labels an otherwise-inline draft as a file comment when a stale review has no SHA", () => {
    const markup = sourceModal({
      live: true,
      stale: true,
      reviewedHeadSha: null,
      pendingComments: [pendingComment("Keep this on the reviewed file", 19)],
    });

    expect(markup).toContain('data-review-comment-scope="file-only"');
    expect(markup).toContain('data-review-comment-file="true"');
    expect(markup).toContain("File comment");
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
    expect(markup.match(/aria-label="Comment on line /g)).toHaveLength(4);
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
