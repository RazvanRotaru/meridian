import { describe, expect, it } from "vitest";
import { parseViewerStatusResponse, viewerStatusQuery } from "./github-pr-viewer";
import type { PrSummary } from "./github-parse";

describe("pull request viewer enrichment", () => {
  it("parses direct requests and the viewer's latest submitted review case-insensitively", () => {
    const parsed = parseViewerStatusResponse({
      data: {
        viewer: { login: "Astrid" },
        repository: {
          pr_7: {
            reviewRequests: { nodes: [{ requestedReviewer: { login: "ASTRID" } }] },
            latestReviews: { nodes: [] },
          },
          pr_8: {
            reviewRequests: { nodes: [] },
            latestReviews: { nodes: [
              { author: { login: "someone-else" }, state: "CHANGES_REQUESTED" },
              { author: { login: "astrid" }, state: "APPROVED" },
            ] },
          },
          pr_9: {
            reviewRequests: { nodes: [{ requestedReviewer: { slug: "platform-team" } }] },
            latestReviews: { nodes: [{ author: { login: "astrid" }, state: "PENDING" }] },
          },
        },
      },
    }, [7, 8, 9]);

    expect(parsed.viewerLogin).toBe("Astrid");
    expect(parsed.statuses.get(7)).toEqual({ reviewRequested: true, review: null });
    expect(parsed.statuses.get(8)).toEqual({ reviewRequested: false, review: "approved" });
    expect(parsed.statuses.get(9)).toEqual({ reviewRequested: false, review: null });
  });

  it("builds only numeric aliases for the bounded REST page", () => {
    const query = viewerStatusQuery([summary(7), summary(42)]);

    expect(query).toContain("pr_7: pullRequest(number: 7)");
    expect(query).toContain("pr_42: pullRequest(number: 42)");
    expect(query).toContain("reviewRequests(first: 100)");
    expect(query).toContain("latestReviews(first: 100)");
  });
});

function summary(number: number): PrSummary {
  return {
    number,
    title: `PR ${number}`,
    body: null,
    author: "author",
    headRef: "feature",
    headSha: null,
    baseRef: "main",
    updatedAt: "2026-07-16T10:00:00Z",
    draft: false,
    state: "open",
    url: "",
  };
}
