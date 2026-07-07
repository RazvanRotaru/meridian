/**
 * Persist which review FLOWS the reader has ticked off, keyed by (artifact target identity, review
 * scope). Mirrors `solidMetricsPref`'s guarded, best-effort localStorage pattern; adds a small LRU so
 * a busy reviewer's history can't grow without bound. Values are JSON; every access is wrapped
 * because localStorage can be absent or throw (private mode, a non-browser test env). No React.
 */

const KEY_PREFIX = "meridian.review.v1:";
const INDEX_KEY = "meridian.review.v1.index";
const MAX_SESSIONS = 20;

export interface ReviewedRecord {
  /** Flow root node id -> ISO date it was reviewed. */
  reviewed: Record<string, string>;
  /** The affected file list this scope was computed from. */
  files: string[];
  updatedAt?: string;
}

/** FNV-1a 32-bit hash as 8 lowercase hex chars — a stable, dependency-free digest for key parts. */
export function fnv1a32hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The storage key for one (artifact target identity, review scope) pair. */
export function reviewKey(artifactTargetIdentity: string, scopeRef: string): string {
  return `${KEY_PREFIX}${fnv1a32hex(artifactTargetIdentity)}:${scopeRef}`;
}

export function loadReviewed(key: string): ReviewedRecord | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ReviewedRecord) : null;
  } catch {
    return null;
  }
}

export function saveReviewed(key: string, value: ReviewedRecord): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    touch(key);
  } catch {
    // Persistence is best-effort; a blocked localStorage just means ticks are session-only.
  }
}

/** Move `key` to the most-recent slot and evict the oldest sessions beyond the cap. */
function touch(key: string): void {
  const order = readIndex().filter((entry) => entry !== key);
  order.push(key);
  while (order.length > MAX_SESSIONS) {
    const oldest = order.shift();
    if (oldest) {
      window.localStorage.removeItem(oldest);
    }
  }
  window.localStorage.setItem(INDEX_KEY, JSON.stringify(order));
}

function readIndex(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
