import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintState } from "../../state/store";
import { StoreProvider } from "../../state/StoreContext";
import type { PrSummary } from "../../state/prTypes";
import { PrDetailPanel } from "./PrDetailPanel";

const SUMMARY: PrSummary = {
  number: 17,
  title: "Broaden review root",
  body: null,
  author: "octo",
  headRef: "feature",
  headSha: "a".repeat(40),
  baseRef: "main",
  updatedAt: "2026-07-17T00:00:00.000Z",
  draft: false,
  state: "open",
  url: "https://github.com/o/r/pull/17",
};

describe("PrDetailPanel broader-root review", () => {
  it("offers direct review preparation without exposing the removed re-extract flow", () => {
    const store = createStore<BlueprintState>(() => ({
      prSelected: SUMMARY.number,
      prsList: { open: [SUMMARY], closed: null },
      prExtraSummaries: {},
      prFiles: [],
      prDiscussion: null,
      prChecks: null,
      prFilesTruncated: false,
      prFilesTotal: 3,
      prFilesOutside: 3,
      prFilesSuggestedSubdir: "packages/web",
      prSessionSource: { repository: "o/r", subdir: "packages/api" },
      prsLoading: false,
      prsError: null,
      prReviewStatus: "idle",
      prReviewBlocked: null,
      selectPr: vi.fn(),
      reviewPrInGraph: vi.fn(),
      preparePrReviewNavigation: vi.fn(),
    } as unknown as BlueprintState));

    const markup = renderToStaticMarkup(createElement(
      StoreProvider,
      { store, children: createElement(PrDetailPanel) },
    ));

    expect(markup).toContain("Review from packages/web");
    expect(markup).not.toContain("Re-extract");
    expect(markup).not.toContain("/api/generate");
  });
});
