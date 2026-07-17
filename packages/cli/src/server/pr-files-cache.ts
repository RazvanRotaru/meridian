/**
 * Process-local cache for GitHub PR changed-file paths.
 *
 * Related-PR discovery may retain up to 3,000 paths per PR. The cache therefore enforces both a
 * count limit and a conservative resident-byte estimate instead of allowing repository activity to
 * grow the server heap for its entire lifetime. Five complete 90-PR related scans fit within the
 * entry default, while the byte budget remains the authoritative bound for path-heavy pull requests.
 */

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

// These fixed estimates account for the Map/entry, array, and string-slot structures in addition to
// every UTF-8 byte in the key and value strings. Exact V8 object sizes are deliberately not part of
// the cache contract; the conservative accounting only needs to keep retention deterministically
// below a configured budget.
const ENTRY_OVERHEAD_BYTES = 64;
const ARRAY_OVERHEAD_BYTES = 24;
const STRING_SLOT_OVERHEAD_BYTES = 16;
const NULL_SLOT_OVERHEAD_BYTES = 8;

export interface PrFilesCacheEntry {
  readonly updatedAt: string;
  readonly headSha: string | null;
  readonly paths: readonly string[];
}

interface ResidentEntry {
  readonly value: PrFilesCacheEntry;
  readonly bytes: number;
}

/** Minimal Map-like surface used by related-PR discovery, with synchronous deterministic LRU. */
export class PrFilesCache {
  private readonly entries = new Map<string, ResidentEntry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private residentBytes = 0;

  constructor(options: { readonly maxEntries?: number; readonly maxBytes?: number } = {}) {
    this.maxEntries = positiveLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, "entry");
    this.maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, "byte");
  }

  get(key: string): PrFilesCacheEntry | undefined {
    const resident = this.entries.get(key);
    if (!resident) return undefined;
    this.entries.delete(key);
    this.entries.set(key, resident);
    return resident.value;
  }

  set(key: string, value: PrFilesCacheEntry): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.residentBytes -= previous.bytes;
    }

    const stored: PrFilesCacheEntry = {
      updatedAt: value.updatedAt,
      headSha: value.headSha,
      paths: [...value.paths],
    };
    const bytes = residentBytesFor(key, stored);
    if (bytes > this.maxBytes) return;

    this.entries.set(key, { value: stored, bytes });
    this.residentBytes += bytes;
    while (this.entries.size > this.maxEntries || this.residentBytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, ResidentEntry] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.residentBytes -= oldest[1].bytes;
    }
  }

  delete(key: string): boolean {
    const resident = this.entries.get(key);
    if (!resident) return false;
    this.entries.delete(key);
    this.residentBytes -= resident.bytes;
    return true;
  }
}

function residentBytesFor(key: string, value: PrFilesCacheEntry): number {
  let bytes = ENTRY_OVERHEAD_BYTES + ARRAY_OVERHEAD_BYTES;
  bytes += residentStringBytes(key);
  bytes += residentStringBytes(value.updatedAt);
  bytes += value.headSha === null ? NULL_SLOT_OVERHEAD_BYTES : residentStringBytes(value.headSha);
  for (const path of value.paths) bytes += residentStringBytes(path);
  return bytes;
}

function residentStringBytes(value: string): number {
  return STRING_SLOT_OVERHEAD_BYTES + Buffer.byteLength(value, "utf8");
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`PR files cache ${name} limit must be a positive safe integer`);
  }
  return resolved;
}
