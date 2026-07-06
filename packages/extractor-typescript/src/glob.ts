/**
 * A minimal glob matcher for the small set of exclude patterns the extractor honors
 * (`**`, `*`, literal segments). Pulling in a glob dependency would be overkill for the
 * handful of `**​/*.test.ts`-style patterns we need.
 */

// Sentinels for the two-star tokens so the later single-star pass cannot corrupt them.
const DOUBLE_STAR_SLASH = String.fromCharCode(0);
const DOUBLE_STAR = String.fromCharCode(1);
const SINGLE_STAR = String.fromCharCode(2);

// Test files are deliberately NOT excluded: they enter the graph tagged `"test"` (see core's
// test-detection), so the renderer can hide them and coverage can be computed from them.
export const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/*.d.ts",
];

export function isExcluded(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}

function globToRegExp(glob: string): RegExp {
  const tokenized = glob
    .replace(/\*\*\//g, DOUBLE_STAR_SLASH)
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, SINGLE_STAR);
  const escaped = tokenized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(new RegExp(DOUBLE_STAR_SLASH, "g"), "(?:.*/)?")
    .replace(new RegExp(DOUBLE_STAR, "g"), ".*")
    .replace(new RegExp(SINGLE_STAR, "g"), "[^/]*");
  return new RegExp(`^${body}$`);
}
