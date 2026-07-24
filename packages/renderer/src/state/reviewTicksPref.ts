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
 * or unit from the affected set can't destroy the reader's progress. Versions 1/2 migrate to v3;
 * graph-URL scopes are one-way migration inputs supplied only by the live canonical PR identity.
 */

import type { PrReviewCommentSide } from "./prTypes";

const STORAGE_PREFIX = "meridian.review.";

export interface ReviewTick {
  /** ISO timestamp of the tick — display-only ("reviewed at …"). */
  at: string;
  /** Fingerprint of what was confirmed; a mismatch with the live code marks the tick stale. */
  fingerprint: string;
  /** Semantic address proven by the worker. Required for content-based unit/file carry-forward. */
  address?: string;
}

/** One draft review comment, anchored to a changed file, touched unit, or exact diff line. */
export interface ReviewComment {
  id: string;
  path: string;
  /** The touched unit the comment targets; null == a file-level comment. */
  nodeId: string | null;
  /** Explicit line selected in the code panel; null == use the file/unit heuristic. */
  line: number | null;
  /** Diff side for an explicit line. Legacy line drafts omitted this and normalize to RIGHT. */
  side: PrReviewCommentSide | null;
  /** The PR revision changed after this line was selected. Keep the draft, but disarm its inline
   * anchor so it submits as a file-level comment rather than retargeting unrelated code. */
  lineStale?: boolean;
  /** Immutable PR revision identity captured with a fresh line draft. Missing provenance on a live
   * PR is treated conservatively as stale when the draft is restored. */
  lineRevision?: string | null;
  /** Display name captured at write time, so the draft still reads if the node later vanishes. */
  anchorLabel: string | null;
  body: string;
  at: string;
}

export interface ReviewProgress {
  version: 3;
  /** Per-flow ticks, keyed by flowId (the logic-flows checklist). */
  ticks: Record<string, ReviewTick>;
  /** Per-unit ticks, keyed by nodeId (the files checklist). */
  unitTicks: Record<string, ReviewTick>;
  /** Explicit per-file viewed ticks, keyed by path (only meaningful for unit-less files). */
  fileTicks: Record<string, ReviewTick>;
  /** Draft comments not yet submitted to the PR. */
  comments: ReviewComment[];
}

/** localStorage key for an opaque review scope. */
function storageKey(reviewKey: string): string {
  return STORAGE_PREFIX + reviewKey;
}

/** A fresh empty record — returned (never a shared constant) so a caller can safely mutate it. */
function emptyProgress(): ReviewProgress {
  return { version: 3, ticks: {}, unitTicks: {}, fileTicks: {}, comments: [] };
}

/** Load this scope's progress. Missing/malformed falls back to empty; v1/v2 migrate forward. */
export function readReviewProgress(reviewKey: string, migration: { legacyKeys: readonly string[] } = { legacyKeys: [] }): ReviewProgress {
  try {
    const raw = window.localStorage.getItem(storageKey(reviewKey));
    let progress = raw === null ? emptyProgress() : coerce(JSON.parse(raw) as unknown);
    const obsolete = migration.legacyKeys.filter((key) => key !== reviewKey && window.localStorage.getItem(storageKey(key)) !== null);
    if (obsolete.length === 0) return progress;
    for (const key of obsolete) {
      const legacyRaw = window.localStorage.getItem(storageKey(key));
      if (legacyRaw !== null) progress = mergeProgress(coerce(JSON.parse(legacyRaw) as unknown), progress);
    }
    const serialized = JSON.stringify(progress);
    window.localStorage.setItem(storageKey(reviewKey), serialized);
    // Delete only after persistence was observable. A quota/private-mode failure leaves migration input intact.
    if (window.localStorage.getItem(storageKey(reviewKey)) === serialized) {
      for (const key of obsolete) window.localStorage.removeItem(storageKey(key));
    }
    return progress;
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

/** Lift v1 (flow ticks only) and v2, accept v3, reject anything else as empty. Ticks are never
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
  if (record.version !== 2 && record.version !== 3) {
    return emptyProgress();
  }
  return {
    version: 3,
    ticks: record.ticks,
    unitTicks: isTickMap(record.unitTicks) ? record.unitTicks : {},
    fileTicks: isTickMap(record.fileTicks) ? record.fileTicks : {},
    comments: Array.isArray(record.comments)
      ? record.comments.filter(isComment).map(normalizeComment)
      : [],
  };
}

function mergeProgress(older: ReviewProgress, canonical: ReviewProgress): ReviewProgress {
  const comments = new Map(older.comments.map((comment) => [comment.id, comment]));
  for (const comment of canonical.comments) comments.set(comment.id, comment);
  return {
    version: 3,
    ticks: { ...older.ticks, ...canonical.ticks },
    unitTicks: { ...older.unitTicks, ...canonical.unitTicks },
    fileTicks: { ...older.fileTicks, ...canonical.fileTicks },
    comments: [...comments.values()],
  };
}

function isTickMap(value: unknown): value is Record<string, ReviewTick> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((tick) => {
      if (typeof tick !== "object" || tick === null || Array.isArray(tick)) return false;
      const record = tick as Record<string, unknown>;
      return typeof record.at === "string"
        && typeof record.fingerprint === "string"
        && (record.address === undefined || typeof record.address === "string");
    });
}

type StoredReviewComment = Omit<ReviewComment, "line" | "side"> & {
  line?: number | null;
  side?: PrReviewCommentSide | null;
};

function normalizeComment(comment: StoredReviewComment): ReviewComment {
  const line = comment.line ?? null;
  return {
    ...comment,
    line,
    side: line === null ? null : comment.side === "LEFT" ? "LEFT" : "RIGHT",
  };
}

function isComment(value: unknown): value is StoredReviewComment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const comment = value as Record<string, unknown>;
  return (
    typeof comment.id === "string" &&
    typeof comment.path === "string" &&
    (comment.nodeId === null || typeof comment.nodeId === "string") &&
    (comment.line === undefined || comment.line === null || typeof comment.line === "number") &&
    (comment.side === undefined || comment.side === null || comment.side === "LEFT" || comment.side === "RIGHT") &&
    (comment.lineStale === undefined || typeof comment.lineStale === "boolean") &&
    (comment.lineRevision === undefined || comment.lineRevision === null || typeof comment.lineRevision === "string") &&
    (comment.anchorLabel === null || typeof comment.anchorLabel === "string") &&
    typeof comment.body === "string" &&
    comment.body.trim().length > 0 &&
    typeof comment.at === "string"
  );
}
