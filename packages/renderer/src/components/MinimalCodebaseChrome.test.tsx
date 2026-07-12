import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyMinimalCodebaseContext, MinimalCodebaseSummary } from "./MinimalCodebaseChrome";

describe("minimal codebase context chrome", () => {
  it("reports an honest empty state when none of the extracted targets can be located", () => {
    const markup = renderToStaticMarkup(
      <>
        <MinimalCodebaseSummary context={null} status="ready" targetCount={3} highlightedCount={0} />
        <EmptyMinimalCodebaseContext />
      </>,
    );

    expect(markup).toContain("No extracted code could be located · 3 unavailable");
    expect(markup).toContain("no code nodes that can be placed in the repository map");
    expect(markup).toContain("READ-ONLY");
  });
});
