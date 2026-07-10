/**
 * Persist a reader's PR-review progress across reloads, scoped per review (the CLI's `reviewKey`,
 * which is stable across pushes and rebases): the flow ticks, the per-unit ticks and per-file
 * viewed ticks of the files checklist, and the draft review comments not yet submitted. Each tick
 * stores a fingerprint of what it confirmed, so code that changed after being ticked can be
 * detected as "stale" and never silently stay green (see tickStateOf / checkStateOf).
 *
 * Mirrors solidMetricsPref: reads/writes are guarded — localStorage can be absent or throw (private
 * mode, a non-browser test env) — and default to no progress. Stored records are returned WHOLE:
 * this layer NEVER prunes ticks for unknown ids, so a transient extraction hiccup that drops a flow
 * or unit from the affected set can't destroy the reader's progress. Version 1 records (flow ticks
 * only) migrate forward losslessly.
 */

const STORAGE_PREFIX = "meridian.review.";

export interface ReviewTick {
  /** ISO timestamp of the tick — display-only ("reviewed at …"). */
  at: string;
  /** Fingerprint of what was confirmed; a mismatch with the live code marks the tick stale. */
  fingerprint: string;
}

/** One draft review comment, anchored to a changed file or to a touched unit inside it. */
export interface ReviewComment {
  id: string;
  path: string;
  /** The touched unit the comment targets; null == a file-level comment. */
  nodeId: string | null;
  /** Display name captured at write time, so the draft still reads if the node later vanishes. */
  anchorLabel: string | null;
  body: string;
  at: string;
}

export interface ReviewProgress {
  version: 2;
  /** Per-flow ticks, keyed by flowId (the logic-flows checklist). */
  ticks: Record<string, ReviewTick>;
  /** Per-unit ticks, keyed by nodeId (the files checklist). */
  unitTicks: Record<string, ReviewTick>;
  /** Explicit per-file viewed ticks, keyed by path (only meaningful for unit-less files). */
  fileTicks: Record<string, ReviewTick>;
  /** Draft comments not yet submitted to the PR. */
  comments: ReviewComment[];
}

/** localStorage key for a review scope. reviewKey is opaque (repo|branch|base) and rides through as-is. */
function storageKey(reviewKey: string): string {
  return STORAGE_PREFIX + reviewKey;
}

/** A fresh empty record — returned (never a shared constant) so a caller can safely mutate it. */
function emptyProgress(): ReviewProgress {
  return { version: 2, ticks: {}, unitTicks: {}, fileTicks: {}, comments: [] };
}

/** Load this scope's progress. Missing/malformed falls back to empty; v1 migrates forward. */
export function readReviewProgress(reviewKey: string): ReviewProgress {
  try {
    const raw = window.localStorage.getItem(storageKey(reviewKey));
    if (raw === null) {
      return emptyProgress();
    }
    return coerce(JSON.parse(raw) as unknown);
  } catch {
    return emptyProgress();
  }
}

export function writeReviewProgress(reviewKey: string, progress: ReviewProgress): void {
  try {
    window.localStorage.setItem(storageKey(reviewKey), JSON.stringify(progress));
  } catch {
    // Persistence is best-effort; a blocked localStorage just means the progress is session-only.
  }
}

/** Accept v2 verbatim, lift v1 (flow ticks only), reject anything else as empty. Ticks are never
 * pruned; a malformed COMMENT element is dropped though — one corrupt draft must not poison the
 * whole submission with an opaque 400. */
function coerce(parsed: unknown): ReviewProgress {
  if (typeof parsed !== "object" || parsed === null) {
    return emptyProgress();
  }
  const record = parsed as Record<string, unknown>;
  if (!isTickMap(record.ticks)) {
    return emptyProgress();
  }
  if (record.version === 1) {
    return { ...emptyProgress(), ticks: record.ticks };
  }
  if (record.version !== 2) {
    return emptyProgress();
  }
  return {
    version: 2,
    ticks: record.ticks,
    unitTicks: isTickMap(record.unitTicks) ? record.unitTicks : {},
    fileTicks: isTickMap(record.fileTicks) ? record.fileTicks : {},
    comments: Array.isArray(record.comments) ? record.comments.filter(isComment) : [],
  };
}

function isTickMap(value: unknown): value is Record<string, ReviewTick> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isComment(value: unknown): value is ReviewComment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const comment = value as Record<string, unknown>;
  return (
    typeof comment.id === "string" &&
    typeof comment.path === "string" &&
    (comment.nodeId === null || typeof comment.nodeId === "string") &&
    (comment.anchorLabel === null || typeof comment.anchorLabel === "string") &&
    typeof comment.body === "string" &&
    comment.body.trim().length > 0 &&
    typeof comment.at === "string"
  );
}
