/** Layout measurement primitives shared across the call-flow and logic-flow sizing paths. */

/** Clamp `value` to the inclusive `[min, max]` range. Raw min/max — the caller rounds if it wants. */
export function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}
