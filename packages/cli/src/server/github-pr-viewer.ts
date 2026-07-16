/**
 * One bounded GraphQL read enriches a REST PR-list page with the active viewer's relationship to
 * every PR. GitHub removes a direct review request after a submitted review, so request and latest
 * review are kept separately: a re-request after new commits remains the action that wins in UI.
 */

import type { PrSummary, PrViewerReview, PrViewerStatus } from "./github-parse";
import { queryGraphql } from "./github-http";
import { WebError } from "./web-error";

const STATUS_FRAGMENT = `
fragment MeridianViewerStatus on PullRequest {
  reviewRequests(first: 100) {
    nodes {
      requestedReviewer {
        ... on User { login }
      }
    }
  }
  latestReviews(first: 100) {
    nodes {
      author { login }
      state
    }
  }
}`;

export interface ViewerEnrichment {
  prs: PrSummary[];
  viewerLogin: string;
}

export async function enrichPullRequestsForViewer(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  prs: PrSummary[],
  token: string,
): Promise<ViewerEnrichment> {
  const query = viewerStatusQuery(prs);
  const json = await queryGraphql(fetchImpl, {
    query,
    variables: { owner, repo },
  }, token);
  const parsed = parseViewerStatusResponse(json, prs.map((pr) => pr.number));
  return {
    viewerLogin: parsed.viewerLogin,
    prs: prs.map((pr) => ({ ...pr, viewerStatus: parsed.statuses.get(pr.number) ?? emptyStatus() })),
  };
}

export function viewerStatusQuery(prs: PrSummary[]): string {
  const pulls = prs
    .map((pr) => `pr_${pr.number}: pullRequest(number: ${pr.number}) { ...MeridianViewerStatus }`)
    .join("\n");
  return `
query MeridianPullRequestViewerStatus($owner: String!, $repo: String!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    ${pulls}
  }
}
${STATUS_FRAGMENT}`;
}

export function parseViewerStatusResponse(
  json: unknown,
  numbers: number[],
): { viewerLogin: string; statuses: Map<number, PrViewerStatus> } {
  const data = objectField(record(json), "data");
  const viewerLogin = stringField(objectField(data, "viewer"), "login");
  const repository = objectField(data, "repository");
  const statuses = new Map<number, PrViewerStatus>();
  for (const number of numbers) {
    const pull = objectField(repository, `pr_${number}`);
    statuses.set(number, {
      reviewRequested: requestedBy(pull, viewerLogin),
      review: latestReviewBy(pull, viewerLogin),
    });
  }
  return { viewerLogin, statuses };
}

function requestedBy(pull: Record<string, unknown>, viewerLogin: string): boolean {
  return nodes(objectField(pull, "reviewRequests")).some((node) => {
    const reviewer = nullableRecord(node.requestedReviewer);
    return reviewer !== null && sameLogin(reviewer.login, viewerLogin);
  });
}

function latestReviewBy(pull: Record<string, unknown>, viewerLogin: string): PrViewerReview | null {
  for (const node of nodes(objectField(pull, "latestReviews"))) {
    const author = nullableRecord(node.author);
    if (author !== null && sameLogin(author.login, viewerLogin)) {
      return reviewState(node.state);
    }
  }
  return null;
}

function nodes(connection: Record<string, unknown>): Record<string, unknown>[] {
  const value = connection.nodes;
  return Array.isArray(value) ? value.map(record) : [];
}

function reviewState(value: unknown): PrViewerReview | null {
  if (value === "APPROVED") return "approved";
  if (value === "CHANGES_REQUESTED") return "changes_requested";
  if (value === "COMMENTED") return "commented";
  if (value === "DISMISSED") return "dismissed";
  return null;
}

function emptyStatus(): PrViewerStatus {
  return { reviewRequested: false, review: null };
}

function sameLogin(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

function objectField(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  return record(parent[key]);
}

function stringField(parent: Record<string, unknown>, key: string): string {
  const value = parent[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new WebError(502, `GitHub response missing '${key}'`);
  }
  return value;
}

function nullableRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function record(value: unknown): Record<string, unknown> {
  const parsed = nullableRecord(value);
  if (parsed === null) {
    throw new WebError(502, "GitHub returned an unexpected personalized pull request response");
  }
  return parsed;
}
