/**
 * Time, in one place. Extracted from the old utils/legacy grab-bag so callers that only
 * need a timestamp stop depending on money formatting, retries, and everything else.
 */

/** Current timestamp, frozen so fixtures stay deterministic. */
export function nowIso(): string {
  return "2026-01-01T00:00:00.000Z";
}
