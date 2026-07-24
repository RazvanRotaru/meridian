import { describe, expect, it } from "vitest";
import {
  createPrReviewProgressSnapshot,
  parsePrReviewProgressSnapshot,
  PR_REVIEW_PROGRESS_MODEL,
  prReviewProgressStatusText,
  reducePrReviewProgress,
} from "./pr-review-progress";

describe("canonical PR-review progress", () => {
  it("keeps merge-base-first extraction truthful without regressing the graph step", () => {
    let progress = createPrReviewProgressSnapshot();
    for (const stage of [
      "resolve",
      "clone",
      "checkout",
      "extract",
      "extract-merge-base",
      "extract-head",
    ] as const) {
      progress = reducePrReviewProgress(progress, { type: "stage", stage });
    }

    expect(progress.steps).toEqual({
      resolve: "done",
      workspace: "done",
      graphs: "active",
      artifacts: "pending",
      projection: "pending",
    });
    expect(progress.revisions).toEqual({ head: "active", mergeBase: "done" });
    expect(prReviewProgressStatusText(progress)).toBe(
      PR_REVIEW_PROGRESS_MODEL.stages["extract-head"].label,
    );
  });

  it("does not claim extraction began at the pre-admission umbrella stage", () => {
    const progress = reducePrReviewProgress(
      reducePrReviewProgress(createPrReviewProgressSnapshot(), { type: "stage", stage: "resolve" }),
      { type: "stage", stage: "extract" },
    );

    expect(progress.steps.graphs).toBe("active");
    expect(progress.revisions).toEqual({ head: "pending", mergeBase: "pending" });
    expect(prReviewProgressStatusText(progress)).toBe("Waiting for extraction capacity…");
  });

  it("marks a verified pair hit as skipped workspace plus reused graphs", () => {
    let progress = reducePrReviewProgress(
      createPrReviewProgressSnapshot(7),
      { type: "stage", stage: "resolve" },
    );
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "hit" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "load-artifacts" });

    expect(progress.steps).toEqual({
      resolve: "done",
      workspace: "skipped",
      graphs: "reused",
      artifacts: "active",
      projection: "pending",
    });
    expect(progress.revisions).toEqual({ head: "reused", mergeBase: "reused" });
  });

  it("retains shared merge-base reuse independently from extracted HEAD", () => {
    let progress = createPrReviewProgressSnapshot();
    for (const stage of ["resolve", "clone", "checkout", "extract", "extract-head", "reuse-merge-base"] as const) {
      progress = reducePrReviewProgress(progress, { type: "stage", stage });
    }
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "miss" });

    expect(progress.steps.graphs).toBe("done");
    expect(progress.revisions).toEqual({ head: "done", mergeBase: "reused" });
  });

  it("retains shared HEAD reuse independently from extracted merge base", () => {
    let progress = createPrReviewProgressSnapshot();
    for (const stage of ["resolve", "clone", "checkout", "reuse-head", "extract", "extract-merge-base"] as const) {
      progress = reducePrReviewProgress(progress, { type: "stage", stage });
    }
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "miss" });

    expect(progress.steps.graphs).toBe("done");
    expect(progress.revisions).toEqual({ head: "reused", mergeBase: "done" });
  });

  it("renders bounded extractor telemetry and safely ignores malformed/new payloads", () => {
    const observed = reducePrReviewProgress(createPrReviewProgressSnapshot(), {
      type: "stage",
      stage: "extract-head",
      progress: {
        version: 1,
        revision: {
          kind: "head",
          commit: "abcdef0123456789abcdef0123456789abcdef01",
          execution: { current: 1, total: 2 },
        },
        language: "typescript",
        phase: "structure",
        unit: { current: 2, total: 4, path: "packages/app", pathTruncated: false },
        sourceFile: { current: 3, total: 9, path: "…/src/index.ts", pathTruncated: true },
        futureField: { safely: "retained" },
      },
    });
    expect(observed.progress).toMatchObject({ futureField: { safely: "retained" } });
    expect(prReviewProgressStatusText(observed)).toBe(
      "Extracting PR HEAD graph… PR HEAD abcdef0 · TypeScript · commit 1/2 · structure · unit 2/4 · file 3/9 · …/src/index.ts",
    );

    const malformed = reducePrReviewProgress(createPrReviewProgressSnapshot(), {
      type: "stage",
      stage: "extract-head",
      progress: { version: 2, future: true },
    });
    expect(malformed.progress).toBeNull();
    expect(prReviewProgressStatusText(malformed)).toBe("Extracting PR HEAD graph…");
  });

  it("rejects oversized extraction telemetry before retaining future fields", () => {
    const progress = reducePrReviewProgress(createPrReviewProgressSnapshot(), {
      type: "stage",
      stage: "extract-head",
      progress: {
        version: 1,
        revision: {
          kind: "head",
          commit: "abcdef0123456789abcdef0123456789abcdef01",
          execution: { current: 1, total: 1 },
        },
        language: "typescript",
        phase: "structure",
        unit: null,
        sourceFile: null,
        futureField: "x".repeat(16 * 1024),
      },
    });

    expect(progress.progress).toBeNull();
  });

  it("uses phase detail when unit progress has no single source file", () => {
    const observed = reducePrReviewProgress(createPrReviewProgressSnapshot(), {
      type: "stage",
      stage: "extract-merge-base",
      progress: {
        version: 1,
        revision: {
          kind: "merge-base",
          commit: "0123456789abcdef0123456789abcdef01234567",
          execution: { current: 2, total: 2 },
        },
        language: "python",
        phase: "relationships",
        unit: { current: 3, total: 5, path: "packages/core", pathTruncated: false },
        sourceFile: null,
      },
    });

    expect(prReviewProgressStatusText(observed)).toBe(
      "Extracting merge-base graph… merge base 0123456 · Python · commit 2/2 · relationships · unit 3/5",
    );
  });

  it("renders a bounded relationship activity with its current source file", () => {
    const observed = reducePrReviewProgress(createPrReviewProgressSnapshot(), {
      type: "stage",
      stage: "extract-head",
      progress: {
        version: 1,
        revision: {
          kind: "head",
          commit: "abcdef0123456789abcdef0123456789abcdef01",
          execution: { current: 1, total: 2 },
        },
        language: "typescript",
        phase: "relationships",
        activity: "logic-flows",
        unit: { current: 2, total: 29, path: "src/aria/app", pathTruncated: false },
        sourceFile: {
          current: 1250,
          total: 4535,
          path: "src/aria/app/assistant/index.ts",
          pathTruncated: false,
        },
      },
    });

    expect(prReviewProgressStatusText(observed)).toBe(
      "Extracting PR HEAD graph… PR HEAD abcdef0 · TypeScript · commit 1/2 · relationships"
      + " · logic flows · unit 2/29 · file 1250/4535 · src/aria/app/assistant/index.ts",
    );
  });

  it("never presents telemetry that contradicts the active stage", () => {
    const observation = {
      version: 1,
      revision: {
        kind: "merge-base",
        commit: "0123456789abcdef0123456789abcdef01234567",
        execution: { current: 1, total: 1 },
      },
      language: "typescript",
      phase: "toString",
      unit: null,
      sourceFile: null,
    };
    const waiting = reducePrReviewProgress(createPrReviewProgressSnapshot(), {
      type: "stage",
      stage: "extract",
      progress: observation,
    });
    const wrongRevision = reducePrReviewProgress(createPrReviewProgressSnapshot(), {
      type: "stage",
      stage: "extract-head",
      progress: { ...observation, phase: "structure" },
    });
    const inheritedPhase = reducePrReviewProgress(createPrReviewProgressSnapshot(), {
      type: "stage",
      stage: "extract-merge-base",
      progress: observation,
    });

    expect(prReviewProgressStatusText(waiting)).toBe("Waiting for extraction capacity…");
    expect(prReviewProgressStatusText(wrongRevision)).toBe("Extracting PR HEAD graph…");
    expect(prReviewProgressStatusText(inheritedPhase)).toBe("Extracting merge-base graph…");
  });

  it("fails closed on impossible counters, paths, and source-without-unit observations", () => {
    const base = {
      version: 1,
      revision: {
        kind: "head",
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        execution: { current: 1, total: 1 },
      },
      language: "python",
      phase: "structure",
      unit: null,
      sourceFile: {
        current: 1,
        total: 1,
        path: "src/main.py",
        pathTruncated: false,
      },
    };
    for (const malformed of [
      base,
      { ...base, activity: "logic-flows" },
      { ...base, phase: "relationships", activity: "unknown" },
      { ...base, unit: { current: 1, total: 100_001, path: ".", pathTruncated: false } },
      {
        ...base,
        unit: { current: 1, total: 1, path: ".", pathTruncated: false },
        sourceFile: { ...base.sourceFile, path: "../main.py" },
      },
      {
        ...base,
        revision: { ...base.revision, commit: base.revision.commit.toUpperCase() },
      },
    ]) {
      const snapshot = reducePrReviewProgress(createPrReviewProgressSnapshot(), {
        type: "stage",
        stage: "extract-head",
        progress: malformed,
      });
      expect(prReviewProgressStatusText(snapshot)).toBe("Extracting PR HEAD graph…");
    }
  });

  it("uses the same independent terminal states for success, error, and cancellation", () => {
    const active = reducePrReviewProgress(
      createPrReviewProgressSnapshot(),
      { type: "stage", stage: "extract-head" },
    );
    const failed = reducePrReviewProgress(active, { type: "error", message: "HEAD extraction failed." });
    const canceled = reducePrReviewProgress(active, { type: "canceled" });
    const projected = reducePrReviewProgress(
      createPrReviewProgressSnapshot(),
      { type: "stage", stage: "projection" },
    );
    const successful = reducePrReviewProgress(projected, { type: "success" });

    expect(failed.status).toBe("error");
    expect(failed.steps.graphs).toBe("error");
    expect(prReviewProgressStatusText(failed)).toBe("HEAD extraction failed.");
    expect(canceled.status).toBe("canceled");
    expect(canceled.steps.graphs).toBe("canceled");
    expect(prReviewProgressStatusText(canceled)).toBe(PR_REVIEW_PROGRESS_MODEL.terminal.canceled);
    expect(prReviewProgressStatusText(reducePrReviewProgress(active, {
      type: "error",
      message: "x".repeat(4 * 1024 + 1),
    }))).toBe(PR_REVIEW_PROGRESS_MODEL.terminal.error);
    expect(successful.status).toBe("success");
    expect(successful.steps.artifacts).toBe("skipped");
    expect(prReviewProgressStatusText(successful)).toBe(PR_REVIEW_PROGRESS_MODEL.terminal.success);
  });

  it("keeps terminal snapshots absorbing when buffered stream events arrive late", () => {
    const active = reducePrReviewProgress(
      createPrReviewProgressSnapshot(),
      { type: "stage", stage: "extract-head" },
    );
    const projected = reducePrReviewProgress(
      createPrReviewProgressSnapshot(),
      { type: "stage", stage: "projection" },
    );
    for (const terminal of [
      reducePrReviewProgress(projected, { type: "success" }),
      reducePrReviewProgress(active, { type: "error", message: "failed" }),
      reducePrReviewProgress(active, { type: "canceled" }),
    ]) {
      expect(reducePrReviewProgress(terminal, {
        type: "stage",
        stage: "extract-merge-base",
      })).toBe(terminal);
      expect(reducePrReviewProgress(terminal, {
        type: "analysis-done",
        cache: "hit",
      })).toBe(terminal);
    }
  });

  it("does not relabel already-completed cache work when a later handoff fails", () => {
    const resolved = reducePrReviewProgress(
      reducePrReviewProgress(createPrReviewProgressSnapshot(), { type: "stage", stage: "resolve" }),
      { type: "analysis-done", cache: "hit" },
    );
    const failed = reducePrReviewProgress(resolved, { type: "error", message: "artifact failed" });

    expect(failed.steps.resolve).toBe("done");
    expect(failed.steps.workspace).toBe("skipped");
    expect(failed.steps.graphs).toBe("reused");
    expect(failed.revisions).toEqual({ head: "reused", mergeBase: "reused" });
  });

  it("keeps analysis state active through landing handoff and completes only after projection", () => {
    let progress = reducePrReviewProgress(
      createPrReviewProgressSnapshot(7),
      { type: "stage", stage: "resolve" },
    );
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "hit" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "handoff" });
    const restored = parsePrReviewProgressSnapshot(JSON.parse(JSON.stringify(progress)));

    expect(restored).toEqual(progress);
    expect(progress.steps).toEqual({
      resolve: "done",
      workspace: "skipped",
      graphs: "reused",
      artifacts: "active",
      projection: "pending",
    });
    expect(reducePrReviewProgress(progress, { type: "success" })).toBe(progress);

    progress = reducePrReviewProgress(progress, { type: "stage", stage: "load-artifacts" });
    const details = reducePrReviewProgress(progress, { type: "stage", stage: "details" });
    // Boot has loaded HEAD, but live ref validation overlaps the comparison artifact fetch.
    expect(details.steps.artifacts).toBe("active");
    expect(details.steps.resolve).toBe("active");
    progress = reducePrReviewProgress(details, { type: "stage", stage: "projection" });
    progress = reducePrReviewProgress(progress, { type: "success" });
    expect(progress.status).toBe("success");
    expect(progress.steps.graphs).toBe("reused");
    expect(progress.steps.artifacts).toBe("done");
    expect(progress.steps.projection).toBe("done");
  });

  it("preserves observed cold work when destination revalidation is an immediate pair hit", () => {
    let progress = createPrReviewProgressSnapshot();
    for (const stage of [
      "resolve",
      "clone",
      "checkout",
      "extract",
      "extract-head",
      "extract-merge-base",
    ] as const) {
      progress = reducePrReviewProgress(progress, { type: "stage", stage });
    }
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "miss" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "handoff" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "load-artifacts" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "details" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "resolve" });
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "hit" });

    expect(progress.steps.workspace).toBe("done");
    expect(progress.steps.graphs).toBe("done");
    expect(progress.steps.artifacts).toBe("active");
    expect(progress.revisions).toEqual({ head: "done", mergeBase: "done" });
  });

  it("rejects incoherent or oversized persisted snapshots", () => {
    let handoff = reducePrReviewProgress(
      createPrReviewProgressSnapshot(7),
      { type: "stage", stage: "resolve" },
    );
    handoff = reducePrReviewProgress(handoff, { type: "analysis-done", cache: "hit" });
    handoff = reducePrReviewProgress(handoff, { type: "stage", stage: "handoff" });

    expect(parsePrReviewProgressSnapshot({
      ...handoff,
      steps: { ...handoff.steps, unexpected: "pending" },
    })).toBeNull();
    expect(parsePrReviewProgressSnapshot({
      ...handoff,
      steps: { ...handoff.steps, artifacts: "done" },
    })).toBeNull();
    expect(parsePrReviewProgressSnapshot({
      ...handoff,
      prNumber: null,
    })).toBeNull();
    expect(parsePrReviewProgressSnapshot({
      ...handoff,
      message: "x".repeat(4 * 1024 + 1),
    })).toBeNull();
  });

  it("round-trips one unique canonical step order as JSON", () => {
    const roundTrip = JSON.parse(JSON.stringify(PR_REVIEW_PROGRESS_MODEL)) as typeof PR_REVIEW_PROGRESS_MODEL;
    const ids = roundTrip.steps.map((step) => step.id);

    expect(roundTrip).toEqual(PR_REVIEW_PROGRESS_MODEL);
    expect(ids).toEqual(["resolve", "workspace", "graphs", "artifacts", "projection"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
