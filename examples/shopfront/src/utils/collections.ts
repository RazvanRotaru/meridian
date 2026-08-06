/**
 * Small array/record helpers, extracted from utils/legacy. Pure and generic — nothing in
 * here may know about carts, products, or money.
 */

/** Sum a list of numbers. */
export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Deduplicate while preserving order. */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Bucket items by a derived string key. */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const bucket = key(item);
    (out[bucket] ??= []).push(item);
  }
  return out;
}
