import { describe, expect, it } from "vitest";
import type { PrSummary } from "./prTypes";
import { isPrReviewStale, prReviewRevisionKey, reviewRevision, type PrReviewRevision } from "./prReviewFreshness";

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 17,
    title: "Review freshness",
    body: null,
    author: "octo",
    headRef: "feature/freshness",
    headSha: "abc123def456",
    baseRef: "main",
    updatedAt: "2026-07-12T10:00:00.000Z",
    draft: false,
    state: "open",
    url: "https://github.com/o/r/pull/17",
    ...overrides,
  };
}

describe("reviewRevision", () => {
  it("captures the review-content fields from a PR summary", () => {
    expect(reviewRevision(pr())).toEqual({
      number: 17,
      headRef: "feature/freshness",
      headSha: "abc123def456",
      baseRef: "main",
      updatedAt: "2026-07-12T10:00:00.000Z",
    });
  });

  it("uses the commit actually analyzed instead of the earlier advertised head", () => {
    expect(reviewRevision(pr({ headSha: "old-head" }), "actual-analyzed-head").headSha).toBe("actual-analyzed-head");
  });

  it("falls back to the summary SHA when the analyzer has no provenance", () => {
    expect(reviewRevision(pr({ headSha: "summary-head" }), null).headSha).toBe("summary-head");
    expect(reviewRevision(pr({ headSha: "summary-head" }), "   ").headSha).toBe("summary-head");
  });

  it("normalizes SHA text and preserves honest unknown provenance", () => {
    expect(reviewRevision(pr({ headSha: "  AbC123  " })).headSha).toBe("abc123");
    expect(reviewRevision(pr({ headSha: "" })).headSha).toBeNull();
    expect(reviewRevision(pr({ headSha: null })).headSha).toBeNull();
  });
});

describe("prReviewRevisionKey", () => {
  it("uses the normalized head commit as persisted line-draft provenance", () => {
    expect(prReviewRevisionKey(reviewRevision(pr({ headSha: " ABC123 " })))).toBe(
      JSON.stringify([17, "feature/freshness", "main", "abc123"]),
    );
  });

  it("falls back to updatedAt only when the revision has no head SHA", () => {
    expect(prReviewRevisionKey(reviewRevision(pr({ headSha: null })))).toBe(
      JSON.stringify([17, "feature/freshness", "main", "updated:2026-07-12T10:00:00.000Z"]),
    );
    expect(prReviewRevisionKey(null)).toBeNull();
  });
});

describe("isPrReviewStale", () => {
  it("is false before any review revision has been loaded", () => {
    expect(isPrReviewStale(null, pr())).toBe(false);
  });

  it("detects a different head commit even when metadata did not change", () => {
    const loaded = reviewRevision(pr({ headSha: "old-head" }));

    expect(isPrReviewStale(loaded, pr({ headSha: "new-head" }))).toBe(true);
  });

  it("does not use updatedAt when the head commit is unchanged", () => {
    const loaded = reviewRevision(pr());
    const metadataOnlyUpdate = pr({
      title: "Renamed without a code push",
      body: "New description",
      updatedAt: "2026-07-12T11:00:00.000Z",
      draft: true,
    });

    expect(isPrReviewStale(loaded, metadataOnlyUpdate)).toBe(false);
  });

  it("compares normalized SHA text", () => {
    const loaded = reviewRevision(pr({ headSha: "abc123" }));

    expect(isPrReviewStale(loaded, pr({ headSha: "  ABC123  " }))).toBe(false);
  });

  it("compares against the commit actually analyzed", () => {
    const loaded = reviewRevision(pr({ headSha: "advertised-before-analysis" }), "analyzed-head");

    expect(isPrReviewStale(loaded, pr({ headSha: "analyzed-head" }))).toBe(false);
    expect(isPrReviewStale(loaded, pr({ headSha: "pushed-after-analysis" }))).toBe(true);
  });

  it("detects head-ref and base-ref changes even when the SHA is unchanged", () => {
    const loaded = reviewRevision(pr());

    expect(isPrReviewStale(loaded, pr({ headRef: "feature/renamed" }))).toBe(true);
    expect(isPrReviewStale(loaded, pr({ baseRef: "release" }))).toBe(true);
  });

  it("rejects a revision accidentally compared with another PR", () => {
    const loaded = reviewRevision(pr());

    expect(isPrReviewStale(loaded, pr({ number: 18 }))).toBe(true);
  });

  it("uses updatedAt as a legacy fallback when both head SHAs are unknown", () => {
    const loaded = reviewRevision(pr({ headSha: null }));

    expect(isPrReviewStale(loaded, pr({ headSha: null }))).toBe(false);
    expect(isPrReviewStale(loaded, pr({ headSha: null, updatedAt: "2026-07-12T11:00:00.000Z" }))).toBe(true);
  });

  it("does not infer staleness from updatedAt when only one side has SHA provenance", () => {
    const unknownLoaded = reviewRevision(pr({ headSha: null }));
    const knownLoaded = reviewRevision(pr({ headSha: "abc123" }));
    const later = "2026-07-12T11:00:00.000Z";

    expect(isPrReviewStale(unknownLoaded, pr({ headSha: "abc123", updatedAt: later }))).toBe(false);
    expect(isPrReviewStale(knownLoaded, pr({ headSha: null, updatedAt: later }))).toBe(false);
  });

  it("still detects ref changes when SHA provenance is unavailable", () => {
    const loaded: PrReviewRevision = {
      ...reviewRevision(pr({ headSha: null })),
      updatedAt: "2026-07-12T10:00:00.000Z",
    };

    expect(isPrReviewStale(loaded, pr({ headSha: null, headRef: "other-feature" }))).toBe(true);
  });
});
