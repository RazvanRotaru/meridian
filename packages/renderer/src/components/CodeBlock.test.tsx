import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock } from "./CodeBlock";

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
    expect(html).toContain("rgba(230,184,77,0.18)");
    expect(html).toContain("~ 11");
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
});
