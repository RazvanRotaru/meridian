import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceSearchBar } from "./SourceSearchBar";
import type { SourceSearchController } from "./useSourceSearch";

describe("SourceSearchBar", () => {
  it("renders the source-local result and navigation contract", () => {
    const match = { line: 42, column: 7, length: 5 };
    const controller: SourceSearchController = {
      activeIndex: 0,
      activeMatch: match,
      close: () => {},
      inputRef: createRef<HTMLInputElement>(),
      matches: [match],
      move: () => {},
      open: true,
      openSearch: () => {},
      query: "order",
      result: { matches: [match], truncated: true },
      setQuery: () => {},
      triggerRef: createRef<HTMLButtonElement>(),
    };

    const markup = renderToStaticMarkup(<SourceSearchBar search={controller} />);

    expect(markup).toContain('id="meridian-source-search"');
    expect(markup).toContain('role="search"');
    expect(markup).toContain('aria-label="Search source"');
    expect(markup).toContain('aria-controls="meridian-source-code-dock"');
    expect(markup).toContain('value="order"');
    expect(markup).toContain("1 of 1+ · L42:7");
    expect(markup).toContain('aria-label="Previous source match"');
    expect(markup).toContain('aria-label="Next source match"');
    expect(markup).toContain('aria-label="Close source search"');
    expect(markup).toContain(".source-dock-search-input:focus-visible");
  });
});
