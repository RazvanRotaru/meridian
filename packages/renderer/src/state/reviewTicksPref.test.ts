import { afterEach, describe, expect, it, vi } from "vitest";
import { clearReviewProgress, readReviewProgress, writeReviewProgress, type ReviewProgress } from "./reviewTicksPref";

/** A minimal in-memory localStorage double — same shape solidMetricsPref.test.ts uses, plus remove. */
function fakeWindow(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    // expose for assertions on the raw stored value
    _store: store,
  };
}

const KEY = "github.com/acme/shop|feat/x|origin/main";
const STORAGE_KEY = `meridian.review.${KEY}`;

function progress(ticks: ReviewProgress["ticks"]): ReviewProgress {
  return { version: 1, ticks };
}

afterEach(() => vi.unstubAllGlobals());

describe("reviewTicksPref", () => {
  it("defaults to an empty record when nothing is stored", () => {
    vi.stubGlobal("window", fakeWindow());
    expect(readReviewProgress(KEY)).toEqual({ version: 1, ticks: {} });
  });

  it("round-trips a written record", () => {
    vi.stubGlobal("window", fakeWindow());
    const record = progress({ "ts:a#f": { at: "2026-07-07T00:00:00.000Z", fingerprint: "deadbeef" } });
    writeReviewProgress(KEY, record);
    expect(readReviewProgress(KEY)).toEqual(record);
  });

  it("prefixes the storage key with meridian.review.", () => {
    const win = fakeWindow();
    vi.stubGlobal("window", win);
    writeReviewProgress(KEY, progress({ "ts:a#f": { at: "t", fingerprint: "00000000" } }));
    expect(win._store.has(STORAGE_KEY)).toBe(true);
  });

  it("falls back to empty on malformed JSON", () => {
    vi.stubGlobal("window", fakeWindow({ [STORAGE_KEY]: "{not json" }));
    expect(readReviewProgress(KEY)).toEqual({ version: 1, ticks: {} });
  });

  it("falls back to empty on a version mismatch", () => {
    vi.stubGlobal("window", fakeWindow({ [STORAGE_KEY]: JSON.stringify({ version: 2, ticks: { x: { at: "t", fingerprint: "f" } } }) }));
    expect(readReviewProgress(KEY)).toEqual({ version: 1, ticks: {} });
  });

  it("falls back to empty when ticks is not an object", () => {
    vi.stubGlobal("window", fakeWindow({ [STORAGE_KEY]: JSON.stringify({ version: 1, ticks: null }) }));
    expect(readReviewProgress(KEY)).toEqual({ version: 1, ticks: {} });
  });

  it("keeps (never prunes) ticks for unknown flowIds it reads back", () => {
    const stored = progress({
      "ts:known#f": { at: "t1", fingerprint: "aaaa1111" },
      "ts:gone#g": { at: "t2", fingerprint: "bbbb2222" },
    });
    vi.stubGlobal("window", fakeWindow({ [STORAGE_KEY]: JSON.stringify(stored) }));
    // Both flowIds survive the read — the pref layer does not filter to a current affected set.
    expect(readReviewProgress(KEY).ticks).toEqual(stored.ticks);
  });

  it("clear removes only its own scope", () => {
    const otherKey = "github.com/acme/shop|feat/y|origin/main";
    const win = fakeWindow({
      [STORAGE_KEY]: JSON.stringify(progress({ x: { at: "t", fingerprint: "f" } })),
      [`meridian.review.${otherKey}`]: JSON.stringify(progress({ y: { at: "t", fingerprint: "g" } })),
    });
    vi.stubGlobal("window", win);
    clearReviewProgress(KEY);
    expect(readReviewProgress(KEY)).toEqual({ version: 1, ticks: {} });
    expect(readReviewProgress(otherKey).ticks).toEqual({ y: { at: "t", fingerprint: "g" } });
  });

  it("isolates scopes so two reviewKeys never collide", () => {
    vi.stubGlobal("window", fakeWindow());
    const a = "repoA|main|origin/main";
    const b = "repoB|main|origin/main";
    writeReviewProgress(a, progress({ x: { at: "t", fingerprint: "aa" } }));
    writeReviewProgress(b, progress({ y: { at: "t", fingerprint: "bb" } }));
    expect(readReviewProgress(a).ticks).toEqual({ x: { at: "t", fingerprint: "aa" } });
    expect(readReviewProgress(b).ticks).toEqual({ y: { at: "t", fingerprint: "bb" } });
  });

  it("defaults to empty and never throws when localStorage is unavailable", () => {
    vi.stubGlobal("window", undefined);
    expect(readReviewProgress(KEY)).toEqual({ version: 1, ticks: {} });
    expect(() => writeReviewProgress(KEY, progress({}))).not.toThrow();
    expect(() => clearReviewProgress(KEY)).not.toThrow();
  });
});
