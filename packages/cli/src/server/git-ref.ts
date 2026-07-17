/**
 * Git's `check-ref-format --branch` rules. The explicit leading-dash guard keeps the value safe at
 * every argv boundary, while valid characters such as `+`, `@`, `$`, and Unicode remain available
 * to branch pickers and repository-mirror fetches.
 */

const FORBIDDEN_REF_CHARACTER = /[\x00-\x20\x7f~^:?*\[\\]/u;

export function isAllowedBranchRef(value: string): boolean {
  if (
    value.length === 0
    || value.startsWith("-")
    || value.startsWith("/")
    || value.endsWith("/")
    || value.endsWith(".")
    || value === "HEAD"
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
    || FORBIDDEN_REF_CHARACTER.test(value)
  ) {
    return false;
  }
  return value.split("/").every((component) => (
    component.length > 0
    && !component.startsWith(".")
    && !component.endsWith(".lock")
  ));
}
