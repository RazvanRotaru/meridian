import { renderToStaticMarkup } from "react-dom/server";
import type { Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewCommentNodePreview } from "../../derive/reviewCommentPreview";
import { CommentPreviewCard } from "./ReviewCommentHoverCard";
import { ReviewCommentNodeIndicatorLayer } from "./ReviewCommentNodeIndicators";

const toolbarCalls = vi.hoisted(() => [] as Array<{
  nodeId?: string | string[];
  className?: string;
  position?: unknown;
  align?: unknown;
  offset?: number;
}>);

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    NodeToolbar: ({
      children,
      nodeId,
      isVisible: _isVisible,
      position,
      align,
      offset,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & {
      nodeId?: string | string[];
      isVisible?: boolean;
      position?: unknown;
      align?: unknown;
      offset?: number;
    }) => {
      toolbarCalls.push({ nodeId, className: props.className, position, align, offset });
      return <div {...props}>{children}</div>;
    },
  };
});

describe("ReviewCommentNodeIndicatorLayer", () => {
  beforeEach(() => {
    toolbarCalls.length = 0;
  });

  it("renders one passive accessible message icon per evidenced node", () => {
    const nodes: Node[] = [rfNode("one", 2), rfNode("two"), rfNode("none")];
    const evidence = new Map([
      ["one", { draftCount: 0, existingCount: 1, comments: [comment("one")] }],
      ["two", { draftCount: 2, existingCount: 0, comments: [comment("two")] }],
      ["none", { draftCount: 0, existingCount: 0, comments: [] }],
      ["not-visible", { draftCount: 1, existingCount: 0, comments: [comment("hidden")] }],
    ]);

    const markup = renderToStaticMarkup(
      <ReviewCommentNodeIndicatorLayer visibleNodes={nodes} evidence={evidence} />,
    );

    expect(toolbarCalls).toEqual([
      { nodeId: "one", className: expect.stringContaining("semantic-layer-2"), position: "bottom", align: "end", offset: 2 },
      { nodeId: "two", className: "review-comment-node-toolbar", position: "bottom", align: "end", offset: 2 },
    ]);
    expect(markup).toContain('aria-label="1 review comment"');
    expect(markup).toContain('aria-label="2 review comments"');
    expect(markup).toContain('data-review-draft-count="2"');
    expect(markup).toContain('data-review-existing-count="1"');
    expect(markup).toContain("width:26px;height:26px");
    expect(markup).toContain("transform:translateX(-4px)");
    expect(markup).not.toContain("scale(");
    expect(markup).toContain("nodrag nopan nowheel");
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(2);
    expect(markup).not.toContain("not-visible");
  });

  it("renders hover-card comment details and GitHub escape links", () => {
    const markup = renderToStaticMarkup(
      <CommentPreviewCard
        label="2 review comments"
        comments={[
          comment("first", { line: 42, body: "Use **the helper**", url: "https://github.com/o/r/pull/1#comment" }),
          comment("draft", { kind: "draft", author: "Draft comment", line: null }),
        ]}
      />,
    );

    expect(markup).toContain('role="tooltip"');
    expect(markup).toContain("2 review comments");
    expect(markup).toContain("L42");
    expect(markup).toContain("<strong>the helper</strong>");
    expect(markup).toContain('href="https://github.com/o/r/pull/1#comment"');
    expect(markup).toContain("Draft comment");
    expect(markup).toContain("width:310px;height:300px;overflow-x:auto;overflow-y:auto");
    expect(markup).toContain("overscroll-behavior:contain");
    expect(markup).toContain('data-review-comment-scroll="true"');
    expect(markup).toContain("display:flex;flex-direction:column;gap:7px;width:100%;min-width:0");
    expect(markup).toContain('data-review-comment-card="true"');
    expect(markup).toContain("width:100%;min-width:0;box-sizing:border-box");
    expect(markup).toContain('data-review-comment-body="true"');
    expect(markup).toContain("min-width:0;max-width:100%");
    expect(markup).toContain("overflow-wrap:anywhere;word-break:normal");
  });
});

function comment(key: string, overrides: Partial<ReviewCommentNodePreview> = {}): ReviewCommentNodePreview {
  return { ...baseComment(key), ...overrides };
}

function baseComment(key: string) {
  return { key, kind: "existing" as const, body: key, author: "octo", line: 1, lineStale: false, url: null as string | null };
}

function rfNode(id: string, semanticDepth?: number): Node {
  return {
    id,
    type: "file",
    position: { x: 0, y: 0 },
    data: semanticDepth === undefined ? {} : { semanticDepth },
  };
}
