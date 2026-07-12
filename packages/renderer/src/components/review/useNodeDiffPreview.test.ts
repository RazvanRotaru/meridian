import { describe, expect, it } from "vitest";
import type { GraphNode } from "@meridian/core";
import type { PrGitHubComment } from "../../state/prTypes";
import { codeReviewComments, isHeadSideReviewComment } from "./useCodeReviewComments";
import {
  codePreviewNode,
  placeNodeDiffPreview,
  previewFileAllowsLineComments,
  visiblePreviewCommentLines,
  type PreviewRect,
} from "./useNodeDiffPreview";

function existingComment(
  body: string,
  line: number | null,
  overrides: Partial<PrGitHubComment> = {},
): PrGitHubComment {
  return {
    path: "src/live.ts",
    line,
    side: "RIGHT",
    body,
    author: "octo",
    updatedAt: "2026-07-12T00:00:00.000Z",
    url: "https://github.com/o/r/pull/7#discussion_r1",
    ...overrides,
  };
}

function rect(overrides: Partial<PreviewRect> = {}): PreviewRect {
  return {
    left: 100,
    top: 300,
    right: 200,
    bottom: 350,
    width: 100,
    height: 50,
    ...overrides,
  };
}

describe("placeNodeDiffPreview", () => {
  const bounds = { left: 0, top: 0, width: 1200, height: 800 };

  it("places the card to the right of a node when it fits", () => {
    expect(placeNodeDiffPreview(rect(), bounds)).toEqual({
      left: 212,
      top: 110,
      width: 680,
      maxHeight: 430,
    });
  });

  it("flips the card to the left near the pane's right edge", () => {
    expect(placeNodeDiffPreview(rect({ left: 1000, right: 1100 }), bounds).left).toBe(308);
  });

  it("shrinks into the larger side gap instead of covering the hovered node", () => {
    expect(
      placeNodeDiffPreview(
        rect({ left: 246, right: 371, width: 125 }),
        { left: 0, top: 0, width: 900, height: 720 },
      ),
    ).toMatchObject({ left: 383, width: 505 });
  });

  it("clamps the card vertically inside the pane", () => {
    expect(placeNodeDiffPreview(rect({ top: 0, bottom: 20, height: 20 }), bounds).top).toBe(12);
    expect(placeNodeDiffPreview(rect({ top: 780, bottom: 800, height: 20 }), bounds).top).toBe(358);
  });

  it("shrinks to a narrow pane while preserving its margins", () => {
    const placement = placeNodeDiffPreview(
      rect({ left: 280, right: 340 }),
      { left: 100, top: 50, width: 500, height: 300 },
    );
    expect(placement.width).toBe(476);
    expect(placement.maxHeight).toBe(276);
    expect(placement.left).toBeGreaterThanOrEqual(112);
    expect(placement.left + placement.width).toBeLessThanOrEqual(588);
    expect(placement.top).toBe(62);
  });
});

describe("codePreviewNode", () => {
  function node(id: string, kind: string, file: string): GraphNode {
    return {
      id,
      kind,
      qualifiedName: id,
      displayName: id,
      parentId: null,
      location: { file, startLine: 4, endLine: 8 },
    };
  }

  it("allows every source-backed node regardless of PR change membership", () => {
    const unchanged = node("ts:src/unchanged.ts#run", "method", "src/unchanged.ts");
    const nodes = new Map([[unchanged.id, unchanged]]);

    expect(codePreviewNode(nodes, unchanged.id)).toBe(unchanged);
    expect(codePreviewNode(nodes, "synthetic-hover-card")).toBeNull();
  });

  it.each([
    node("ts:src/services", "package", "src/services"),
    node("sys:web", "system", "web"),
    node("ext:typescript/lib.es5.d.ts#Error", "external", "typescript/lib.es5.d.ts"),
    node("unresolved:?", "unresolved", "?"),
    node("ipc:http/GET+/orders", "channel", "(http)"),
  ])("does not preview structural or synthetic node $id", (candidate) => {
    expect(codePreviewNode(new Map([[candidate.id, candidate]]), candidate.id)).toBeNull();
  });
});

describe("visiblePreviewCommentLines", () => {
  it("offers every visible HEAD-side row in an active PR review", () => {
    expect([...visiblePreviewCommentLines(19, "one\ntwo\nthree", true)]).toEqual([19, 20, 21]);
  });

  it("offers no line targets outside an active PR review or before source loads", () => {
    expect(visiblePreviewCommentLines(19, "one\ntwo", false).size).toBe(0);
    expect(visiblePreviewCommentLines(19, null, true).size).toBe(0);
  });
});

describe("previewFileAllowsLineComments", () => {
  it("requires an active PR and a surviving changed HEAD file", () => {
    const files = [
      { path: "src/live.ts", status: "modified" as const },
      { path: "src/gone.ts", status: "deleted" as const },
    ];
    expect(previewFileAllowsLineComments("src/live.ts", 77, files)).toBe(true);
    expect(previewFileAllowsLineComments("src/gone.ts", 77, files)).toBe(false);
    expect(previewFileAllowsLineComments("src/other.ts", 77, files)).toBe(false);
    expect(previewFileAllowsLineComments("src/live.ts", null, files)).toBe(false);
  });
});

describe("codeReviewComments", () => {
  it("keeps exact-path RIGHT-side comments inside the visible absolute line range", () => {
    const comments = [
      existingComment("first visible line", 19),
      existingComment("first reply", 20),
      existingComment("second reply", 20, { author: "mina" }),
      existingComment("last visible line", 21),
      existingComment("before range", 18),
      existingComment("after range", 22),
      existingComment("other file", 20, { path: "src/other.ts" }),
      existingComment("base side", 20, { side: "LEFT" }),
      existingComment("unknown side", 20, { side: null }),
      existingComment("outdated", null, { side: null }),
    ];

    expect(codeReviewComments(comments, "src/live.ts", 19, "one\ntwo\nthree", true).map((comment) => comment.body)).toEqual([
      "first visible line",
      "first reply",
      "second reply",
      "last visible line",
    ]);
  });

  it("returns no comments when the layer is hidden or the source slice is unavailable", () => {
    const comments = [existingComment("visible", 19)];

    expect(codeReviewComments(comments, "src/live.ts", 19, "one", false)).toEqual([]);
    expect(codeReviewComments(comments, null, 19, "one", true)).toEqual([]);
    expect(codeReviewComments(comments, "src/live.ts", 19, null, true)).toEqual([]);
  });

  it("accepts the PR path aliases that resolve to one canvas file", () => {
    const comments = [existingComment("prefixed PR path", 19, { path: "repo/src/live.ts" })];

    expect(codeReviewComments(comments, ["src/live.ts", "repo/src/live.ts"], 19, "one", true).map((comment) => comment.body)).toEqual([
      "prefixed PR path",
    ]);
  });
});

describe("isHeadSideReviewComment", () => {
  it("requires both a current line and the RIGHT diff side", () => {
    expect(isHeadSideReviewComment(existingComment("head", 19))).toBe(true);
    expect(isHeadSideReviewComment(existingComment("base", 19, { side: "LEFT" }))).toBe(false);
    expect(isHeadSideReviewComment(existingComment("unknown", 19, { side: null }))).toBe(false);
    expect(isHeadSideReviewComment(existingComment("outdated", null, { side: null }))).toBe(false);
  });
});
