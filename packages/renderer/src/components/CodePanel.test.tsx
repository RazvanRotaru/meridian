import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeStatus, GraphArtifact, GraphNode } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../graph/graphIndex";
import type { PrGitHubComment } from "../state/prTypes";
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

function sourceModal(options: {
  live: boolean;
  status?: ChangeStatus;
  comments?: PrGitHubComment[];
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
    reviewCommentsVisible: options.commentsVisible ?? true,
    ...(options.reviewPathAlias ? {
      reviewFiles: [{
        path: options.reviewPathAlias,
        status,
        moduleId: NODE.id,
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
  it("offers a line draft on every visible HEAD row in a live PR review", () => {
    const markup = sourceModal({ live: true });

    expect(markup.match(/aria-label="Comment on line /g)).toHaveLength(4);
    for (const line of [17, 18, 19, 20]) {
      expect(markup).toContain(`aria-label="Comment on line ${line}"`);
    }
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
});
