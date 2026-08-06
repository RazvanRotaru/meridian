/**
 * Numeric helpers, extracted from utils/legacy.
 */

/** Constrain a number to an inclusive range. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
