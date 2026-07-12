import type { PrSummary } from "./prTypes";

/**
 * The PR content identity that the current review was loaded from.
 *
 * `headSha` is the commit actually analyzed when that provenance is available;
 * otherwise it is the commit GitHub advertised when the review was loaded.
 * `updatedAt` is retained solely as a compatibility fallback for summaries that
 * do not expose a head SHA.
 */
export interface PrReviewRevision {
  readonly number: number;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string | null;
  readonly updatedAt: string;
}

/** Capture the content identity of a review at the point it is loaded. */
export function reviewRevision(summary: PrSummary, analyzedHeadSha?: string | null): PrReviewRevision {
  return {
    number: summary.number,
    headRef: summary.headRef,
    baseRef: summary.baseRef,
    // The analyzer reports what was really checked out, so prefer it over a
    // summary that may have been fetched before preparation completed.
    headSha: normalizedSha(analyzedHeadSha) ?? normalizedSha(summary.headSha),
    updatedAt: summary.updatedAt,
  };
}

/** Stable persisted identity for line-draft provenance. SHA wins; the updated timestamp is only the
 * same legacy fallback used by freshness detection when GitHub exposes no commit identity. */
export function prReviewRevisionKey(revision: PrReviewRevision | null): string | null {
  if (revision === null) {
    return null;
  }
  return JSON.stringify([
    revision.number,
    revision.headRef,
    revision.baseRef,
    normalizedSha(revision.headSha) ?? `updated:${revision.updatedAt}`,
  ]);
}

/**
 * Whether a freshly fetched PR summary identifies review contents other than
 * the ones currently loaded.
 *
 * A commit SHA is the authoritative content signal. GitHub's `updatedAt` can
 * also move for metadata and discussion activity, so it is considered only
 * when neither snapshot has a usable SHA. If just one side has a SHA there is
 * not enough evidence to call the loaded contents stale.
 */
export function isPrReviewStale(loaded: PrReviewRevision | null, latest: PrSummary): boolean {
  if (loaded === null) {
    return false;
  }

  if (
    latest.number !== loaded.number
    || latest.headRef !== loaded.headRef
    || latest.baseRef !== loaded.baseRef
  ) {
    return true;
  }

  const latestHeadSha = normalizedSha(latest.headSha);
  if (loaded.headSha !== null && latestHeadSha !== null) {
    return normalizedSha(loaded.headSha) !== latestHeadSha;
  }

  if (loaded.headSha === null && latestHeadSha === null) {
    return latest.updatedAt !== loaded.updatedAt;
  }

  return false;
}

function normalizedSha(sha: string | null | undefined): string | null {
  const normalized = sha?.trim().toLowerCase();
  return normalized ? normalized : null;
}
