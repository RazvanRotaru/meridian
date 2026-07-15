/**
 * A small, byte-aware cache for decoded view projections.
 *
 * The projection currently rendered is deliberately kept outside the LRU budget: evicting it would
 * invalidate the live view. When another projection becomes active, the old one may enter the
 * recent-view LRU so back/forward navigation stays fast. Recent entries are bounded independently
 * by their count and by a caller-supplied conservative estimate of their resident heap bytes.
 */

export interface RecentViewProjectionCacheLimits {
  /** Maximum number of inactive decoded projections retained for back/forward navigation. */
  maxRecentEntries: number;
  /** Maximum sum of inactive projections' estimated resident heap bytes. */
  maxRecentBytes: number;
}

interface ProjectionEntry<Key, Projection> {
  key: Key;
  projection: Projection;
  residentBytes: number;
}

export class RecentViewProjectionCache<Key, Projection> {
  private readonly maxRecentEntries: number;
  private readonly maxRecentBytes: number;
  private activeEntry: ProjectionEntry<Key, Projection> | undefined;
  /** Map insertion order is least-recently-used to most-recently-used. */
  private readonly recentEntries = new Map<Key, ProjectionEntry<Key, Projection>>();
  private recentResidentBytes = 0;

  constructor(limits: RecentViewProjectionCacheLimits) {
    this.maxRecentEntries = nonNegativeSafeInteger(limits.maxRecentEntries, "maxRecentEntries");
    this.maxRecentBytes = nonNegativeSafeInteger(limits.maxRecentBytes, "maxRecentBytes");
  }

  /** The key of the projection currently rendered, if one has been installed. */
  get activeKey(): Key | undefined {
    return this.activeEntry?.key;
  }

  /** The projection currently rendered. It is never charged to, or evicted by, recent-view limits. */
  get active(): Projection | undefined {
    return this.activeEntry?.projection;
  }

  /** Caller-estimated resident heap bytes currently charged to the inactive recent-view LRU. */
  get recentResidentByteLength(): number {
    return this.recentResidentBytes;
  }

  /** Number of inactive decoded projections currently retained. */
  get recentEntryCount(): number {
    return this.recentEntries.size;
  }

  /** Whether a projection is either active or retained in the recent-view LRU. */
  has(key: Key): boolean {
    return this.isActive(key) || this.recentEntries.has(key);
  }

  /** Inspect an entry without changing active state or LRU recency. */
  peek(key: Key): Projection | undefined {
    return this.isActive(key) ? this.activeEntry?.projection : this.recentEntries.get(key)?.projection;
  }

  /**
   * Read a decoded projection without changing which view is active. A recent hit is promoted to
   * the most-recently-used end of the LRU, so a navigation preflight counts as real reuse.
   */
  get(key: Key): Projection | undefined {
    if (this.isActive(key)) {
      return this.activeEntry?.projection;
    }
    const entry = this.removeRecent(key);
    if (entry === undefined) {
      return undefined;
    }
    this.addRecent(entry);
    return entry.projection;
  }

  /**
   * Make an already decoded projection the active view. A recent hit is removed from the budget;
   * the previously active view is offered to the LRU and may be skipped or evicted by its limits.
   */
  activate(key: Key): Projection | undefined {
    if (this.isActive(key)) {
      return this.activeEntry?.projection;
    }
    const next = this.removeRecent(key);
    if (next === undefined) {
      return undefined;
    }
    const previous = this.activeEntry;
    this.activeEntry = next;
    if (previous !== undefined) {
      this.addRecent(previous);
    }
    return next.projection;
  }

  /**
   * Install a freshly decoded response as the active projection. `residentBytes` is an explicit,
   * conservative heap estimate supplied by the decoder (for example response bytes multiplied by
   * an empirically chosen expansion factor that includes the decoded projection and its indexes).
   */
  setActive(key: Key, projection: Projection, residentBytes: number): void {
    const entry: ProjectionEntry<Key, Projection> = {
      key,
      projection,
      residentBytes: nonNegativeSafeInteger(residentBytes, "residentBytes"),
    };
    const replacingActive = this.isActive(key);
    this.removeRecent(key);
    if (!replacingActive && this.activeEntry !== undefined) {
      this.addRecent(this.activeEntry);
    }
    this.activeEntry = entry;
  }

  /** Release the active projection and every decoded recent view. */
  clear(): void {
    this.activeEntry = undefined;
    this.recentEntries.clear();
    this.recentResidentBytes = 0;
  }

  private isActive(key: Key): boolean {
    return this.activeEntry !== undefined && sameValueZero(this.activeEntry.key, key);
  }

  private addRecent(entry: ProjectionEntry<Key, Projection>): void {
    // An over-budget entry is useful while active but must never make the inactive cache unbounded.
    if (this.maxRecentEntries === 0 || entry.residentBytes > this.maxRecentBytes) {
      return;
    }
    const replaced = this.removeRecent(entry.key);
    // `replaced` is intentionally discarded: the newly used decode is the authoritative one.
    void replaced;
    this.recentEntries.set(entry.key, entry);
    this.recentResidentBytes += entry.residentBytes;
    this.evictToLimits();
  }

  private removeRecent(key: Key): ProjectionEntry<Key, Projection> | undefined {
    const entry = this.recentEntries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.recentEntries.delete(key);
    this.recentResidentBytes -= entry.residentBytes;
    return entry;
  }

  private evictToLimits(): void {
    while (this.recentEntries.size > this.maxRecentEntries || this.recentResidentBytes > this.maxRecentBytes) {
      const oldest = this.recentEntries.keys().next();
      if (oldest.done) {
        // The map is empty, so exact accounting must also be empty. Keep this defensive branch from
        // turning an accounting bug into an infinite loop in production.
        this.recentResidentBytes = 0;
        return;
      }
      this.removeRecent(oldest.value);
    }
  }
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

/** Map keys use SameValueZero equality, including treating NaN as the same key as NaN. */
function sameValueZero<Key>(left: Key, right: Key): boolean {
  return left === right || (left !== left && right !== right);
}
