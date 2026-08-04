/**
 * Canonical protocol order for strings.
 *
 * JavaScript's relational comparison is a locale-independent lexicographic comparison of UTF-16
 * code units. Use this at every cross-process ordering boundary instead of `localeCompare`; the
 * latter varies by host locale, and Python's native Unicode-code-point order differs for astral
 * characters. Producers may emit any unique bounded order, but TypeScript protocol owners
 * canonicalize with this comparator before validating or forwarding data.
 */
export function compareBinaryStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True only for a duplicate-free sequence already in canonical binary string order. */
export function isStrictlyBinarySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareBinaryStrings(values[index - 1]!, value) < 0);
}
