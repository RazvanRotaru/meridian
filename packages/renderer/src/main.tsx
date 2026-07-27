/**
 * Entry point. Boot is asynchronous (fetch graph + first ELK layout), so we paint a splash,
 * then swap in the app on success or a boot-error splash on failure. The boot config is read
 * from `window.__MERIDIAN__`; a missing config falls back to the bundled dev sample without
 * ever touching the production code path.
 */

import "@xyflow/react/dist/style.css";
import { createPrReviewProgressSnapshot, reducePrReviewProgress } from "@meridian/core";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { bootstrap } from "./boot/bootstrap";
import {
  readStoredPrReviewProgressHandoff,
  type BootProgressUpdate,
} from "./boot/bootProgress";
import {
  reviewRestorePrNumber,
  reviewRestoreRequested,
} from "./boot/prReviewNavigationGuard";
import { App } from "./App";
import { BootProgress } from "./components/BootProgress";
import { BootSplash } from "./components/BootSplash";

const root = createRoot(mountElement());
const restoringReview = reviewRestoreRequested(window.location.search);
const restoringPrNumber = reviewRestorePrNumber(window.location.search);
const storedReviewProgress = restoringReview ? readStoredPrReviewProgressHandoff(true) : null;
const initialProgress: BootProgressUpdate = {
  stage: "graph",
  path: restoringReview ? "review-analysis" : "graph",
  reviewProgress: storedReviewProgress ?? (restoringReview
    ? reducePrReviewProgress(createPrReviewProgressSnapshot(restoringPrNumber), {
        type: "stage",
        stage: "load-artifacts",
      })
    : null),
};
root.render(<BootProgress progress={initialProgress} />);
start(root);

async function start(target: Root): Promise<void> {
  let latestProgress = initialProgress;
  try {
    const { store, boot } = await bootstrap({
      reviewProgressHandoff: storedReviewProgress,
      onProgress(progress) {
        latestProgress = progress;
        target.render(<BootProgress progress={progress} />);
      },
    });
    target.render(
      <StrictMode>
        <App store={store} boot={boot} />
      </StrictMode>,
    );
  } catch (error) {
    if (restoringReview && latestProgress.reviewProgress !== null) {
      const reviewProgress = reducePrReviewProgress(latestProgress.reviewProgress, {
        type: "error",
        message: reviewError(error),
      });
      target.render(<BootProgress progress={{ ...latestProgress, reviewProgress }} />);
    } else {
      target.render(<BootSplash tone="error" message={describe(error)} />);
    }
  }
}

function mountElement(): HTMLElement {
  const element = document.getElementById("root");
  if (!element) {
    throw new Error("missing #root mount element");
  }
  return element;
}

function describe(error: unknown): string {
  return error instanceof Error ? `Failed to load blueprint: ${error.message}` : "Failed to load blueprint.";
}

function reviewError(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}
