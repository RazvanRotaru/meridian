import {
  createPrReviewProgressSnapshot,
  PR_REVIEW_PROGRESS_MODEL,
  reducePrReviewProgress,
  type PrReviewProgressStage,
} from "@meridian/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BootProgress } from "./BootProgress";

describe("BootProgress", () => {
  it("names the exact streamed PR preparation stage", () => {
    const markup = renderToStaticMarkup(
      <BootProgress progress={{
        path: "review-analysis",
        stage: "review-checkout",
        reviewProgress: progressAt("checkout"),
      }} />,
    );

    expect(markup).toContain(PR_REVIEW_PROGRESS_MODEL.title);
    expect(markup).toContain("Fetching exact PR revisions");
    for (const step of PR_REVIEW_PROGRESS_MODEL.steps) {
      expect(markup).toContain(step.label);
    }
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-current="step"');
  });

  it("does not imply PR extraction for an ordinary graph boot", () => {
    const markup = renderToStaticMarkup(
      <BootProgress progress={{ path: "graph", stage: "index", reviewProgress: null }} />,
    );

    expect(markup).toContain("Opening blueprint");
    expect(markup).toContain("Indexing graph nodes and edges");
    expect(markup).not.toContain("Prepare exact revisions");
    expect(markup).not.toContain("Cold revisions");
  });

  it("can jump directly to artifacts after a cached analysis", () => {
    let progress = progressAt("resolve");
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "hit" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "load-artifacts" });
    const markup = renderToStaticMarkup(
      <BootProgress progress={{
        path: "review-analysis",
        stage: "review-artifacts",
        reviewProgress: progress,
      }} />,
    );

    expect(markup).toContain("Loading and indexing review graphs");
    expect(markup).not.toContain("Preparing the repository mirror");
    expect(markup).toContain('data-state="reused"');
    expect(markup).toContain('data-state="skipped"');
  });

  it("does not claim a clone while refs and persistent caches are still being checked", () => {
    const markup = renderToStaticMarkup(
      <BootProgress progress={{
        path: "review-analysis",
        stage: "review-resolve",
        reviewProgress: progressAt("resolve"),
      }} />,
    );

    expect(markup).toContain("Resolving exact PR revisions and verified cache");
    expect(markup).not.toContain("Preparing the repository mirror");
  });

  it("uses warm-safe repository preparation copy for the mirror stage", () => {
    const markup = renderToStaticMarkup(
      <BootProgress progress={{
        path: "review-analysis",
        stage: "review-clone",
        reviewProgress: null,
      }} />,
    );

    expect(markup).toContain("Preparing the repository mirror");
    expect(markup).toContain("Reusing or creating the mirror");
    expect(markup).not.toContain("Cloning");
  });

  it("names verified HEAD reuse without implying extraction", () => {
    const markup = renderToStaticMarkup(
      <BootProgress progress={{
        path: "review-analysis",
        stage: "review-reuse-head",
        reviewProgress: null,
      }} />,
    );

    expect(markup).toContain("Reusing the verified PR HEAD graph");
    expect(markup).not.toContain("Extracting the PR HEAD graph");
  });
});

function progressAt(stage: PrReviewProgressStage) {
  return reducePrReviewProgress(createPrReviewProgressSnapshot(), { type: "stage", stage });
}
