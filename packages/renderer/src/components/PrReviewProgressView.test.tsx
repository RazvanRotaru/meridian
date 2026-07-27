import {
  createPrReviewProgressSnapshot,
  PR_REVIEW_PROGRESS_MODEL,
  reducePrReviewProgress,
} from "@meridian/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrReviewProgressView } from "./PrReviewProgressView";

describe("PrReviewProgressView", () => {
  it("renders the exact canonical model and independent revision reuse states", () => {
    let progress = reducePrReviewProgress(
      createPrReviewProgressSnapshot(),
      { type: "stage", stage: "resolve" },
    );
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "hit" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "load-artifacts" });
    const markup = renderToStaticMarkup(<PrReviewProgressView progress={progress} />);

    expect(markup).toContain(`data-progress-model-version="${PR_REVIEW_PROGRESS_MODEL.version}"`);
    expect(markup).toContain(PR_REVIEW_PROGRESS_MODEL.title);
    for (const step of PR_REVIEW_PROGRESS_MODEL.steps) {
      expect(markup).toContain(step.label);
    }
    for (const revision of PR_REVIEW_PROGRESS_MODEL.revisions) {
      expect(markup).toContain(revision.label);
    }
    expect(markup).toContain('data-state="reused"');
    expect(markup).toContain('data-state="skipped"');
  });

  it("uses the canonical terminal copy with one appropriately urgent live region", () => {
    const active = reducePrReviewProgress(
      createPrReviewProgressSnapshot(),
      { type: "stage", stage: "extract-head" },
    );
    const failed = reducePrReviewProgress(active, { type: "error" });
    const canceled = reducePrReviewProgress(active, { type: "canceled" });
    const failedMarkup = renderToStaticMarkup(<PrReviewProgressView progress={failed} />);
    const canceledMarkup = renderToStaticMarkup(<PrReviewProgressView progress={canceled} />);

    expect(failedMarkup).toContain(PR_REVIEW_PROGRESS_MODEL.terminal.error);
    expect(failedMarkup.match(/role="alert"/g)).toHaveLength(1);
    expect(failedMarkup).toContain('aria-live="assertive"');
    expect(canceledMarkup).toContain(PR_REVIEW_PROGRESS_MODEL.terminal.canceled);
    expect(canceledMarkup.match(/role="status"/g)).toHaveLength(1);
    expect(canceledMarkup).toContain('aria-live="polite"');
  });

  it("keeps concurrent lanes visually active but exposes one current top-level step", () => {
    let progress = reducePrReviewProgress(
      createPrReviewProgressSnapshot(),
      { type: "stage", stage: "resolve" },
    );
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "hit" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "handoff" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "details" });
    const markup = renderToStaticMarkup(<PrReviewProgressView progress={progress} />);

    expect(progress.steps.resolve).toBe("active");
    expect(progress.steps.artifacts).toBe("active");
    expect(markup.match(/data-state="active"/g)).toHaveLength(2);
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
  });

  it("reserves stable variant-sized status slots while retaining the full running path", () => {
    const longPath = `src/${"deeply-nested/".repeat(12)}active-file.component.spec.ts`;
    const progress = reducePrReviewProgress(
      createPrReviewProgressSnapshot(),
      {
        type: "stage",
        stage: "extract-head",
        progress: {
          version: 1,
          revision: {
            kind: "head",
            commit: "a".repeat(40),
            execution: { current: 1, total: 2 },
          },
          language: "typescript",
          phase: "relationships",
          activity: "logic-flows",
          unit: { current: 2, total: 28, path: "src/app", pathTruncated: false },
          sourceFile: { current: 4479, total: 4528, path: longPath, pathTruncated: false },
        },
      },
    );

    const card = renderToStaticMarkup(<PrReviewProgressView progress={progress} />);
    const boot = renderToStaticMarkup(<PrReviewProgressView progress={progress} variant="boot" />);
    const inline = renderToStaticMarkup(<PrReviewProgressView progress={progress} variant="inline" />);

    expect(card).toContain('data-reserved-lines="7"');
    expect(card).toContain('data-reserved-rows="2"');
    expect(card).toContain("min-height:126px");
    expect(card).toContain(";height:126px");
    expect(card).toContain("min-height:32px");
    expect(card).toContain("-webkit-line-clamp:7");
    expect(boot).toContain('data-reserved-lines="5"');
    expect(boot).toContain("min-height:90px");
    expect(boot).toContain("-webkit-line-clamp:5");
    expect(inline).toContain('data-reserved-lines="2"');
    expect(inline).toContain("min-height:36px");
    expect(inline).toContain("-webkit-line-clamp:2");
    for (const markup of [card, boot, inline]) {
      expect(markup).toContain("logic flows");
      expect(markup).toContain(longPath);
      expect(markup).toContain("overflow-wrap:anywhere");
    }

    const failed = reducePrReviewProgress(progress, {
      type: "error",
      message: "A detailed terminal error must remain fully visible.",
    });
    const failedMarkup = renderToStaticMarkup(<PrReviewProgressView progress={failed} />);
    expect(failedMarkup).toContain("A detailed terminal error must remain fully visible.");
    expect(failedMarkup).not.toContain("-webkit-line-clamp");
    expect(failedMarkup).not.toContain(";height:126px");
  });
});
