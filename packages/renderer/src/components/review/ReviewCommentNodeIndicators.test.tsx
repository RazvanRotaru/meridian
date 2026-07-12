import { renderToStaticMarkup } from "react-dom/server";
import type { Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    useViewport: () => ({ x: 0, y: 0, zoom: 0.5 }),
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
      ["one", { draftCount: 0, existingCount: 1 }],
      ["two", { draftCount: 2, existingCount: 0 }],
      ["none", { draftCount: 0, existingCount: 0 }],
      ["not-visible", { draftCount: 1, existingCount: 0 }],
    ]);

    const markup = renderToStaticMarkup(
      <ReviewCommentNodeIndicatorLayer visibleNodes={nodes} evidence={evidence} />,
    );

    expect(toolbarCalls).toEqual([
      { nodeId: "one", className: expect.stringContaining("semantic-layer-2"), position: "bottom", align: "end", offset: 1 },
      { nodeId: "two", className: "review-comment-node-toolbar", position: "bottom", align: "end", offset: 1 },
    ]);
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="1 review comment"');
    expect(markup).toContain('aria-label="2 review comments"');
    expect(markup).toContain('data-review-draft-count="2"');
    expect(markup).toContain('data-review-existing-count="1"');
    expect(markup).toContain("transform:scale(0.5)");
    expect(markup.match(/aria-hidden="true"/g)).toHaveLength(2);
    expect(markup).not.toContain("not-visible");
  });
});

function rfNode(id: string, semanticDepth?: number): Node {
  return {
    id,
    type: "file",
    position: { x: 0, y: 0 },
    data: semanticDepth === undefined ? {} : { semanticDepth },
  };
}
