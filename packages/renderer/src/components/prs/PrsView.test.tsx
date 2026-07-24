import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { freshStore } from "../../parity/surfaceFixture";
import { StoreProvider } from "../../state/StoreContext";
import type { BlueprintState } from "../../state/store";
import type { PrSummary } from "../../state/prTypes";
import { PrsFilterBar } from "./PrsFilterBar";
import { PrsView } from "./PrsView";

describe("PR search UI", () => {
  it("keeps the searchable combobox visible before the queue has any rows", () => {
    const markup = renderPrsView({
      githubSource: true,
      prsList: { open: [], closed: null },
    });

    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-label="Search pull requests"');
    expect(markup).toContain('aria-controls="pr-search-results"');
    expect(markup).toContain('aria-describedby="pr-search-status"');
    expect(markup).toContain('placeholder="Search #, title, author, or branch"');
    expect(markup).toContain('id="pr-search-results" role="listbox"');
    expect(markup).toContain("No open pull requests.");
  });

  it("uses stable option ids and preserves the selected PR independently from search focus", () => {
    const selected = summary(17);
    const markup = renderPrsView({
      githubSource: true,
      prsList: { open: [selected], closed: null },
      prSelected: selected.number,
    });

    expect(markup).toContain('id="pr-search-result-17" role="option" aria-selected="true" tabindex="-1"');
    expect(markup).toContain("#17");
    expect(markup).toContain("feature/search");
    expect(markup).toContain("1 pull request loaded");
    expect(markup).not.toContain("aria-activedescendant");
  });

  it("retains the related-PR surface without introducing repository-wide search semantics", () => {
    const markup = renderPrsView({
      githubSource: true,
      relatedPrs: {
        paths: ["src/a.ts"],
        results: [{ ...summary(17), matchCount: 1, matchedPaths: ["src/a.ts"] }],
        scanned: 3,
        hasMore: false,
        loading: false,
        error: null,
      },
    });

    expect(markup).toContain("PRs touching 1 files from your view");
    expect(markup).not.toContain('aria-label="Search pull requests"');
  });

  it("exposes the busy and active-descendant combobox contract for browser keyboard tests", () => {
    const markup = renderToStaticMarkup(
      <PrsFilterBar
        query="feature/search"
        onQueryChange={vi.fn()}
        onQueryKeyDown={vi.fn()}
        activeDescendant="pr-search-result-17"
        busy
        status="1 match · searching GitHub…"
        author=""
        onAuthorChange={vi.fn()}
        authors={["alice"]}
      />,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-activedescendant="pr-search-result-17"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).toContain("1 match · searching GitHub…");
  });
});

function renderPrsView(state: Partial<BlueprintState>): string {
  const store = freshStore();
  store.setState(state);
  const current = store.getState();
  Object.assign(store, { getInitialState: () => current });
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <PrsView />
    </StoreProvider>,
  );
}

function summary(number: number): PrSummary {
  return {
    number,
    title: "Search every pull request",
    body: "Renderer priority-search fixture.",
    author: "alice",
    headRef: "feature/search",
    headSha: "abc1234",
    baseRef: "main",
    updatedAt: "2026-07-24T00:00:00.000Z",
    draft: false,
    state: "open",
    url: `https://github.com/o/r/pull/${number}`,
  };
}
