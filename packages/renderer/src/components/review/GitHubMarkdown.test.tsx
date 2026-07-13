import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GitHubMarkdown } from "./GitHubMarkdown";

describe("GitHubMarkdown", () => {
  it("renders badge markup, links, code, and emphasis instead of exposing raw markdown", () => {
    const source = "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow)</sub></sub>** `allowTools` [details](https://github.com/o/r)";
    const html = renderToStaticMarkup(createElement(GitHubMarkdown, { source }));

    expect(html).toContain('<img src="https://img.shields.io/badge/P2-yellow" alt="P2 Badge"');
    expect(html).toContain("<code");
    expect(html).toContain('<a href="https://github.com/o/r"');
    expect(html).not.toContain("**");
    expect(html).not.toContain("&lt;sub&gt;");
  });

  it("does not turn unsafe URLs or arbitrary HTML into active markup", () => {
    const html = renderToStaticMarkup(createElement(GitHubMarkdown, {
      source: '<script>alert(1)</script> [bad](javascript:alert(1))',
    }));

    expect(html).not.toContain("<script");
    expect(html).not.toContain('href="javascript:');
  });
});
