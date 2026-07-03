/**
 * A reproducible clock.
 *
 * Honoring `SOURCE_DATE_EPOCH` lets a build pin `generatedAt` so the artifact (and a mock
 * overlay) are byte-stable across runs — the standard reproducible-builds convention.
 */

export function nowIso(): string {
  const epochSeconds = process.env.SOURCE_DATE_EPOCH;
  if (epochSeconds && /^\d+$/.test(epochSeconds)) {
    return new Date(Number(epochSeconds) * 1000).toISOString();
  }
  return new Date().toISOString();
}

/** `SOURCE_DATE_EPOCH` as ISO when set, else `undefined` (callers fall back to a frozen value). */
export function pinnedIsoOrUndefined(): string | undefined {
  const epochSeconds = process.env.SOURCE_DATE_EPOCH;
  if (epochSeconds && /^\d+$/.test(epochSeconds)) {
    return new Date(Number(epochSeconds) * 1000).toISOString();
  }
  return undefined;
}
